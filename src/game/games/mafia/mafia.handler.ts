import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { MafiaGameOver, MafiaRole, MafiaState, Room } from '../../game.types';
import { GameContext } from '../../game.context';
import { DatabaseService } from '../../../database/database.service';

/**
 * 마피아 게임 핸들러
 *
 * 4~8명. 역할: 마피아(4~5명이면 1, 6~8명이면 2), 경찰 1, 의사 1, 나머지 시민. 역할은 죽어도 공개하지 않고 게임이 끝날 때 공개.
 * 역할 확인(10초) → 밤(30초, 할 일이 끝나도 최소 10초) → 낮(토론·투표) → 밤 … 을 승부가 날 때까지.
 *   - 밤: 마피아끼리 비밀 채팅·죽일 사람 지목(여럿이면 가장 많이 고른 사람, 같으면 먼저 고른 사람),
 *         경찰은 한 명 조사(결과는 경찰에게만 바로), 의사는 한 명 살리기(자기 자신도 언제나 가능).
 *         살아 있는 사람이 할 일을 다 하면 바로 끝난다
 *   - 낮: 밤 결과 발표 후 자유 토론하며 투표(바꿀 수 있음). 시간이 끝나거나 살아 있는 사람이 모두 투표하면
 *         가장 많이 받은 한 명 처형, 동점·무투표면 아무도 처형하지 않음
 *   - 승리: 마피아가 다 죽으면 시민, 살아 있는 마피아 수가 나머지 이상이면 마피아
 * 채팅: 낮에는 산 사람이 모두에게, 밤에는 마피아끼리만(나머지 산 사람은 말할 수 없음),
 *       죽은 사람은 언제나 죽은 사람끼리만. 죽은 사람은 모든 공개 채팅을 본다
 *
 * 이벤트 (클라이언트 → 서버):
 *   mafiaStart  {roomName, discussTimeSec}  방장 전용
 *   mafiaText   {roomName, text, whisper?}  whisper: 밤에 마피아끼리 쓰던 말 (낮이 됐으면 공개하지 않고 버린다)
 *   mafiaAction {roomName, targetId|null}   밤 행동(역할에 따라 지목·조사·살리기) / 낮 투표
 *
 * 이벤트 (서버 → 클라이언트):
 *   mafiaStarted   설정·참가자
 *   mafiaRole      개인: 내 역할, 마피아면 동료
 *   mafiaNight     밤 시작 (day, timeLimitMs)
 *   mafiaKillUpdate  마피아끼리: 누가 누구를 골랐는지
 *   mafiaInvestigated 경찰에게만: {targetId, isMafia}
 *   mafiaDay       낮 시작 (day, killedId|null, timeLimitMs)
 *   mafiaVoteUpdate 투표한 사람 목록
 *   mafiaExecuted  처형 결과 (executedId|null, tally)
 *   mafiaChat      {playerId, nickname, text, scope: 'all'|'mafia'|'dead'}
 *   mafiaSilent    보낸 사람에게만: 지금은 말할 수 없음
 *   mafiaWhisperLate 보낸 사람에게만: 밤이 끝나 마피아끼리 하려던 말을 보내지 않음
 *   mafiaPresence  연결 끊김/복귀
 *   mafiaGameOver  승부·모든 역할
 */
@Injectable()
export class MafiaHandler {
  static readonly MIN_PLAYERS = 4;
  static readonly MAX_PLAYERS = 8;
  static readonly ALLOWED_DISCUSS_TIMES = [90, 120, 180];
  static readonly ROLE_TIME_MS = 10_000;
  static readonly NIGHT_TIME_MS = 30_000;
  /** 할 일이 다 끝나도 밤은 이만큼은 간다 — 봇이 몇 초 만에 다 고르면 밤이 지나간 줄도 몰랐다 */
  static readonly MIN_NIGHT_MS = 10_000;
  /** 처형 결과를 보여 준 뒤 밤이 되기까지 */
  static readonly EXECUTION_SHOW_MS = 8_000;
  static readonly MAX_TEXT_LENGTH = 100;

  constructor(
    private readonly ctx: GameContext,
    private readonly supabase: DatabaseService,
  ) {}

  static mafiaCount(players: number): number {
    return players >= 6 ? 2 : 1;
  }

  /** 의사는 6명부터 (4~5명은 마피아 1명이라 의사까지 있으면 마피아가 너무 불리하다) */
  static doctorCount(players: number): number {
    return players >= 6 ? 1 : 0;
  }

  // ── 시작 ─────────────────────────────────────────────────

  async handleStart(
    data: { roomName: string; discussTimeSec: number },
    client: WebSocket,
  ): Promise<void> {
    const { roomName, discussTimeSec } = data;
    const room = this.ctx.rooms.get(roomName);
    const fail = (message: string) =>
      this.ctx.sendToClient(client, 'error', { message });
    if (!room || !room.clients.has(client))
      return fail(`'${roomName}' 방에 참여하고 있지 않습니다`);
    const playerId = room.playerIds.get(client);
    if (playerId !== room.hostPlayerId)
      return fail('방장만 게임을 시작할 수 있습니다');
    if (room.gameStarted) return fail('이미 게임이 시작되었습니다');
    if (!MafiaHandler.ALLOWED_DISCUSS_TIMES.includes(discussTimeSec))
      return fail('허용되지 않은 설정입니다');
    const adminBypass = playerId
      ? await this.supabase.isAdmin(playerId)
      : false;
    if (!adminBypass && room.clients.size < MafiaHandler.MIN_PLAYERS)
      return fail(`마피아는 최소 ${MafiaHandler.MIN_PLAYERS}명이 필요합니다`);
    if (room.gameStarted) return;

    const players = this.ctx.getPlayersWithOrder(room);
    // 입장 순서. 역할은 섞은 순서로 정하되, 목록(roles·alive)은 입장 순서로 담는다 —
    // 섞은 순서 그대로 담으면 모두에게 보내는 참가자·생존자 목록의 앞쪽이 마피아→경찰→의사가 되어 역할이 드러났다
    const ids = players.map((p) => p.playerId);
    const mafiaCount = MafiaHandler.mafiaCount(ids.length);
    const roleOf = new Map<string, MafiaRole>(
      shuffle([...ids]).map((id, i) => [
        id,
        i < mafiaCount
          ? 'mafia'
          : i === mafiaCount
            ? 'police'
            : i === mafiaCount + 1 && MafiaHandler.doctorCount(ids.length) > 0
              ? 'doctor'
              : 'citizen',
      ]),
    );
    const roles = new Map<string, MafiaRole>(
      ids.map((id) => [id, roleOf.get(id)!]),
    );

    room.gameStarted = true;
    room.gameFinished = false;
    room.mafiaGameOverResult = undefined;
    room.sessionStartedAt = Date.now();
    room.mafia = {
      discussTimeSec,
      minPlayers: adminBypass ? 1 : MafiaHandler.MIN_PLAYERS,
      day: 1,
      phase: 'role',
      roles,
      alive: new Set(ids),
      nicknames: new Map(players.map((p) => [p.playerId, p.nickname])),
      kills: new Map(),
      investigated: null,
      healed: null,
      policeLog: [],
      votes: new Map(),
      lastNight: null,
      lastExecution: null,
      phaseEndsAt: Date.now() + MafiaHandler.ROLE_TIME_MS,
    };
    const m = room.mafia;
    this.createDbSession(room, players);

    this.ctx.broadcastToRoom(roomName, 'mafiaStarted', {
      roomName,
      discussTimeSec,
      mafiaCount,
      players: players.map((p) => p.playerId),
    });
    for (const [c, pid] of room.playerIds) {
      this.ctx.sendToClient(c, 'mafiaRole', {
        roomName,
        role: roles.get(pid),
        mafiaTeam: roles.get(pid) === 'mafia' ? this.team(m) : [],
        timeLimitMs: MafiaHandler.ROLE_TIME_MS,
      });
    }
    console.log(
      `[Mafia] '${roomName}' started | ${ids.length}명 | 마피아 ${mafiaCount}`,
    );
    m.timer = setTimeout(() => {
      if (room.mafia === m) this.startNight(room);
    }, MafiaHandler.ROLE_TIME_MS);
  }

  private team(m: MafiaState): string[] {
    return [...m.roles].filter(([, r]) => r === 'mafia').map(([id]) => id);
  }

  private aliveIn(room: Room, m: MafiaState): string[] {
    const inRoom = new Set(room.playerIds.values());
    return [...m.alive].filter((id) => inRoom.has(id));
  }

  /** 이 역할로 살아 있고 방에 있는 사람들 */
  private aliveWith(room: Room, m: MafiaState, role: MafiaRole): string[] {
    return this.aliveIn(room, m).filter((id) => m.roles.get(id) === role);
  }

  // ── 밤 ───────────────────────────────────────────────────

  private startNight(room: Room): void {
    const m = room.mafia!;
    this.clearTimer(m);
    m.phase = 'night';
    m.kills = new Map();
    m.investigated = null;
    m.healed = null;
    m.votes = new Map();
    m.nightStartedAt = Date.now();
    m.phaseEndsAt = Date.now() + MafiaHandler.NIGHT_TIME_MS;
    this.ctx.broadcastToRoom(room.name, 'mafiaNight', {
      roomName: room.name,
      day: m.day,
      timeLimitMs: MafiaHandler.NIGHT_TIME_MS,
    });
    m.timer = setTimeout(() => {
      if (room.mafia === m && m.phase === 'night') this.endNight(room);
    }, MafiaHandler.NIGHT_TIME_MS);
  }

  /** 밤에 할 일이 있는 사람(마피아·경찰·의사, 살아 있고 접속 중)이 다 했는지 */
  private nightDone(room: Room, m: MafiaState): boolean {
    const active = (id: string) => !room.disconnectTimers.has(id);
    const mafias = this.aliveWith(room, m, 'mafia').filter(active);
    const police = this.aliveWith(room, m, 'police').filter(active);
    const doctor = this.aliveWith(room, m, 'doctor').filter(active);
    return (
      mafias.every((id) => m.kills.has(id)) &&
      (police.length === 0 || m.investigated !== null) &&
      (doctor.length === 0 || m.healed !== null)
    );
  }

  /** 할 일이 다 끝났으면 밤을 끝낸다. 단 최소 시간이 안 지났으면 그때까지 기다린다 */
  private maybeEndNight(room: Room): void {
    const m = room.mafia!;
    if (m.phase !== 'night' || !this.nightDone(room, m)) return;
    const wait =
      (m.nightStartedAt ?? 0) + MafiaHandler.MIN_NIGHT_MS - Date.now();
    if (wait <= 0) {
      this.endNight(room);
      return;
    }
    this.clearTimer(m);
    m.phaseEndsAt = Date.now() + wait;
    m.timer = setTimeout(() => {
      if (room.mafia === m && m.phase === 'night') this.endNight(room);
    }, wait);
  }

  private endNight(room: Room): void {
    const m = room.mafia!;
    if (m.phase !== 'night') return;
    this.clearTimer(m);
    // 마피아 지목: 가장 많이 고른 사람, 같으면 먼저 고른 사람
    const counts = new Map<string, number>();
    for (const target of m.kills.values())
      counts.set(target, (counts.get(target) ?? 0) + 1);
    let target: string | null = null;
    let best = 0;
    for (const t of m.kills.values()) {
      const c = counts.get(t)!;
      if (c > best) {
        best = c;
        target = t;
      }
    }
    const killedId =
      target && target !== m.healed && m.alive.has(target) ? target : null;
    if (killedId) m.alive.delete(killedId);
    m.lastNight = { killedId, day: m.day };
    if (this.checkWin(room)) return;
    this.startDay(room, killedId);
  }

  // ── 낮 ───────────────────────────────────────────────────

  private startDay(room: Room, killedId: string | null): void {
    const m = room.mafia!;
    m.phase = 'day';
    m.votes = new Map();
    const ms = m.discussTimeSec * 1000;
    m.phaseEndsAt = Date.now() + ms;
    this.ctx.broadcastToRoom(room.name, 'mafiaDay', {
      roomName: room.name,
      day: m.day,
      killedId,
      killedNickname: killedId ? (m.nicknames.get(killedId) ?? '') : null,
      alive: [...m.alive],
      timeLimitMs: ms,
    });
    m.timer = setTimeout(() => {
      if (room.mafia === m && m.phase === 'day') this.tally(room);
    }, ms);
  }

  private tally(room: Room): void {
    const m = room.mafia!;
    if (m.phase !== 'day') return;
    this.clearTimer(m);
    const tally: Record<string, number> = {};
    const alive = new Set(this.aliveIn(room, m));
    for (const [voter, target] of m.votes)
      if (alive.has(voter) && alive.has(target))
        tally[target] = (tally[target] ?? 0) + 1;
    const max = Math.max(0, ...Object.values(tally));
    const top = Object.keys(tally).filter((id) => tally[id] === max);
    const executedId = max > 0 && top.length === 1 ? top[0] : null;
    if (executedId) m.alive.delete(executedId);
    m.lastExecution = { executedId, day: m.day, tally };
    this.ctx.broadcastToRoom(room.name, 'mafiaExecuted', {
      roomName: room.name,
      day: m.day,
      executedId,
      executedNickname: executedId ? (m.nicknames.get(executedId) ?? '') : null,
      tally,
      alive: [...m.alive],
      timeLimitMs: MafiaHandler.EXECUTION_SHOW_MS,
    });
    if (this.checkWin(room)) return;
    m.phaseEndsAt = Date.now() + MafiaHandler.EXECUTION_SHOW_MS;
    m.timer = setTimeout(() => {
      if (room.mafia !== m) return;
      m.day++;
      this.startNight(room);
    }, MafiaHandler.EXECUTION_SHOW_MS);
  }

  // ── 행동 (밤 지목·조사·살리기 / 낮 투표) ──────────────────

  handleAction(
    data: { roomName: string; targetId: unknown },
    client: WebSocket,
  ): void {
    const room = this.ctx.rooms.get(data.roomName);
    const m = room?.mafia;
    if (!room || !m) return;
    const me = room.playerIds.get(client);
    if (!me || !m.alive.has(me)) return;
    const alive = new Set(this.aliveIn(room, m));
    const target = typeof data.targetId === 'string' ? data.targetId : null;
    if (target !== null && !alive.has(target)) return;
    const role = m.roles.get(me);

    if (m.phase === 'day') {
      if (target === me) return;
      if (target === null) m.votes.delete(me);
      else m.votes.set(me, target);
      this.ctx.broadcastToRoom(room.name, 'mafiaVoteUpdate', {
        roomName: room.name,
        voted: [...m.votes.keys()],
      });
      const voters = [...alive].filter((id) => !room.disconnectTimers.has(id));
      if (voters.length > 1 && voters.every((id) => m.votes.has(id)))
        this.tally(room);
      return;
    }

    if (m.phase !== 'night' || target === null) return;
    if (role === 'mafia') {
      if (m.roles.get(target) === 'mafia') return; // 동료는 고를 수 없다
      m.kills.set(me, target);
      for (const id of this.aliveWith(room, m, 'mafia')) {
        const c = this.ctx.findClientByPlayerId(room, id);
        if (c)
          this.ctx.sendToClient(c, 'mafiaKillUpdate', {
            roomName: room.name,
            kills: Object.fromEntries(m.kills),
          });
      }
    } else if (role === 'police') {
      if (m.investigated !== null || target === me) return; // 하룻밤에 한 번
      m.investigated = target;
      const isMafia = m.roles.get(target) === 'mafia';
      m.policeLog.push({ targetId: target, isMafia, day: m.day });
      this.ctx.sendToClient(client, 'mafiaInvestigated', {
        roomName: room.name,
        targetId: target,
        nickname: m.nicknames.get(target) ?? '',
        isMafia,
      });
    } else if (role === 'doctor') {
      m.healed = target; // 자기 자신도 언제나 가능, 밤 동안 바꿀 수 있다
    } else {
      return;
    }
    this.maybeEndNight(room);
  }

  // ── 채팅 ─────────────────────────────────────────────────

  handleText(
    data: { roomName: string; text: unknown; whisper?: unknown },
    client: WebSocket,
  ): void {
    const room = this.ctx.rooms.get(data.roomName);
    if (!room || !room.clients.has(client)) return;
    const me = room.playerIds.get(client);
    if (!me) return;
    const m0 = room.mafia;
    // 밤에 마피아끼리 쓰던 말이 낮이 된 뒤에 도착하면 모두에게 공개되어 마피아가 들통난다 — 버린다
    if (
      data.whisper === true &&
      !(
        m0?.phase === 'night' &&
        m0.alive.has(me) &&
        m0.roles.get(me) === 'mafia'
      )
    ) {
      this.ctx.sendToClient(client, 'mafiaWhisperLate', {
        roomName: room.name,
      });
      return;
    }
    const text = (typeof data.text === 'string' ? data.text : '')
      .trim()
      .slice(0, MafiaHandler.MAX_TEXT_LENGTH);
    if (!text) return;
    const msg = {
      roomName: room.name,
      playerId: me,
      nickname: room.nicknames.get(client) ?? '',
      text,
    };
    const m = room.mafia;
    if (!m || !m.roles.has(me)) {
      // 시작 전·끝난 뒤, 또는 중간에 들어와 역할이 없는 사람
      this.ctx.broadcastToRoom(room.name, 'mafiaChat', {
        ...msg,
        scope: 'all',
      });
      return;
    }
    const sendTo = (ids: (id: string) => boolean, scope: string) => {
      for (const [c, pid] of room.playerIds)
        if (ids(pid)) this.ctx.sendToClient(c, 'mafiaChat', { ...msg, scope });
    };
    const dead = (pid: string) => m.roles.has(pid) && !m.alive.has(pid);
    if (!m.alive.has(me)) {
      sendTo(dead, 'dead');
      return;
    }
    if (m.phase === 'night') {
      if (m.roles.get(me) !== 'mafia') {
        this.ctx.sendToClient(client, 'mafiaSilent', { roomName: room.name });
        return;
      }
      // 마피아 채팅은 마피아끼리만 (죽은 마피아 포함 — 죽으면 어차피 dead 쪽으로 간다)
      sendTo(
        (pid) => m.roles.get(pid) === 'mafia' && m.alive.has(pid),
        'mafia',
      );
      return;
    }
    // 낮(역할 확인 시간 포함): 모두에게. 죽은 사람도 본다
    this.ctx.broadcastToRoom(room.name, 'mafiaChat', { ...msg, scope: 'all' });
  }

  // ── 승패 ─────────────────────────────────────────────────

  private checkWin(room: Room): boolean {
    const m = room.mafia!;
    const alive = this.aliveIn(room, m);
    const mafias = alive.filter((id) => m.roles.get(id) === 'mafia').length;
    const others = alive.length - mafias;
    if (mafias === 0) {
      this.finishGame(room, 'citizens');
      return true;
    }
    if (mafias >= others) {
      this.finishGame(room, 'mafia');
      return true;
    }
    return false;
  }

  private finishGame(room: Room, winner: MafiaGameOver['winner']): void {
    const m = room.mafia;
    if (!m) return;
    this.clearTimer(m);
    const result: MafiaGameOver = {
      winner,
      roles: Object.fromEntries(m.roles),
      nicknames: Object.fromEntries(m.nicknames),
      alive: [...m.alive],
      day: m.day,
    };
    room.mafiaGameOverResult = result;
    room.mafia = undefined;
    room.gameStarted = false;
    room.gameFinished = true;
    this.ctx.broadcastToRoom(room.name, 'mafiaGameOver', {
      roomName: room.name,
      ...result,
    });
    console.log(`[Mafia] '${room.name}' finished: ${winner} (day ${m.day})`);

    if (room.supabaseSessionId) {
      const sessionId = room.supabaseSessionId;
      room.supabaseSessionId = undefined;
      const durationSec = room.sessionStartedAt
        ? Math.floor((Date.now() - room.sessionStartedAt) / 1000)
        : 0;
      this.supabase.updateSessionDuration(sessionId, durationSec);
      for (const [pid, role] of m.roles) {
        const won =
          winner === 'mafia'
            ? role === 'mafia'
            : winner === 'citizens'
              ? role !== 'mafia'
              : false;
        this.supabase.finalizePlayerResult({
          sessionId,
          userId: pid,
          isWinner: won,
          score: won ? 1 : 0,
          rank: won ? 1 : 2,
          playTimeSec: durationSec,
          extra: { role, winner, day: m.day },
        });
      }
    }
  }

  // ── 연결 끊김 / 이탈 ─────────────────────────────────────

  handleDisconnect(room: Room, playerId: string): void {
    const m = room.mafia;
    if (!m) return;
    this.ctx.broadcastToRoom(room.name, 'mafiaPresence', {
      roomName: room.name,
      playerId,
      connected: false,
    });
    // 끊긴 사람을 기다리지 않는다
    if (m.phase === 'night') this.maybeEndNight(room);
    if (m.phase === 'day') {
      const voters = this.aliveIn(room, m).filter(
        (id) => !room.disconnectTimers.has(id),
      );
      if (voters.length > 1 && voters.every((id) => m.votes.has(id)))
        this.tally(room);
    }
  }

  handleReconnect(room: Room, playerId: string): void {
    if (!room.mafia) return;
    this.ctx.broadcastToRoom(room.name, 'mafiaPresence', {
      roomName: room.name,
      playerId,
      connected: true,
    });
  }

  /** 나간 사람은 죽은 것으로 친다 (역할은 공개하지 않음) */
  handlePlayerLeft(room: Room, playerId: string): void {
    const m = room.mafia;
    if (!m) return;
    if (room.clients.size === 0) {
      this.clearTimer(m);
      room.mafia = undefined;
      return;
    }
    m.alive.delete(playerId);
    m.kills.delete(playerId);
    for (const [k, t] of m.kills) if (t === playerId) m.kills.delete(k);
    for (const [v, t] of m.votes)
      if (v === playerId || t === playerId) m.votes.delete(v);
    if (room.clients.size < m.minPlayers) {
      this.finishGame(room, 'none');
      return;
    }
    if (this.checkWin(room)) return;
    if (m.phase === 'night') this.maybeEndNight(room);
    else if (m.phase === 'day') {
      this.ctx.broadcastToRoom(room.name, 'mafiaVoteUpdate', {
        roomName: room.name,
        voted: [...m.votes.keys()],
      });
      const voters = this.aliveIn(room, m).filter(
        (id) => !room.disconnectTimers.has(id),
      );
      if (voters.length > 1 && voters.every((id) => m.votes.has(id)))
        this.tally(room);
    }
  }

  private clearTimer(m: MafiaState): void {
    if (m.timer) clearTimeout(m.timer);
    m.timer = undefined;
  }

  private createDbSession(
    room: Room,
    players: { playerId: string; nickname: string }[],
  ): void {
    this.supabase
      .createSession(
        { roomName: room.name, gameType: 'mafia', playerCount: players.length },
        new Date(),
      )
      .then((sessionId) => {
        if (!sessionId || !room.mafia) return;
        room.supabaseSessionId = sessionId;
        return this.supabase
          .insertPlayerResults(
            players.map((p) => ({
              sessionId,
              userId: p.playerId,
              nickname: p.nickname,
            })),
          )
          .then(() => {
            for (const entry of room.pendingAbandonedPlayerIds ?? []) {
              const colon = entry.indexOf(':');
              this.supabase.markAbandoned(
                sessionId,
                entry.slice(colon + 1),
                entry.slice(0, colon) as 'voluntary' | 'disconnected',
              );
            }
            room.pendingAbandonedPlayerIds = [];
          });
      })
      .catch((e) => console.error('[Mafia] DB 세션 생성 실패', e));
  }

  // ── 재연결 ───────────────────────────────────────────────

  /** 이 사람이 알아도 되는 것만: 자기 역할, 마피아면 동료와 이번 밤 지목, 경찰이면 조사 기록 */
  buildMafiaState(room: Room, playerId: string): Record<string, unknown> {
    if (room.gameType !== 'mafia') return {};
    const m = room.mafia;
    if (!m)
      return { mafia: null, mafiaGameOver: room.mafiaGameOverResult ?? null };
    const role = m.roles.get(playerId) ?? null;
    return {
      mafia: {
        discussTimeSec: m.discussTimeSec,
        day: m.day,
        phase: m.phase,
        role,
        mafiaTeam: role === 'mafia' ? this.team(m) : [],
        alive: [...m.alive],
        players: [...m.roles.keys()],
        kills: role === 'mafia' ? Object.fromEntries(m.kills) : {},
        policeLog: role === 'police' ? m.policeLog : [],
        investigatedTonight: role === 'police' ? m.investigated : null,
        healedTonight: role === 'doctor' ? m.healed : null,
        voted: [...m.votes.keys()],
        myVote: m.votes.get(playerId) ?? null,
        lastNight: m.lastNight,
        lastExecution: m.lastExecution,
        timeLeftMs: Math.max(0, m.phaseEndsAt - Date.now()),
        away: [...room.disconnectTimers.keys()],
        nicknames: Object.fromEntries(m.nicknames),
      },
      mafiaGameOver: null,
    };
  }
}

function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
