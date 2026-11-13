import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { DrawingState, DrawingStroke, Room } from '../../game.types';
import { GameContext } from '../../game.context';
import { DatabaseService } from '../../../database/database.service';
import { DRAWING_WORDS } from './drawing.words';

/** 그리는 사람이 보내는 선 조각. 50ms 정도마다 묶어서 온다 */
type StrokeOp =
  | { t: 'b'; id: number; c: string; s: number; p: number[] } // 새 선 시작
  | { t: 'm'; id: number; p: number[] } // 이어 그리기
  | { t: 'u' } // 되돌리기 (마지막 선 삭제)
  | { t: 'x' }; // 전체 지우기

/**
 * '끄적끄적'(그림 맞히기) 게임 핸들러
 *
 * 한 명이 제시어를 고르고 그리면 나머지가 채팅으로 맞힌다.
 * 처음엔 선뽑기(1~10)로 가장 높은 사람이 그리고, 그다음부터는 처음 맞힌 사람이 그린다
 * (아무도 못 맞히면 자리 순서로 다음 사람). 그림 수는 시작 인원 × 바퀴 수.
 * 정답 판정·점수·타이머는 모두 서버가 한다. 클라이언트 타이머는 표시용.
 *
 * 이벤트 (클라이언트 → 서버):
 *   drawingStart   - 게임 시작 (방장 전용, rounds, drawTimeSec)
 *   drawingFirstDraw - 선뽑기 카드 뽑기
 *   drawingChoose  - 제시어 고르기 (그리는 사람, index)
 *   drawingStroke  - 그림 조각 (그리는 사람, ops)
 *   drawingGuess   - 채팅/정답 입력 (text)
 *
 * 이벤트 (서버 → 클라이언트):
 *   drawingStarted   - 게임 시작 (설정, 순서, 점수)
 *   drawingFirstDrawStarted / drawingFirstDrawUpdate / drawingFirstDrawFinished - 선뽑기 시작 / 뽑은 숫자 / 결과(firstPlayerId)
 *   drawingTurn      - 새 턴 (제시어 고르는 중)
 *   drawingChoices   - 제시어 후보 (그리는 사람에게만)
 *   drawingDrawStart - 그리기 시작 (글자 수 힌트, 제한시간)
 *   drawingWord      - 고른 제시어 (그리는 사람에게만)
 *   drawingStroke    - 그림 조각 중계 (그리는 사람 제외)
 *   drawingHint      - 힌트 공개 (초성, 글자)
 *   drawingChat      - 채팅 (scope: all | guessed — 맞힌 사람끼리)
 *   drawingCorrect   - 누가 맞힘 (점수 포함, 정답 글자는 없음)
 *   drawingClose     - 아깝게 틀림 (보낸 사람에게만)
 *   drawingBlocked   - 그리는 사람이 정답을 말하려 함 (보낸 사람에게만)
 *   drawingGuessTime - 그리기 끝, 맞히기만 30초 (hint, timeLimitMs)
 *   drawingTurnEnd   - 턴 종료 (정답, 맞힌 사람, 다음 차례). 정답이 나왔으면 5초 보여주고, 아니면 바로 다음 턴
 *   drawingPresence  - 연결 끊김/복귀
 *   drawingGameOver  - 게임 종료 (순위)
 */
@Injectable()
export class DrawingHandler {
  static readonly ALLOWED_ROUNDS = [1, 2, 3];
  static readonly ALLOWED_DRAW_TIMES = [60, 80, 100]; // 초
  static readonly MIN_PLAYERS = 2;
  static readonly CHOOSE_TIME_MS = 10_000;
  /** 선뽑기: 안 뽑은 사람은 이 시간이 지나면 서버가 대신 뽑는다 */
  static readonly FIRST_DRAW_TIME_MS = 20_000;
  /** 선뽑기 결과를 보여주는 시간 */
  static readonly FIRST_DRAW_RESULT_MS = 2_500;
  /** 그리는 시간이 끝난 뒤 그림은 그대로 두고 맞히기만 하는 시간 */
  static readonly GUESS_TIME_MS = 30_000;
  /** 정답이 나오면 그림과 정답을 보여주는 시간 */
  static readonly REVEAL_TIME_MS = 5_000;
  /** 그리는 사람이 이만큼 끊겨 있으면 그 턴을 넘긴다 */
  static readonly DRAWER_AWAY_MS = 10_000;
  static readonly CHOICE_COUNT = 3;
  /** 한 턴에 받을 수 있는 점 개수 (장난 낙서로 메모리가 늘지 않게) */
  static readonly MAX_POINTS_PER_TURN = 20_000;
  static readonly MAX_OPS_PER_MESSAGE = 200;
  static readonly MAX_TEXT_LENGTH = 100;
  static readonly COLORS = [
    '#222222',
    '#e74c3c',
    '#f39c12',
    '#f1c40f',
    '#27ae60',
    '#3498db',
    '#8e44ad',
    '#ffffff',
  ];
  static readonly SIZES = [6, 14, 30, 60]; // 마지막은 지우개 전용 굵기

  constructor(
    private readonly ctx: GameContext,
    private readonly supabase: DatabaseService,
  ) {}

  // ── 시작 ─────────────────────────────────────────────────

  async handleStart(
    data: { roomName: string; rounds: number; drawTimeSec: number },
    client: WebSocket,
  ): Promise<void> {
    const { roomName, rounds, drawTimeSec } = data;
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
      !DrawingHandler.ALLOWED_ROUNDS.includes(rounds) ||
      !DrawingHandler.ALLOWED_DRAW_TIMES.includes(drawTimeSec)
    ) {
      this.ctx.sendToClient(client, 'error', {
        message: '허용되지 않은 설정입니다',
      });
      return;
    }
    const adminBypass = playerId
      ? await this.supabase.isAdmin(playerId)
      : false;
    if (!adminBypass && room.clients.size < DrawingHandler.MIN_PLAYERS) {
      this.ctx.sendToClient(client, 'error', {
        message: `끄적끄적은 최소 ${DrawingHandler.MIN_PLAYERS}명이 필요합니다`,
      });
      return;
    }
    // isAdmin을 기다리는 사이 다른 요청으로 시작됐을 수 있다
    if (room.gameStarted) return;

    const players = this.ctx.getPlayersWithOrder(room);
    room.gameStarted = true;
    room.gameFinished = false;
    room.drawingGameOverResult = undefined;
    room.sessionStartedAt = Date.now();
    room.drawing = {
      totalRounds: rounds,
      drawTimeSec,
      turnNumber: 0,
      totalTurns: rounds * players.length,
      turnOrder: players.map((p) => p.playerId),
      phase: 'firstDraw',
      firstDraw: new Map(),
      firstDrawPool: shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      firstDrawDone: false,
      nextDrawerId: null,
      drawStartedAt: 0,
      drawerId: '',
      choices: [],
      word: null,
      phaseStartedAt: 0,
      phaseEndsAt: 0,
      hintTimers: [],
      hint: [],
      strokes: [],
      pointCount: 0,
      guessed: [],
      scores: new Map(players.map((p) => [p.playerId, 0])),
      turnGains: new Map(),
      usedWords: new Set(),
      nicknames: new Map(players.map((p) => [p.playerId, p.nickname])),
    };

    this.createDbSession(room, players);

    this.ctx.broadcastToRoom(roomName, 'drawingStarted', {
      roomName,
      totalRounds: rounds,
      totalTurns: room.drawing.totalTurns,
      drawTimeSec,
      turnOrder: room.drawing.turnOrder,
      scores: Object.fromEntries(room.drawing.scores),
    });
    console.log(
      `[Drawing] '${roomName}' started | rounds ${rounds} | ${drawTimeSec}s | ${players.length}명`,
    );
    this.startFirstDraw(room);
  }

  // ── 선뽑기 ───────────────────────────────────────────────

  /** 1~10 중 하나씩 뽑아 가장 높은 사람이 먼저 그린다 */
  private startFirstDraw(room: Room): void {
    const d = room.drawing!;
    d.phaseStartedAt = Date.now();
    d.phaseEndsAt = d.phaseStartedAt + DrawingHandler.FIRST_DRAW_TIME_MS;
    this.ctx.broadcastToRoom(room.name, 'drawingFirstDrawStarted', {
      roomName: room.name,
      timeLimitMs: DrawingHandler.FIRST_DRAW_TIME_MS,
    });
    d.timer = setTimeout(() => {
      if (room.drawing === d) this.finishFirstDraw(room);
    }, DrawingHandler.FIRST_DRAW_TIME_MS);
  }

  handleFirstDraw(data: { roomName: string }, client: WebSocket): void {
    const room = this.ctx.rooms.get(data.roomName);
    const d = room?.drawing;
    if (!room || !d || d.phase !== 'firstDraw' || d.firstDrawDone) return;
    const playerId = room.playerIds.get(client);
    if (!playerId || d.firstDraw.has(playerId)) return;
    this.drawNumber(d, playerId);
    this.ctx.broadcastToRoom(room.name, 'drawingFirstDrawUpdate', {
      roomName: room.name,
      draws: Object.fromEntries(d.firstDraw),
    });
    this.checkFirstDrawDone(room, d);
  }

  private drawNumber(d: DrawingState, playerId: string): void {
    d.firstDraw.set(playerId, d.firstDrawPool.pop() ?? 0);
  }

  private checkFirstDrawDone(room: Room, d: DrawingState): void {
    const all = Array.from(room.playerIds.values());
    if (all.every((pid) => d.firstDraw.has(pid))) this.finishFirstDraw(room);
  }

  private finishFirstDraw(room: Room): void {
    const d = room.drawing;
    if (!d || d.phase !== 'firstDraw' || d.firstDrawDone) return;
    this.clearTurnTimers(d);
    d.firstDrawDone = true;
    // 안 뽑은 사람(끊김·잠수)은 대신 뽑는다. 나간 사람 결과는 뺀다
    const inRoom = new Set(room.playerIds.values());
    for (const pid of inRoom)
      if (!d.firstDraw.has(pid)) this.drawNumber(d, pid);
    for (const pid of d.firstDraw.keys())
      if (!inRoom.has(pid)) d.firstDraw.delete(pid);

    let first = '';
    let best = -1;
    for (const [pid, n] of d.firstDraw) {
      if (n > best) {
        best = n;
        first = pid;
      }
    }
    d.nextDrawerId = first;
    d.phaseStartedAt = Date.now();
    d.phaseEndsAt = d.phaseStartedAt + DrawingHandler.FIRST_DRAW_RESULT_MS;
    this.ctx.broadcastToRoom(room.name, 'drawingFirstDrawFinished', {
      roomName: room.name,
      draws: Object.fromEntries(d.firstDraw),
      firstPlayerId: first,
      firstNickname: d.nicknames.get(first) ?? '',
    });
    d.timer = setTimeout(() => {
      if (room.drawing === d) this.startNextTurn(room);
    }, DrawingHandler.FIRST_DRAW_RESULT_MS);
  }

  // ── 턴 진행 ──────────────────────────────────────────────

  /** 아무도 못 맞혔거나 정해진 사람이 나갔을 때: 자리 순서로 그 다음 사람 */
  private seatAfter(
    room: Room,
    d: DrawingState,
    playerId: string,
  ): string | null {
    const inRoom = new Set(room.playerIds.values());
    const start = d.turnOrder.indexOf(playerId);
    for (let k = 1; k <= d.turnOrder.length; k++) {
      const pid =
        d.turnOrder[(start + k + d.turnOrder.length) % d.turnOrder.length];
      if (inRoom.has(pid) && pid !== playerId) return pid;
    }
    return null;
  }

  private startNextTurn(room: Room): void {
    const d = room.drawing;
    if (!d) return;
    this.clearTurnTimers(d);

    d.turnNumber++;
    if (d.turnNumber > d.totalTurns) {
      this.finishGame(room, 'finished');
      return;
    }
    const inRoom = new Set(room.playerIds.values());
    const drawerId =
      d.nextDrawerId && inRoom.has(d.nextDrawerId)
        ? d.nextDrawerId
        : this.seatAfter(
            room,
            d,
            d.drawerId || (d.turnOrder[d.turnOrder.length - 1] ?? ''),
          );
    if (!drawerId) {
      this.finishGame(room, 'notEnough');
      return;
    }

    d.drawerId = drawerId;
    d.nextDrawerId = null;
    d.phase = 'choose';
    d.word = null;
    d.hint = [];
    d.strokes = [];
    d.pointCount = 0;
    d.guessed = [];
    d.turnGains = new Map();
    d.choices = this.pickChoices(d);
    d.phaseStartedAt = Date.now();
    d.phaseEndsAt = d.phaseStartedAt + DrawingHandler.CHOOSE_TIME_MS;

    this.ctx.broadcastToRoom(room.name, 'drawingTurn', {
      roomName: room.name,
      turnNumber: d.turnNumber,
      totalTurns: d.totalTurns,
      drawerId: d.drawerId,
      drawerNickname: d.nicknames.get(d.drawerId) ?? '',
      timeLimitMs: DrawingHandler.CHOOSE_TIME_MS,
    });
    const drawer = this.ctx.findClientByPlayerId(room, d.drawerId);
    if (drawer)
      this.ctx.sendToClient(drawer, 'drawingChoices', {
        roomName: room.name,
        choices: d.choices,
      });

    d.timer = setTimeout(() => {
      if (room.drawing !== d || d.phase !== 'choose') return;
      // 끊겨서 못 고른 거면 그릴 사람이 없으니 넘긴다. 아니면 아무거나 골라 준다
      if (room.disconnectTimers.has(d.drawerId))
        this.endTurn(room, 'drawerAway');
      else
        this.startDrawing(room, Math.floor(Math.random() * d.choices.length));
    }, DrawingHandler.CHOOSE_TIME_MS);

    // 그리는 차례가 됐는데 이미 끊겨 있으면 바로 기다리기 시작한다
    if (room.disconnectTimers.has(d.drawerId)) this.startDrawerAwayTimer(room);
  }

  private pickChoices(d: DrawingState): string[] {
    let pool = DRAWING_WORDS.filter((w) => !d.usedWords.has(w));
    if (pool.length < DrawingHandler.CHOICE_COUNT) {
      d.usedWords.clear();
      pool = [...DRAWING_WORDS];
    }
    const picks: string[] = [];
    while (picks.length < DrawingHandler.CHOICE_COUNT) {
      const w = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      picks.push(w);
    }
    return picks;
  }

  handleChoose(
    data: { roomName: string; index: number },
    client: WebSocket,
  ): void {
    const room = this.ctx.rooms.get(data.roomName);
    const d = room?.drawing;
    if (!room || !d || d.phase !== 'choose') return;
    if (room.playerIds.get(client) !== d.drawerId) return;
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= d.choices.length)
      return;
    this.startDrawing(room, index);
  }

  private startDrawing(room: Room, index: number): void {
    const d = room.drawing!;
    this.clearTurnTimers(d);
    d.word = d.choices[index];
    d.usedWords.add(d.word);
    d.phase = 'draw';
    d.hint = Array.from(d.word, (ch) => (ch === ' ' ? ' ' : null));
    d.phaseStartedAt = Date.now();
    d.drawStartedAt = d.phaseStartedAt;
    const drawMs = d.drawTimeSec * 1000;
    d.phaseEndsAt = d.phaseStartedAt + drawMs;

    this.ctx.broadcastToRoom(room.name, 'drawingDrawStart', {
      roomName: room.name,
      drawerId: d.drawerId,
      hint: d.hint,
      timeLimitMs: drawMs,
    });
    const drawer = this.ctx.findClientByPlayerId(room, d.drawerId);
    if (drawer)
      this.ctx.sendToClient(drawer, 'drawingWord', {
        roomName: room.name,
        word: d.word,
      });

    // 절반 지나면 초성, 그리기가 끝나면(맞히기 시간 시작) 한 글자
    d.hintTimers.push(
      setTimeout(() => this.revealChosung(room, d), drawMs / 2),
    );
    d.timer = setTimeout(() => {
      if (room.drawing === d && d.phase === 'draw') this.startGuessTime(room);
    }, drawMs);
  }

  /** 그리기는 잠그고 맞히기만 30초 더 */
  private startGuessTime(room: Room): void {
    const d = room.drawing!;
    this.clearTurnTimers(d);
    this.revealOneLetter(room, d);
    d.phase = 'guess';
    d.phaseStartedAt = Date.now();
    d.phaseEndsAt = d.phaseStartedAt + DrawingHandler.GUESS_TIME_MS;
    this.ctx.broadcastToRoom(room.name, 'drawingGuessTime', {
      roomName: room.name,
      hint: d.hint,
      timeLimitMs: DrawingHandler.GUESS_TIME_MS,
    });
    d.timer = setTimeout(() => {
      if (room.drawing === d && d.phase === 'guess') this.endTurn(room, 'time');
    }, DrawingHandler.GUESS_TIME_MS);
  }

  private revealChosung(room: Room, d: DrawingState): void {
    if (room.drawing !== d || d.phase !== 'draw' || !d.word) return;
    d.hint = Array.from(d.word, (ch, i) => d.hint[i] ?? chosungOf(ch));
    this.ctx.broadcastToRoom(room.name, 'drawingHint', {
      roomName: room.name,
      hint: d.hint,
    });
  }

  private revealOneLetter(room: Room, d: DrawingState): void {
    if (room.drawing !== d || d.phase !== 'draw' || !d.word) return;
    const chars = Array.from(d.word);
    // 글자가 하나뿐이면 정답이 다 보이므로 공개하지 않는다
    if (chars.length < 2) return;
    const hidden = chars
      .map((ch, i) => i)
      .filter((i) => d.hint[i] !== chars[i]);
    if (hidden.length <= 1) return;
    const i = hidden[Math.floor(Math.random() * hidden.length)];
    // 초성이 아직이면(그리기 시간이 아주 짧을 때) 같이 공개한다
    d.hint = chars.map((ch, j) =>
      j === i ? ch : (d.hint[j] ?? chosungOf(ch)),
    );
  }

  /**
   * 정답이 나오면(correct) 그림과 정답을 5초 보여준 뒤 맞힌 사람이 다음에 그린다.
   * 아무도 못 맞혔으면 정답만 알리고 바로 자리 순서로 다음 사람 차례.
   */
  private endTurn(
    room: Room,
    reason: 'correct' | 'time' | 'drawerLeft' | 'drawerAway',
  ): void {
    const d = room.drawing;
    if (!d || d.phase === 'reveal' || d.phase === 'firstDraw') return;
    this.clearTurnTimers(d);
    // 고르기 전에 끝났으면 null (화면에는 '제시어를 고르지 않았어요')
    const word = d.word;
    const winnerId = reason === 'correct' ? (d.guessed[0] ?? null) : null;
    d.nextDrawerId = winnerId ?? this.seatAfter(room, d, d.drawerId);
    const isLast = d.turnNumber >= d.totalTurns;
    const revealMs = winnerId ? DrawingHandler.REVEAL_TIME_MS : 0;
    d.phase = 'reveal';
    d.phaseStartedAt = Date.now();
    d.phaseEndsAt = d.phaseStartedAt + revealMs;

    this.ctx.broadcastToRoom(room.name, 'drawingTurnEnd', {
      roomName: room.name,
      reason,
      word,
      drawerId: d.drawerId,
      gains: Object.fromEntries(d.turnGains),
      scores: Object.fromEntries(d.scores),
      nextDrawerId: isLast ? null : d.nextDrawerId,
      nextDrawerNickname:
        isLast || !d.nextDrawerId
          ? null
          : (d.nicknames.get(d.nextDrawerId) ?? ''),
      winnerId,
      winnerNickname: winnerId ? (d.nicknames.get(winnerId) ?? '') : null,
      timeLimitMs: revealMs,
    });
    if (revealMs === 0) {
      this.startNextTurn(room);
      return;
    }
    d.timer = setTimeout(() => {
      if (room.drawing === d) this.startNextTurn(room);
    }, revealMs);
  }

  // ── 그림 ─────────────────────────────────────────────────

  handleStroke(
    data: { roomName: string; ops: unknown },
    client: WebSocket,
  ): void {
    const room = this.ctx.rooms.get(data.roomName);
    const d = room?.drawing;
    if (!room || !d || d.phase !== 'draw') return;
    if (room.playerIds.get(client) !== d.drawerId) return;
    if (!Array.isArray(data.ops)) return;

    const accepted: StrokeOp[] = [];
    for (const raw of data.ops.slice(0, DrawingHandler.MAX_OPS_PER_MESSAGE)) {
      const op = this.applyOp(d, raw);
      if (op) accepted.push(op);
    }
    if (accepted.length === 0) return;
    this.ctx.broadcastToRoom(
      room.name,
      'drawingStroke',
      { roomName: room.name, ops: accepted },
      client,
    );
  }

  /** 검증해서 상태에 반영하고, 다른 사람에게 보낼 깨끗한 조각을 돌려준다 */
  private applyOp(d: DrawingState, raw: unknown): StrokeOp | null {
    if (!raw || typeof raw !== 'object') return null;
    const op = raw as Record<string, unknown>;
    if (op.t === 'u') {
      if (d.strokes.length === 0) return null;
      const removed = d.strokes.pop()!;
      d.pointCount -= removed.points.length / 2;
      return { t: 'u' };
    }
    if (op.t === 'x') {
      if (d.strokes.length === 0) return null;
      d.strokes = [];
      d.pointCount = 0;
      return { t: 'x' };
    }
    const id = Number(op.id);
    if (!Number.isInteger(id)) return null;
    const points = this.cleanPoints(d, op.p);
    if (op.t === 'b') {
      const color = String(op.c);
      const size = Number(op.s);
      if (
        !DrawingHandler.COLORS.includes(color) ||
        !DrawingHandler.SIZES.includes(size)
      )
        return null;
      if (points.length < 2) return null;
      d.strokes.push({ id, color, size, points });
      return { t: 'b', id, c: color, s: size, p: points };
    }
    if (op.t === 'm') {
      const stroke = this.findStroke(d, id);
      if (!stroke || points.length === 0) return null;
      stroke.points.push(...points);
      return { t: 'm', id, p: points };
    }
    return null;
  }

  private findStroke(d: DrawingState, id: number): DrawingStroke | undefined {
    // 이어 그리는 선은 거의 항상 마지막 선이다
    for (let i = d.strokes.length - 1; i >= 0; i--)
      if (d.strokes[i].id === id) return d.strokes[i];
    return undefined;
  }

  private cleanPoints(d: DrawingState, raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    const room = DrawingHandler.MAX_POINTS_PER_TURN - d.pointCount;
    const pairs = Math.min(Math.floor(raw.length / 2), 400, Math.max(0, room));
    const out: number[] = [];
    for (let i = 0; i < pairs * 2; i++) {
      const n = Math.round(Number(raw[i]));
      if (!Number.isFinite(n)) return [];
      out.push(Math.min(1000, Math.max(0, n)));
    }
    d.pointCount += pairs;
    return out;
  }

  // ── 채팅 / 정답 ──────────────────────────────────────────

  handleGuess(
    data: { roomName: string; text: unknown },
    client: WebSocket,
  ): void {
    const room = this.ctx.rooms.get(data.roomName);
    if (!room || !room.clients.has(client)) return;
    const playerId = room.playerIds.get(client);
    if (!playerId) return;
    const text = (typeof data.text === 'string' ? data.text : '')
      .trim()
      .slice(0, DrawingHandler.MAX_TEXT_LENGTH);
    if (!text) return;
    const nickname = room.nicknames.get(client) ?? '';
    const chat = { roomName: room.name, playerId, nickname, text };
    const d = room.drawing;

    // 그리기·맞히기 시간이 아니면 그냥 채팅
    if (!d || (d.phase !== 'draw' && d.phase !== 'guess') || !d.word) {
      this.ctx.broadcastToRoom(room.name, 'drawingChat', {
        ...chat,
        scope: 'all',
      });
      return;
    }

    const answer = normalize(d.word);
    const guess = normalize(text);

    if (playerId === d.drawerId) {
      if (guess.includes(answer)) {
        this.ctx.sendToClient(client, 'drawingBlocked', {
          roomName: room.name,
        });
        return;
      }
      this.ctx.broadcastToRoom(room.name, 'drawingChat', {
        ...chat,
        scope: 'all',
      });
      return;
    }

    // 이미 맞힌 사람의 말은 맞힌 사람과 그리는 사람에게만 (정답이 새지 않게)
    if (d.guessed.includes(playerId)) {
      const insiders = new Set([...d.guessed, d.drawerId]);
      for (const [c, pid] of room.playerIds) {
        if (insiders.has(pid))
          this.ctx.sendToClient(c, 'drawingChat', {
            ...chat,
            scope: 'guessed',
          });
      }
      return;
    }

    if (guess === answer) {
      this.acceptCorrect(room, d, playerId, nickname);
      return;
    }

    if (isClose(guess, answer)) {
      // 아까운 답은 다른 사람에게 큰 힌트라 보내지 않는다
      this.ctx.sendToClient(client, 'drawingClose', {
        roomName: room.name,
        text,
      });
      return;
    }
    this.ctx.broadcastToRoom(room.name, 'drawingChat', {
      ...chat,
      scope: 'all',
    });
  }

  private acceptCorrect(
    room: Room,
    d: DrawingState,
    playerId: string,
    nickname: string,
  ): void {
    // 빨리 맞힐수록 높다 (그리기+맞히기 시간 전체 기준 100 → 40).
    // 그린 사람도 같은 점수 — 일부러 못 알아보게 그리면 남을 막는 만큼 자기도 잃는다
    const totalMs = d.drawTimeSec * 1000 + DrawingHandler.GUESS_TIME_MS;
    const elapsed = (Date.now() - d.drawStartedAt) / totalMs;
    const gained = Math.max(40, Math.round(100 - 60 * Math.min(1, elapsed)));
    d.guessed.push(playerId);
    this.addScore(d, playerId, gained);
    this.addScore(d, d.drawerId, gained);

    this.ctx.broadcastToRoom(room.name, 'drawingCorrect', {
      roomName: room.name,
      playerId,
      nickname,
      gained,
      guessed: d.guessed,
      scores: Object.fromEntries(d.scores),
    });
    this.endTurn(room, 'correct');
  }

  private addScore(d: DrawingState, playerId: string, n: number): void {
    d.scores.set(playerId, (d.scores.get(playerId) ?? 0) + n);
    d.turnGains.set(playerId, (d.turnGains.get(playerId) ?? 0) + n);
  }

  // ── 연결 끊김 / 이탈 ─────────────────────────────────────

  handleDisconnect(room: Room, playerId: string): void {
    const d = room.drawing;
    if (!d) return;
    this.ctx.broadcastToRoom(room.name, 'drawingPresence', {
      roomName: room.name,
      playerId,
      connected: false,
    });
    if (d.phase === 'firstDraw') return; // 시간이 지나면 서버가 대신 뽑는다
    // 맞히기 시간에는 그릴 게 없으니 그리는 사람이 끊겨도 그대로 진행한다
    if (playerId === d.drawerId && (d.phase === 'choose' || d.phase === 'draw'))
      this.startDrawerAwayTimer(room);
  }

  handleReconnect(room: Room, playerId: string): void {
    const d = room.drawing;
    if (!d) return;
    if (playerId === d.drawerId && d.drawerAwayTimer) {
      clearTimeout(d.drawerAwayTimer);
      d.drawerAwayTimer = undefined;
    }
    this.ctx.broadcastToRoom(room.name, 'drawingPresence', {
      roomName: room.name,
      playerId,
      connected: true,
    });
  }

  private startDrawerAwayTimer(room: Room): void {
    const d = room.drawing!;
    if (d.drawerAwayTimer) clearTimeout(d.drawerAwayTimer);
    const drawerId = d.drawerId;
    d.drawerAwayTimer = setTimeout(() => {
      d.drawerAwayTimer = undefined;
      if (
        room.drawing === d &&
        d.drawerId === drawerId &&
        (d.phase === 'choose' || d.phase === 'draw')
      )
        this.endTurn(room, 'drawerAway');
    }, DrawingHandler.DRAWER_AWAY_MS);
  }

  handlePlayerLeft(room: Room, playerId: string): void {
    const d = room.drawing;
    if (!d) return;
    if (room.clients.size === 0) {
      this.clearTurnTimers(d);
      room.drawing = undefined;
      return;
    }
    if (room.clients.size < 2) {
      this.finishGame(room, 'notEnough');
      return;
    }
    if (d.phase === 'firstDraw') {
      // 남은 사람이 다 뽑았으면 바로 결과로
      if (!d.firstDrawDone) {
        d.firstDraw.delete(playerId);
        this.checkFirstDrawDone(room, d);
      }
      return;
    }
    // 맞히기 시간이면 그림은 이미 다 그려졌으니 그대로 맞히게 둔다
    if (playerId === d.drawerId && (d.phase === 'choose' || d.phase === 'draw'))
      this.endTurn(room, 'drawerLeft');
  }

  // ── 종료 ─────────────────────────────────────────────────

  private finishGame(room: Room, reason: 'finished' | 'notEnough'): void {
    const d = room.drawing;
    if (!d) return;
    this.clearTurnTimers(d);

    const sorted = Array.from(d.scores.entries()).sort((a, b) => b[1] - a[1]);
    const ranking = sorted.map(([playerId, score]) => ({
      playerId,
      nickname: d.nicknames.get(playerId) ?? '',
      score,
      rank: sorted.findIndex(([, s]) => s === score) + 1,
    }));
    room.drawingGameOverResult = { reason, ranking };
    room.drawing = undefined;
    room.gameStarted = false;
    room.gameFinished = true;

    this.ctx.broadcastToRoom(room.name, 'drawingGameOver', {
      roomName: room.name,
      reason,
      ranking,
    });
    console.log(
      `[Drawing] '${room.name}' finished (${reason}) | ${ranking.map((r) => `${r.nickname} ${r.score}`).join(', ')}`,
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
          extra: {
            totalRounds: d.totalRounds,
            totalTurns: d.totalTurns,
            ranking,
          },
        });
      }
    }
  }

  private clearTurnTimers(d: DrawingState): void {
    if (d.timer) clearTimeout(d.timer);
    d.timer = undefined;
    d.hintTimers.forEach((t) => clearTimeout(t));
    d.hintTimers = [];
    if (d.drawerAwayTimer) clearTimeout(d.drawerAwayTimer);
    d.drawerAwayTimer = undefined;
  }

  private createDbSession(
    room: Room,
    players: { playerId: string; nickname: string }[],
  ): void {
    this.supabase
      .createSession(
        {
          roomName: room.name,
          gameType: 'drawing',
          playerCount: players.length,
        },
        new Date(),
      )
      .then((sessionId) => {
        if (!sessionId) return;
        // 아주 짧은 게임이면 세션이 만들어지기 전에 끝났을 수 있다
        if (!room.drawing) return;
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
      .catch((e) => console.error('[Drawing] DB 세션 생성 실패', e));
  }

  // ── 재연결 ───────────────────────────────────────────────

  buildDrawingState(room: Room, playerId: string): Record<string, unknown> {
    if (room.gameType !== 'drawing') return {};
    const d = room.drawing;
    if (!d)
      return {
        drawing: null,
        drawingGameOver: room.drawingGameOverResult ?? null,
      };
    const isDrawer = playerId === d.drawerId;
    return {
      drawing: {
        totalRounds: d.totalRounds,
        drawTimeSec: d.drawTimeSec,
        turnNumber: d.turnNumber,
        totalTurns: d.totalTurns,
        turnOrder: d.turnOrder,
        firstDraw: Object.fromEntries(d.firstDraw),
        firstPlayerId:
          d.phase === 'firstDraw' && d.firstDrawDone ? d.nextDrawerId : null,
        nextDrawerId: d.phase === 'reveal' ? d.nextDrawerId : null,
        phase: d.phase,
        drawerId: d.drawerId,
        word: isDrawer || d.phase === 'reveal' ? d.word : null,
        choices: isDrawer && d.phase === 'choose' ? d.choices : null,
        hint: d.hint,
        strokes: d.strokes,
        guessed: d.guessed,
        scores: Object.fromEntries(d.scores),
        gains: d.phase === 'reveal' ? Object.fromEntries(d.turnGains) : null,
        timeLeftMs: Math.max(0, d.phaseEndsAt - Date.now()),
        away: Array.from(room.disconnectTimers.keys()),
      },
      drawingGameOver: null,
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

// ── 문자열 도우미 ─────────────────────────────────────────

const CHOSUNG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

function chosungOf(ch: string): string {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return ch;
  return CHOSUNG[Math.floor(code / 588)];
}

function normalize(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

/** 한 글자만 다르거나 빠지거나 더 있을 때 */
function isClose(a: string, b: string): boolean {
  const x = Array.from(a);
  const y = Array.from(b);
  if (y.length < 2 || Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (x.length > y.length) i++;
    else if (x.length < y.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (x.length - i) + (y.length - j) === 1;
}
