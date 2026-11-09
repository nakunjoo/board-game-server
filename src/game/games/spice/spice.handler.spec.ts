import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { GameEngineFactory } from '../../game-engine.factory';
import { Room } from '../../game.types';
import { SpiceHandler } from './spice.handler';
import {
  addRoom,
  card,
  errors,
  fakeDb,
  fakeSocket,
  receivedEvent,
} from '../../../../test/game-test-utils';

const TURN_TIMEOUT = SpiceHandler.TURN_TIME_MS + 1500; // TURN_TIMEOUT_GRACE_MS 포함

describe('SpiceHandler 턴·도전 타이밍', () => {
  let ctx: GameContext;
  let handler: SpiceHandler;
  let a: WebSocket;
  let b: WebSocket;
  let c: WebSocket;
  let room: Room;
  const R = 'room';

  /** 진행 중인 게임 상태를 직접 구성하고 a의 턴을 시작한다 */
  function startGameWithTurn(turnOf: WebSocket) {
    room.gameStarted = true;
    room.state.deck = Array.from({ length: 20 }, (_, i) => card('pepper', (i % 10) + 1));
    for (const s of [a, b, c]) {
      room.state.hands.set(s, [card('pepper', 5), card('cinnamon', 7)]);
    }
    room.state.currentTurnPlayerId = room.playerIds.get(turnOf);
    room.state.currentSuit = null;
    room.state.currentNumber = 0;
    room.state.tableStack = [];
    room.state.trophies = new Map();
    room.state.wonCards = new Map();
    (handler as any).startTurn(R, room);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    ctx = new GameContext();
    handler = new SpiceHandler(ctx, new GameEngineFactory([]), fakeDb());
    a = fakeSocket();
    b = fakeSocket();
    c = fakeSocket();
    room = addRoom(ctx, R, 'spice', [
      [a, 'A'],
      [b, 'B'],
      [c, 'C'],
    ]);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('서버 턴 타이머', () => {
    it('턴 주인이 아무것도 안 하면 서버가 자동 패스한다 (클라이언트가 멈춰도 판이 안 멈춤)', () => {
      startGameWithTurn(a);
      jest.advanceTimersByTime(TURN_TIMEOUT - 1);
      expect(room.state.currentTurnPlayerId).toBe('A');

      jest.advanceTimersByTime(1);
      expect(room.state.currentTurnPlayerId).toBe('B');
      expect(room.state.hands.get(a)).toHaveLength(3); // 패스 패널티 1장
      const passed = receivedEvent(b, 'cardPassed');
      expect(passed).toHaveLength(1);
      expect(passed[0].data).toMatchObject({ playerId: 'A', auto: true, currentTurnPlayerId: 'B' });
    });

    it('자동 패스는 다음 턴에도 계속 이어진다', () => {
      startGameWithTurn(a);
      jest.advanceTimersByTime(TURN_TIMEOUT);
      jest.advanceTimersByTime(TURN_TIMEOUT);
      expect(room.state.currentTurnPlayerId).toBe('C');
    });

    it('직접 패스하면 이전 턴의 타이머는 취소되고 새 턴 기준으로 다시 잰다', () => {
      startGameWithTurn(a);
      jest.advanceTimersByTime(20_000);
      handler.handlePass({ roomName: R }, a);
      expect(room.state.currentTurnPlayerId).toBe('B');

      // A 기준이었다면 여기서 자동 패스가 났을 시점
      jest.advanceTimersByTime(TURN_TIMEOUT - 20_000);
      expect(room.state.currentTurnPlayerId).toBe('B');
      jest.advanceTimersByTime(20_000);
      expect(room.state.currentTurnPlayerId).toBe('C');
    });

    it('자동 패스 직후 도착한 구버전 클라이언트의 늦은 pass는 에러 없이 무시한다', () => {
      startGameWithTurn(a);
      jest.advanceTimersByTime(TURN_TIMEOUT);
      handler.handlePass({ roomName: R }, a);
      expect(errors(a)).toEqual([]);
      expect(room.state.currentTurnPlayerId).toBe('B'); // B의 턴을 건드리지 않음
    });

    it('턴 주인이 방에서 빠지면 남은 첫 사람에게 턴을 넘긴다', () => {
      startGameWithTurn(b);
      room.state.playerOrder = room.state.playerOrder.filter((s) => s !== b);
      room.playerIds.delete(b);
      jest.advanceTimersByTime(TURN_TIMEOUT);
      expect(room.state.currentTurnPlayerId).toBe('A');
    });

    it('게임이 끝나면 타이머가 더 돌지 않는다', () => {
      startGameWithTurn(a);
      room.state.deck = [];
      handler.handlePass({ roomName: R }, a); // 덱 소진 → 게임 종료
      expect(room.gameStarted).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('도전 페이즈', () => {
    const play = (s: WebSocket) =>
      handler.handlePlayCard(
        { roomName: R, cardIndex: 0, declaredSuit: 'pepper', declaredNumber: 2 }, // 리셋 상태라 1~3만 가능
        s,
      );

    it('카드를 내면 턴 타이머가 멈춘다 (도전 중엔 자동 패스 없음)', () => {
      startGameWithTurn(a);
      jest.advanceTimersByTime(TURN_TIMEOUT - 1000);
      play(a);
      jest.advanceTimersByTime(2000); // A의 원래 턴 마감을 지나침
      expect(receivedEvent(a, 'cardPassed')).toHaveLength(0);
    });

    it('도전 페이즈 broadcast에 서버 제한시간이 실려 간다', () => {
      startGameWithTurn(a);
      play(a);
      const [phase] = receivedEvent(b, 'challengePhase');
      expect(phase.data.challengeTimeLimitMs).toBe(SpiceHandler.CHALLENGE_TIME_MS);
    });

    it('도전 페이즈 중 카드 낸 사람의 pass는 거부한다', () => {
      startGameWithTurn(a);
      play(a);
      handler.handlePass({ roomName: R }, a);
      expect(errors(a)).toContain('도전 페이즈 중입니다');
      expect(room.state.hands.get(a)).toHaveLength(1); // 카드 1장 냈고, 패스 드로우 없음
    });

    it('만료 뒤 도착한 도전은 error가 아니라 challengeTooLate로 응답한다', () => {
      startGameWithTurn(a);
      play(a);
      jest.advanceTimersByTime(SpiceHandler.CHALLENGE_TIME_MS);
      handler.handleChallenge({ roomName: R, challengeType: 'number' }, b);
      expect(errors(b)).toEqual([]);
      expect(receivedEvent(b, 'challengeTooLate')).toHaveLength(1);
    });

    it('남이 먼저 도전해 닫힌 페이즈에 늦게 온 도전도 challengeTooLate', () => {
      startGameWithTurn(a);
      play(a);
      handler.handleChallenge({ roomName: R, challengeType: 'number' }, b);
      handler.handleChallenge({ roomName: R, challengeType: 'suit' }, c);
      expect(errors(c)).toEqual([]);
      expect(receivedEvent(c, 'challengeTooLate')).toHaveLength(1);
    });

    it('만료되면 다음 사람의 턴이 시작되고 그 턴도 서버가 잰다', () => {
      startGameWithTurn(a);
      play(a);
      jest.advanceTimersByTime(SpiceHandler.CHALLENGE_TIME_MS);
      expect(room.state.currentTurnPlayerId).toBe('B');
      jest.advanceTimersByTime(TURN_TIMEOUT);
      expect(room.state.currentTurnPlayerId).toBe('C');
    });
  });
});
