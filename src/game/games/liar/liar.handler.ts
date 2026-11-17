import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { LiarRoundResult, LiarState, Room } from '../../game.types';
import { GameContext } from '../../game.context';
import { DatabaseService } from '../../../database/database.service';
import { LIAR_TOPICS } from './liar.words';

/**
 * 라이어 게임 핸들러
 *
 * 한 판: 모두 같은 주제·제시어를 받는데, 한 명(라이어)만 같은 주제의 다른 단어를 받는다.
 * 라이어에게도 라이어라고 알리지 않는다 — 남들 설명이 내 단어와 묘하게 안 맞으면 내가 라이어다.
 * 정해진 순서로 한 줄씩 설명(바퀴 수만큼, 그동안 다른 사람은 채팅 가능) → 자유 토론하며 투표 →
 * 가장 많이 지목된 사람이 라이어면 라이어에게 제시어를 맞힐 기회 한 번.
 *   - 동점·무투표, 엉뚱한 사람 지목, 라이어가 제시어를 맞힘 → 라이어 승 (+3)
 *   - 라이어가 못 맞힘 → 시민 승 (라이어를 찍은 시민만 +1)
 * 진행·판정·타이머는 모두 서버가 한다. 클라이언트 타이머는 표시용.
 *
 * 이벤트 (클라이언트 → 서버):
 *   liarStart - 게임 시작 (방장 전용, rounds, laps, discussTimeSec)
 *   liarText  - 입력칸 (설명 차례면 설명, 라이어 맞히기 시간의 라이어면 정답 시도, 나머지는 채팅)
 *   liarVote  - 지목 (targetId, null이면 취소)
 *
 * 이벤트 (서버 → 클라이언트):
 *   liarStarted     - 게임 시작 (설정, 점수)
 *   liarRound       - 새 판 (개인 전송: 주제, 내 단어 — 라이어는 다른 단어, 누가 라이어인지는 안 보낸다)
 *   liarSpeakTurn   - 설명 차례 (speakerId, lap, 제한시간)
 *   liarDescription - 설명 한 줄 (skipped: 시간 초과·연결 끊김)
 *   liarDiscuss     - 토론·투표 시작
 *   liarVoteUpdate  - 투표한 사람 목록 (누구를 찍었는지는 결과 때 공개)
 *   liarGuessTime   - 라이어가 지목됨, 제시어 맞히기 시간
 *   liarRoundResult - 판 결과
 *   liarChat        - 채팅
 *   liarBlocked     - 제시어를 말하려 함 (보낸 사람에게만)
 *   liarPresence    - 연결 끊김/복귀
 *   liarGameOver    - 게임 종료 (순위)
 */
@Injectable()
export class LiarHandler {
  static readonly ALLOWED_ROUNDS = [1, 3, 5];
  static readonly ALLOWED_LAPS = [1, 2];
  static readonly ALLOWED_DISCUSS_TIMES = [60, 90, 120]; // 초
  static readonly MIN_PLAYERS = 3;
  static readonly MAX_PLAYERS = 8;
  /** 제시어를 확인하는 시간 */
  static readonly WORD_TIME_MS = 8_000; // 새 판 시작 팝업을 읽을 시간
  /** 한 사람이 설명하는 시간 */
  static readonly DESC_TIME_MS = 30_000;
  static readonly LIAR_GUESS_TIME_MS = 20_000;
  static readonly RESULT_TIME_MS = 12_000; // 결과 팝업을 읽을 시간
  static readonly LIAR_WIN_POINTS = 3;
  static readonly CITIZEN_WIN_POINTS = 1;
  static readonly MAX_DESC_LENGTH = 40;
  static readonly MAX_TEXT_LENGTH = 100;

  constructor(
    private readonly ctx: GameContext,
    private readonly supabase: DatabaseService,
  ) {}

  // ── 시작 ─────────────────────────────────────────────────

  async handleStart(
    data: {
      roomName: string;
      rounds: number;
      laps: number;
      discussTimeSec: number;
    },
    client: WebSocket,
  ): Promise<void> {
    const { roomName, rounds, laps, discussTimeSec } = data;
    const room = this.ctx.rooms.get(roomName);
    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }
    const playerId = room.playerIds.get(client);
    if (playerId !== room.hostPlayerId) {
      this.ctx.sendToClient(client, 'error', {
        message: '방장만 게임을 시작할 수 있습니다',
      });
      return;
    }
    if (room.gameStarted) {
      this.ctx.sendToClient(client, 'error', {
        message: '이미 게임이 시작되었습니다',
      });
      return;
    }
    if (
      !LiarHandler.ALLOWED_ROUNDS.includes(rounds) ||
      !LiarHandler.ALLOWED_LAPS.includes(laps) ||
      !LiarHandler.ALLOWED_DISCUSS_TIMES.includes(discussTimeSec)
    ) {
      this.ctx.sendToClient(client, 'error', {
        message: '허용되지 않은 설정입니다',
      });
      return;
    }
    const adminBypass = playerId
      ? await this.supabase.isAdmin(playerId)
      : false;
    if (!adminBypass && room.clients.size < LiarHandler.MIN_PLAYERS) {
      this.ctx.sendToClient(client, 'error', {
        message: `라이어 게임은 최소 ${LiarHandler.MIN_PLAYERS}명이 필요합니다`,
      });
      return;
    }
    // isAdmin을 기다리는 사이 다른 요청으로 시작됐을 수 있다
    if (room.gameStarted) return;

    const players = this.ctx.getPlayersWithOrder(room);
    room.gameStarted = true;
    room.gameFinished = false;
    room.liarGameOverResult = undefined;
    room.sessionStartedAt = Date.now();
    room.liar = {
      totalRounds: rounds,
      descLaps: laps,
      discussTimeSec,
      minPlayers: adminBypass ? 1 : LiarHandler.MIN_PLAYERS,
      round: 0,
      phase: 'word',
      topic: '',
      word: '',
      liarWord: '',
      liarId: '',
      speakOrder: [],
      speakIndex: -1,
      descriptions: [],
      votes: new Map(),
      accusedId: null,
      phaseEndsAt: 0,
      scores: new Map(players.map((p) => [p.playerId, 0])),
      nicknames: new Map(players.map((p) => [p.playerId, p.nickname])),
      usedWords: new Set(),
      lastLiarId: null,
      lastResult: null,
    };

    this.createDbSession(room, players);

    this.ctx.broadcastToRoom(roomName, 'liarStarted', {
      roomName,
      totalRounds: rounds,
      laps,
      discussTimeSec,
      scores: Object.fromEntries(room.liar.scores),
    });
    console.log(
      `[Liar] '${roomName}' started | ${rounds}판 | ${laps}바퀴 | ${players.length}명`,
    );
    this.startRound(room);
  }

  // ── 판 진행 ──────────────────────────────────────────────

  private inRoomIds(room: Room): string[] {
    return this.ctx.getPlayersWithOrder(room).map((p) => p.playerId);
  }

  private startRound(room: Room): void {
    const d = room.liar;
    if (!d) return;
    this.clearTimer(d);
    const ids = this.inRoomIds(room);
    if (ids.length < d.minPlayers || ids.length === 0) {
      this.finishGame(room, 'notEnough');
      return;
    }
    d.round++;
    const { topic, word, liarWord } = this.pickWords(d);
    d.topic = topic;
    d.word = word;
    d.liarWord = liarWord;
    // 같은 사람이 연달아 라이어가 되지 않게 (혼자 남은 관리자 시험은 예외)
    const candidates =
      ids.length > 1 ? ids.filter((id) => id !== d.lastLiarId) : ids;
    d.liarId = candidates[Math.floor(Math.random() * candidates.length)];
    d.lastLiarId = d.liarId;
    d.speakOrder = shuffle([...ids]);
    d.speakIndex = -1;
    d.descriptions = [];
    d.votes = new Map();
    d.accusedId = null;
    d.lastResult = null;
    d.phase = 'word';
    d.phaseEndsAt = Date.now() + LiarHandler.WORD_TIME_MS;

    for (const [c, pid] of room.playerIds) {
      this.ctx.sendToClient(c, 'liarRound', {
        roomName: room.name,
        round: d.round,
        totalRounds: d.totalRounds,
        topic: d.topic,
        word: this.wordFor(d, pid),
        isLiar: this.knowsLiar(d, pid),
        speakOrder: d.speakOrder,
        timeLimitMs: LiarHandler.WORD_TIME_MS,
      });
    }
    d.timer = setTimeout(() => {
      if (room.liar === d && d.phase === 'word') this.startDescribe(room);
    }, LiarHandler.WORD_TIME_MS);
  }

  /**
   * 시민 단어 + 라이어 단어. 둘 다 **같은 묶음**(비슷한 것끼리 3~4개)에서 뽑는다.
   * 결과 때 두 단어가 다 공개되므로 한 번 쓴 묶음은 그 게임에서 다시 쓰지 않는다 (다 쓰면 처음부터).
   */
  private pickWords(d: LiarState): {
    topic: string;
    word: string;
    liarWord: string;
  } {
    const all = LIAR_TOPICS.flatMap((t) =>
      t.groups.map((g, i) => ({
        topic: t.topic,
        group: g,
        key: `${t.topic}/${i}`,
      })),
    );
    let pool = all.filter((g) => !d.usedWords.has(g.key));
    if (pool.length === 0) {
      d.usedWords.clear();
      pool = all;
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    d.usedWords.add(picked.key);
    const [word, liarWord] = shuffle([...picked.group]);
    return { topic: picked.topic, word, liarWord };
  }

  /** 이 사람 화면에 보이는 단어 (라이어는 다른 단어) */
  private wordFor(d: LiarState, playerId: string): string {
    return playerId === d.liarId ? d.liarWord : d.word;
  }

  /** 이 사람이 자기가 라이어인 걸 아는지 — 지목돼서 정답을 맞힐 때에야 안다 */
  private knowsLiar(d: LiarState, playerId: string): boolean {
    return playerId === d.liarId && d.phase === 'liarGuess';
  }

  private startDescribe(room: Room): void {
    const d = room.liar!;
    this.clearTimer(d);
    d.phase = 'describe';
    d.speakIndex = -1;
    this.nextSpeaker(room);
  }

  private currentSpeaker(d: LiarState): string | null {
    if (d.phase !== 'describe' || d.speakIndex < 0) return null;
    return d.speakOrder[d.speakIndex % d.speakOrder.length] ?? null;
  }

  /** 다음 설명 차례로. 나간 사람은 건너뛰고, 끊긴 사람은 '(연결 끊김)'으로 넘긴다 */
  private nextSpeaker(room: Room): void {
    const d = room.liar!;
    this.clearTimer(d);
    const total = d.speakOrder.length * d.descLaps;
    const inRoom = new Set(room.playerIds.values());
    while (true) {
      d.speakIndex++;
      if (d.speakIndex >= total) {
        this.startDiscuss(room);
        return;
      }
      const pid = d.speakOrder[d.speakIndex % d.speakOrder.length];
      if (!inRoom.has(pid)) continue;
      if (room.disconnectTimers.has(pid)) {
        this.record(room, pid, '(연결 끊김)', true);
        continue;
      }
      d.phaseEndsAt = Date.now() + LiarHandler.DESC_TIME_MS;
      this.ctx.broadcastToRoom(room.name, 'liarSpeakTurn', {
        roomName: room.name,
        speakerId: pid,
        nickname: d.nicknames.get(pid) ?? '',
        lap: this.lapOf(d),
        index: d.speakIndex,
        timeLimitMs: LiarHandler.DESC_TIME_MS,
      });
      d.timer = setTimeout(() => {
        if (room.liar !== d || this.currentSpeaker(d) !== pid) return;
        this.record(room, pid, '(시간 초과)', true);
        this.nextSpeaker(room);
      }, LiarHandler.DESC_TIME_MS);
      return;
    }
  }

  private lapOf(d: LiarState): number {
    return Math.floor(d.speakIndex / Math.max(1, d.speakOrder.length)) + 1;
  }

  private record(
    room: Room,
    playerId: string,
    text: string,
    skipped: boolean,
  ): void {
    const d = room.liar!;
    const entry = { playerId, text, lap: this.lapOf(d), skipped };
    d.descriptions.push(entry);
    this.ctx.broadcastToRoom(room.name, 'liarDescription', {
      roomName: room.name,
      ...entry,
      nickname: d.nicknames.get(playerId) ?? '',
    });
  }

  private startDiscuss(room: Room): void {
    const d = room.liar!;
    this.clearTimer(d);
    d.phase = 'discuss';
    d.votes = new Map();
    const ms = d.discussTimeSec * 1000;
    d.phaseEndsAt = Date.now() + ms;
    this.ctx.broadcastToRoom(room.name, 'liarDiscuss', {
      roomName: room.name,
      timeLimitMs: ms,
    });
    d.timer = setTimeout(() => {
      if (room.liar === d && d.phase === 'discuss') this.tally(room);
    }, ms);
  }

  // ── 입력 (설명 / 채팅 / 라이어의 정답 시도) ───────────────

  handleText(
    data: { roomName: string; text: unknown },
    client: WebSocket,
  ): void {
    const room = this.ctx.rooms.get(data.roomName);
    if (!room || !room.clients.has(client)) return;
    const playerId = room.playerIds.get(client);
    if (!playerId) return;
    const text = (typeof data.text === 'string' ? data.text : '')
      .trim()
      .slice(0, LiarHandler.MAX_TEXT_LENGTH);
    if (!text) return;
    const d = room.liar;
    const chat = () =>
      this.ctx.broadcastToRoom(room.name, 'liarChat', {
        roomName: room.name,
        playerId,
        nickname: room.nicknames.get(client) ?? '',
        text,
      });

    if (!d || d.phase === 'result') {
      chat();
      return;
    }

    if (d.phase === 'liarGuess' && playerId === d.liarId) {
      this.judgeGuess(room, text);
      return;
    }

    // 자기 단어를 그대로 말하면 라이어에게 정답이 새므로 막는다
    const own = this.wordFor(d, playerId);
    if (own && normalize(text).includes(normalize(own))) {
      this.ctx.sendToClient(client, 'liarBlocked', { roomName: room.name });
      return;
    }

    // 설명 차례인 사람의 입력은 설명, 나머지 사람은 그동안에도 채팅할 수 있다
    if (d.phase === 'describe' && this.currentSpeaker(d) === playerId) {
      this.record(
        room,
        playerId,
        text.slice(0, LiarHandler.MAX_DESC_LENGTH),
        false,
      );
      this.nextSpeaker(room);
      return;
    }

    chat();
  }

  // ── 투표 ─────────────────────────────────────────────────

  handleVote(
    data: { roomName: string; targetId: unknown },
    client: WebSocket,
  ): void {
    const room = this.ctx.rooms.get(data.roomName);
    const d = room?.liar;
    if (!room || !d || d.phase !== 'discuss') return;
    const voterId = room.playerIds.get(client);
    if (!voterId || !d.speakOrder.includes(voterId)) return;
    const inRoom = new Set(room.playerIds.values());
    if (data.targetId === null) {
      d.votes.delete(voterId);
    } else {
      const targetId = data.targetId;
      if (
        typeof targetId !== 'string' ||
        targetId === voterId ||
        !inRoom.has(targetId) ||
        !d.speakOrder.includes(targetId)
      )
        return;
      d.votes.set(voterId, targetId);
    }
    this.broadcastVotes(room, d);
    this.checkAllVoted(room, d);
  }

  private broadcastVotes(room: Room, d: LiarState): void {
    this.ctx.broadcastToRoom(room.name, 'liarVoteUpdate', {
      roomName: room.name,
      voted: Array.from(d.votes.keys()),
    });
  }

  /** 접속해 있는 참가자가 모두 투표하면 바로 집계 */
  private checkAllVoted(room: Room, d: LiarState): void {
    if (d.phase !== 'discuss') return;
    const voters = this.inRoomIds(room).filter(
      (pid) => d.speakOrder.includes(pid) && !room.disconnectTimers.has(pid),
    );
    if (voters.length > 1 && voters.every((pid) => d.votes.has(pid)))
      this.tally(room);
  }

  private countVotes(room: Room, d: LiarState): Record<string, number> {
    const inRoom = new Set(room.playerIds.values());
    const tally: Record<string, number> = {};
    for (const [voter, target] of d.votes) {
      if (!inRoom.has(voter) || !inRoom.has(target)) continue;
      tally[target] = (tally[target] ?? 0) + 1;
    }
    return tally;
  }

  private tally(room: Room): void {
    const d = room.liar!;
    this.clearTimer(d);
    const tally = this.countVotes(room, d);
    const max = Math.max(0, ...Object.values(tally));
    const top = Object.keys(tally).filter((pid) => tally[pid] === max);
    d.accusedId = max > 0 && top.length === 1 ? top[0] : null;

    if (!d.accusedId) {
      this.finishRound(room, 'liar', 'tie', null);
      return;
    }
    if (d.accusedId !== d.liarId) {
      this.finishRound(room, 'liar', 'wrongAccused', null);
      return;
    }
    d.phase = 'liarGuess';
    d.phaseEndsAt = Date.now() + LiarHandler.LIAR_GUESS_TIME_MS;
    this.ctx.broadcastToRoom(room.name, 'liarGuessTime', {
      roomName: room.name,
      liarId: d.liarId,
      nickname: d.nicknames.get(d.liarId) ?? '',
      tally,
      votes: Object.fromEntries(d.votes),
      timeLimitMs: LiarHandler.LIAR_GUESS_TIME_MS,
    });
    d.timer = setTimeout(() => {
      if (room.liar === d && d.phase === 'liarGuess')
        this.finishRound(room, 'citizens', 'guessFailed', null);
    }, LiarHandler.LIAR_GUESS_TIME_MS);
  }

  private judgeGuess(room: Room, guess: string): void {
    const d = room.liar!;
    const correct = normalize(guess) === normalize(d.word);
    this.finishRound(
      room,
      correct ? 'liar' : 'citizens',
      correct ? 'guessed' : 'guessFailed',
      guess.slice(0, LiarHandler.MAX_DESC_LENGTH),
    );
  }

  // ── 판 결과 ──────────────────────────────────────────────

  private finishRound(
    room: Room,
    winner: LiarRoundResult['winner'],
    reason: LiarRoundResult['reason'],
    liarGuess: string | null,
  ): void {
    const d = room.liar;
    if (!d || d.phase === 'result') return;
    this.clearTimer(d);
    const inRoom = new Set(room.playerIds.values());
    const gains: Record<string, number> = {};
    if (winner === 'liar' && inRoom.has(d.liarId)) {
      gains[d.liarId] = LiarHandler.LIAR_WIN_POINTS;
    } else if (winner === 'citizens') {
      // 라이어를 맞게 찍은 시민만 받는다 (엉뚱한 사람을 찍었거나 투표 안 한 사람은 0)
      for (const [voter, target] of d.votes)
        if (target === d.liarId && voter !== d.liarId && inRoom.has(voter))
          gains[voter] = LiarHandler.CITIZEN_WIN_POINTS;
    }
    for (const [pid, n] of Object.entries(gains))
      d.scores.set(pid, (d.scores.get(pid) ?? 0) + n);

    const result: LiarRoundResult = {
      round: d.round,
      liarId: d.liarId,
      liarNickname: d.nicknames.get(d.liarId) ?? '',
      topic: d.topic,
      word: d.word,
      liarWord: d.liarWord,
      accusedId: d.accusedId,
      tally: this.countVotes(room, d),
      votes: Object.fromEntries(d.votes),
      liarGuess,
      winner,
      reason,
      gains,
    };
    d.lastResult = result;
    d.phase = 'result';
    d.phaseEndsAt = Date.now() + LiarHandler.RESULT_TIME_MS;
    const isLast = d.round >= d.totalRounds;
    this.ctx.broadcastToRoom(room.name, 'liarRoundResult', {
      roomName: room.name,
      ...result,
      scores: Object.fromEntries(d.scores),
      isLast,
      timeLimitMs: LiarHandler.RESULT_TIME_MS,
    });
    console.log(
      `[Liar] '${room.name}' round ${d.round} | ${winner} (${reason}) | ${d.topic}/${d.word}`,
    );
    d.timer = setTimeout(() => {
      if (room.liar !== d) return;
      if (isLast) this.finishGame(room, 'finished');
      else this.startRound(room);
    }, LiarHandler.RESULT_TIME_MS);
  }

  // ── 연결 끊김 / 이탈 ─────────────────────────────────────

  handleDisconnect(room: Room, playerId: string): void {
    const d = room.liar;
    if (!d) return;
    this.ctx.broadcastToRoom(room.name, 'liarPresence', {
      roomName: room.name,
      playerId,
      connected: false,
    });
    // 설명 차례였으면 기다리지 않고 넘긴다
    if (this.currentSpeaker(d) === playerId) {
      this.record(room, playerId, '(연결 끊김)', true);
      this.nextSpeaker(room);
      return;
    }
    // 남은 사람이 모두 투표했으면 바로 집계
    this.checkAllVoted(room, d);
  }

  handleReconnect(room: Room, playerId: string): void {
    if (!room.liar) return;
    this.ctx.broadcastToRoom(room.name, 'liarPresence', {
      roomName: room.name,
      playerId,
      connected: true,
    });
  }

  handlePlayerLeft(room: Room, playerId: string): void {
    const d = room.liar;
    if (!d) return;
    if (room.clients.size === 0) {
      this.clearTimer(d);
      room.liar = undefined;
      return;
    }
    if (room.clients.size < d.minPlayers) {
      this.finishGame(room, 'notEnough');
      return;
    }
    if (d.phase === 'result') return;
    if (playerId === d.liarId) {
      this.finishRound(room, 'none', 'liarLeft', null);
      return;
    }
    // 그 사람이 한 투표, 그 사람에게 간 투표는 뺀다
    for (const [voter, target] of d.votes)
      if (voter === playerId || target === playerId) d.votes.delete(voter);
    if (this.currentSpeaker(d) === playerId) {
      this.nextSpeaker(room);
      return;
    }
    if (d.phase === 'discuss') {
      this.broadcastVotes(room, d);
      this.checkAllVoted(room, d);
    }
  }

  // ── 종료 ─────────────────────────────────────────────────

  private finishGame(room: Room, reason: 'finished' | 'notEnough'): void {
    const d = room.liar;
    if (!d) return;
    this.clearTimer(d);

    const sorted = Array.from(d.scores.entries()).sort((a, b) => b[1] - a[1]);
    const ranking = sorted.map(([playerId, score]) => ({
      playerId,
      nickname: d.nicknames.get(playerId) ?? '',
      score,
      rank: sorted.findIndex(([, s]) => s === score) + 1,
    }));
    room.liarGameOverResult = { reason, ranking };
    room.liar = undefined;
    room.gameStarted = false;
    room.gameFinished = true;

    this.ctx.broadcastToRoom(room.name, 'liarGameOver', {
      roomName: room.name,
      reason,
      ranking,
    });
    console.log(
      `[Liar] '${room.name}' finished (${reason}) | ${ranking.map((r) => `${r.nickname} ${r.score}`).join(', ')}`,
    );

    if (room.supabaseSessionId) {
      const sessionId = room.supabaseSessionId;
      room.supabaseSessionId = undefined;
      const durationSec = room.sessionStartedAt
        ? Math.floor((Date.now() - room.sessionStartedAt) / 1000)
        : 0;
      this.supabase.updateSessionDuration(sessionId, durationSec);
      for (const r of ranking) {
        this.supabase.finalizePlayerResult({
          sessionId,
          userId: r.playerId,
          isWinner: r.rank === 1,
          score: r.score,
          rank: r.rank,
          playTimeSec: durationSec,
          extra: { totalRounds: d.totalRounds, ranking },
        });
      }
    }
  }

  private clearTimer(d: LiarState): void {
    if (d.timer) clearTimeout(d.timer);
    d.timer = undefined;
  }

  private createDbSession(
    room: Room,
    players: { playerId: string; nickname: string }[],
  ): void {
    this.supabase
      .createSession(
        { roomName: room.name, gameType: 'liar', playerCount: players.length },
        new Date(),
      )
      .then((sessionId) => {
        if (!sessionId) return;
        // 아주 짧은 게임이면 세션이 만들어지기 전에 끝났을 수 있다
        if (!room.liar) return;
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
      .catch((e) => console.error('[Liar] DB 세션 생성 실패', e));
  }

  // ── 재연결 ───────────────────────────────────────────────

  buildLiarState(room: Room, playerId: string): Record<string, unknown> {
    if (room.gameType !== 'liar') return {};
    const d = room.liar;
    if (!d)
      return { liar: null, liarGameOver: room.liarGameOverResult ?? null };
    return {
      liar: {
        totalRounds: d.totalRounds,
        laps: d.descLaps,
        discussTimeSec: d.discussTimeSec,
        round: d.round,
        phase: d.phase,
        topic: d.topic,
        word: d.phase === 'result' ? d.word : this.wordFor(d, playerId),
        isLiar: this.knowsLiar(d, playerId),
        speakOrder: d.speakOrder,
        speakerId: this.currentSpeaker(d),
        lap: d.phase === 'describe' ? this.lapOf(d) : null,
        descriptions: d.descriptions.map((e) => ({
          ...e,
          nickname: d.nicknames.get(e.playerId) ?? '',
        })),
        voted: Array.from(d.votes.keys()),
        myVote: d.votes.get(playerId) ?? null,
        accusedId: d.phase === 'liarGuess' ? d.accusedId : null,
        result: d.phase === 'result' ? d.lastResult : null,
        isLast: d.round >= d.totalRounds,
        scores: Object.fromEntries(d.scores),
        timeLeftMs: Math.max(0, d.phaseEndsAt - Date.now()),
        away: Array.from(room.disconnectTimers.keys()),
      },
      liarGameOver: null,
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

/** 비교용: 띄어쓰기·기호·이모지·자모만 있는 글자를 빼고 소문자로 */
function normalize(s: string): string {
  return s.replace(/[\s\p{P}\p{S}ㄱ-ㆎ]/gu, '').toLowerCase();
}
