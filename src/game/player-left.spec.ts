import { WebSocket } from 'ws';
import { GameContext } from './game.context';
import { GameEngineFactory } from './game-engine.factory';
import { Room } from './game.types';
import { CasinoHandler } from './games/casino/casino.handler';
import { GangHandler } from './games/gang/gang.handler';
import { SkulkingHandler } from './games/skulking/skulking.handler';
import { SpiceHandler } from './games/spice/spice.handler';
import {
  addRoom,
  card,
  errors,
  fakeDb,
  fakeSocket,
  receivedEvent,
} from '../../test/game-test-utils';

const R = 'room';

describe('플레이어 이탈과 게임별 진행', () => {
  let ctx: GameContext;
  let a: WebSocket;
  let b: WebSocket;
  let c: WebSocket;

  const threePlayers = (gameType: string): Room =>
    addRoom(ctx, R, gameType, [
      [a, 'A'],
      [b, 'B'],
      [c, 'C'],
    ]);

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = new GameContext();
    a = fakeSocket();
    b = fakeSocket();
    c = fakeSocket();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('공통', () => {
    it('방장이 나가면 다음 사람에게 넘기고 userLeft로 알린다', () => {
      const room = threePlayers('gang');
      ctx.leaveRoom(a, R);
      expect(room.hostPlayerId).toBe('B');
      expect(room.hostNickname).toBe('nick-B');
      expect(receivedEvent(c, 'userLeft')[0].data.hostPlayerId).toBe('B');
    });

    it('끊겨서 유예 중인 사람보다 접속 중인 사람에게 넘긴다', () => {
      const room = threePlayers('gang');
      (b as any).readyState = WebSocket.CLOSED;
      ctx.leaveRoom(a, R);
      expect(room.hostPlayerId).toBe('C');
    });

    it('방장이 아닌 사람이 나가면 방장은 그대로다', () => {
      const room = threePlayers('gang');
      ctx.leaveRoom(b, R);
      expect(room.hostPlayerId).toBe('A');
    });

    it('재연결해도 플레이어 순서가 바뀌지 않는다', () => {
      const room = threePlayers('gang');
      const next = fakeSocket();
      ctx.replaceClient(room, a, next);
      expect(ctx.getPlayersWithOrder(room).map((p) => p.playerId)).toEqual(['A', 'B', 'C']);
      expect(Array.from(room.clients)[0]).toBe(next);
    });

    it('클라이언트에 보내는 덱은 장수만 같고 내용이 없다', () => {
      const room = threePlayers('gang');
      room.state.deck = [card('hearts', 1), card('clubs', 2)];
      const hidden = ctx.hiddenDeck(room);
      expect(hidden).toHaveLength(2);
      expect(hidden.some((x) => x.value !== 0)).toBe(false);
    });
  });

  describe('갱스터', () => {
    let handler: GangHandler;
    let room: Room;

    const leave = (sock: WebSocket, id: string) => {
      ctx.leaveRoom(sock, R);
      handler.handlePlayerLeft(room, id);
    };

    beforeEach(() => {
      handler = new GangHandler(ctx, new GameEngineFactory([]), fakeDb());
      room = threePlayers('gang');
    });

    it('방장이 아니면 시작할 수 없다', async () => {
      await handler.handleStartGame({ roomName: R }, b);
      expect(errors(b)).toEqual(['방장만 게임을 시작할 수 있습니다']);
      expect(room.gameStarted).toBe(false);
    });

    it('진행 중인 매치는 다시 시작할 수 없다', async () => {
      room.gameStarted = true;
      await handler.handleStartGame({ roomName: R }, a);
      expect(errors(a)).toEqual(['이미 게임이 진행 중입니다']);
    });

    it('나머지가 모두 준비한 상태에서 한 명이 나가면 다음 단계로 넘어간다', () => {
      room.gameStarted = true;
      room.state.chips = [
        { number: 1, state: 0, owner: 'A' },
        { number: 2, state: 0, owner: 'B' },
        { number: 3, state: 0, owner: 'C' },
      ];
      room.state.playerReady = new Set(['A', 'B']);
      leave(c, 'C');
      expect(room.state.currentStep).toBe(2);
    });

    it('준비하고 나간 사람은 집계에서 빠져 남은 사람을 건너뛰지 않는다', () => {
      room.gameStarted = true;
      room.state.chips = [{ number: 1, state: 0, owner: 'A' }];
      room.state.playerReady = new Set(['A', 'B']);
      leave(a, 'A');
      expect(Array.from(room.state.playerReady)).toEqual(['B']);
      expect(room.state.currentStep).toBe(1);
      expect(room.state.chips[0].owner).toBeNull();
    });

    it('다음 라운드를 기다리던 사람이 나가면 새 라운드를 시작한다', () => {
      const deal = jest.fn();
      (handler as any).dealNewRound = deal;
      room.gameStarted = true;
      room.gameFinished = true;
      room.state.nextRoundReady = new Set(['A', 'B']);
      leave(c, 'C');
      expect(deal).toHaveBeenCalledTimes(1);
    });

    it('혼자 남으면 게임을 접고 대기 상태로 돌아간다', () => {
      const deal = jest.fn();
      (handler as any).dealNewRound = deal;
      room.gameStarted = true;
      room.gameFinished = true;
      room.state.nextRoundReady = new Set(['A']);
      leave(c, 'C');
      leave(b, 'B');
      expect(deal).not.toHaveBeenCalled();
      expect(room.gameStarted).toBe(false);
      expect(receivedEvent(a, 'gangGameCancelled')).toHaveLength(1);
    });

    it('라운드가 끝난 뒤의 칩 선택과 준비는 무시한다', () => {
      room.gameStarted = true;
      room.gameFinished = true;
      room.state.chips = [{ number: 1, state: 0, owner: null }];
      handler.handleSelectChip({ roomName: R, chipNumber: 1 }, a);
      expect(room.state.chips[0].owner).toBeNull();
    });

    it('운영 환경에서는 testSuccess를 받지 않는다', () => {
      const finish = jest.fn();
      (handler as any).finishGame = finish;
      room.gameStarted = true;
      handler.handleTestSuccess({ roomName: R }, a);
      expect(finish).not.toHaveBeenCalled();
    });

    describe('스트레이트 판정', () => {
      const evaluate = (my: [string, number][], open: [string, number][]) =>
        (handler as any).evaluateHand(
          my.map(([t, v]) => card(t, v)),
          open.map(([t, v]) => card(t, v)),
        );

      it('같은 숫자가 섞여도 스트레이트로 판정한다', () => {
        const result = evaluate(
          [['spades', 7], ['hearts', 7]],
          [['diamonds', 5], ['clubs', 6], ['hearts', 8], ['spades', 9], ['clubs', 13]],
        );
        expect(result.detailName).toBe('9 탑 스트레이트');
      });

      it('스트레이트에 안 쓰인 높은 카드는 탑이 아니다', () => {
        const open: [string, number][] = [
          ['clubs', 7], ['diamonds', 8], ['hearts', 9], ['spades', 10], ['clubs', 1],
        ];
        expect(evaluate([['diamonds', 6], ['clubs', 2]], open).detailName).toBe('10 탑 스트레이트');
        expect(evaluate([['hearts', 11], ['spades', 5]], open).detailName).toBe('J 탑 스트레이트');
      });

      it('백스트레이트의 탑은 5다', () => {
        const result = evaluate(
          [['spades', 1], ['hearts', 2]],
          [['diamonds', 3], ['clubs', 4], ['hearts', 5], ['spades', 9], ['clubs', 13]],
        );
        expect(result.tiebreakers).toEqual([5]);
      });
    });
  });

  describe('향신료', () => {
    let handler: SpiceHandler;
    let db: any;
    let room: Room;

    const leave = (sock: WebSocket, id: string) => {
      const left = ctx.leaveRoom(sock, R)!;
      handler.handlePlayerLeft(room, id, left.orderIndex);
    };

    beforeEach(() => {
      db = fakeDb();
      handler = new SpiceHandler(ctx, new GameEngineFactory([]), db);
      room = threePlayers('spice');
    });

    it('안 뽑은 사람이 나가면 선뽑기를 마친다', () => {
      handler.handleStartGame({ roomName: R }, a);
      handler.handleDrawFirstCard({ roomName: R }, a);
      handler.handleDrawFirstCard({ roomName: R }, b);
      leave(c, 'C');
      expect(receivedEvent(a, 'firstDrawFinished')).toHaveLength(1);
    });

    it('뽑고 나간 사람은 선 후보에서 빠진다', () => {
      handler.handleStartGame({ roomName: R }, a);
      handler.handleDrawFirstCard({ roomName: R }, a);
      leave(a, 'A');
      handler.handleDrawFirstCard({ roomName: R }, b);
      expect(receivedEvent(b, 'firstDrawFinished')).toHaveLength(0);
      handler.handleDrawFirstCard({ roomName: R }, c);
      const finished = receivedEvent(b, 'firstDrawFinished')[0].data;
      expect(Object.keys(finished.results).sort()).toEqual(['B', 'C']);
    });

    it('시간이 지나면 안 뽑은 사람을 서버가 대신 뽑는다', () => {
      handler.handleStartGame({ roomName: R }, a);
      jest.advanceTimersByTime(20000);
      expect(receivedEvent(a, 'firstDrawFinished')).toHaveLength(1);
    });

    it('선뽑기 중 혼자 남으면 취소한다', () => {
      handler.handleStartGame({ roomName: R }, a);
      leave(c, 'C');
      leave(b, 'B');
      expect(receivedEvent(a, 'firstDrawCancelled')).toHaveLength(1);
      expect(room.state.firstDraw).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('턴 주인이 나가면 순서상 다음 사람에게 바로 넘긴다', () => {
      room.gameStarted = true;
      room.state.currentTurnPlayerId = 'B';
      leave(b, 'B');
      expect(room.state.currentTurnPlayerId).toBe('C');
      expect(receivedEvent(a, 'cardPassed')[0].data.currentTurnPlayerId).toBe('C');
    });

    it('도전 페이즈의 다음 차례가 나가면 그다음 사람으로 바꾼다', () => {
      room.gameStarted = true;
      room.state.currentTurnPlayerId = 'A';
      room.state.challengePhase = {
        playerId: 'A',
        playedCard: card('pepper', 1),
        declaredSuit: 'pepper',
        declaredNumber: 1,
        nextPlayerId: 'B',
        timer: setTimeout(() => undefined, 5000),
        startedAt: Date.now(),
      };
      leave(b, 'B');
      expect(room.state.challengePhase?.nextPlayerId).toBe('C');
    });

    it('카드를 낸 사람이 나가면 도전 없이 다음 턴으로 넘어간다', () => {
      room.gameStarted = true;
      room.state.tableStack = [];
      room.state.currentTurnPlayerId = 'A';
      room.state.challengePhase = {
        playerId: 'A',
        playedCard: card('pepper', 1),
        declaredSuit: 'pepper',
        declaredNumber: 1,
        nextPlayerId: 'B',
        timer: setTimeout(() => undefined, 5000),
        startedAt: Date.now(),
      };
      leave(a, 'A');
      expect(room.state.challengePhase).toBeNull();
      expect(room.state.currentTurnPlayerId).toBe('B');
    });

    it('혼자 남으면 게임을 끝낸다', () => {
      room.gameStarted = true;
      room.state.currentTurnPlayerId = 'A';
      leave(c, 'C');
      leave(b, 'B');
      expect(receivedEvent(a, 'spiceGameOver')[0].data.reason).toBe('playerLeft');
      expect(room.gameStarted).toBe(false);
    });

    it('순위는 턴 순서가 아니라 점수로 저장한다', () => {
      db.finalizePlayerResult = jest.fn();
      room.gameStarted = true;
      room.supabaseSessionId = 'session';
      room.state.hands.set(a, [card('pepper', 1), card('pepper', 2)]);
      (handler as any).finishSpiceGame(R, {}, 'deck');
      const ranks = Object.fromEntries(
        db.finalizePlayerResult.mock.calls.map(([r]: any[]) => [r.userId, r.rank]),
      );
      expect(ranks).toEqual({ A: 3, B: 1, C: 1 });
    });

    it('게임 종료 처리는 한 번만 한다', () => {
      room.gameStarted = true;
      (handler as any).finishSpiceGame(R, {}, 'deck');
      (handler as any).finishSpiceGame(R, {}, 'deck');
      expect(receivedEvent(a, 'spiceGameOver')).toHaveLength(1);
    });

    it('종료된 게임의 카드 내기는 무시한다', () => {
      room.state.currentTurnPlayerId = 'A';
      room.state.hands.set(a, [card('pepper', 1)]);
      handler.handlePlayCard(
        { roomName: R, cardIndex: 0, declaredSuit: 'pepper', declaredNumber: 1 },
        a,
      );
      expect(room.state.hands.get(a)).toHaveLength(1);
      expect(room.state.challengePhase).toBeFalsy();
    });

    it.each([
      ['다른 향신료', 'saffron', 5, '같은 향신료로 선언해야 합니다'],
      ['범위 초과', 'pepper', 11, '유효하지 않은 선언입니다'],
      ['소수', 'pepper', 4.5, '유효하지 않은 선언입니다'],
    ])('%s 선언을 거부한다', (_name, suit, number, message) => {
      room.gameStarted = true;
      room.state.currentTurnPlayerId = 'A';
      room.state.currentSuit = 'pepper';
      room.state.currentNumber = 3;
      room.state.hands.set(a, [card('pepper', 1)]);
      handler.handlePlayCard(
        { roomName: R, cardIndex: 0, declaredSuit: suit, declaredNumber: number },
        a,
      );
      expect(errors(a)).toEqual([message]);
    });
  });

  describe('스컬킹', () => {
    let handler: SkulkingHandler;
    let room: Room;

    const leave = (sock: WebSocket, id: string) => {
      ctx.leaveRoom(sock, R);
      handler.handlePlayerLeft(room, id);
    };

    const startTrick = (turnIndex: number) => {
      const order = ['A', 'B', 'C'];
      room.gameStarted = true;
      room.state.skulkingRound = 3;
      room.state.skulkingPhase = 'play';
      room.state.skulkingTrickOrder = order;
      room.state.skulkingTrickIndex = turnIndex;
      room.state.skulkingCurrentPlayerId = order[turnIndex];
      room.state.currentTrick = order.slice(0, turnIndex).map((playerId, i) => ({
        playerId,
        card: card('sk-yellow', i + 1),
      }));
      room.state.tricks = new Map(order.map((id) => [id, 0]));
      room.state.bids = new Map(order.map((id) => [id, 1]));
      room.state.scores = new Map(order.map((id) => [id, 0]));
      room.state.roundScores = new Map(order.map((id) => [id, []]));
      room.state.pendingBonus = new Map();
      room.state.skulkingTrickCount = 0;
      (handler as any).startPlayTimer(room);
    };

    beforeEach(() => {
      handler = new SkulkingHandler(ctx, new GameEngineFactory([]), fakeDb());
      room = threePlayers('skulking');
    });

    it('차례인 사람이 나가면 다음 사람 차례로 넘긴다', () => {
      startTrick(1);
      leave(b, 'B');
      expect(room.state.skulkingCurrentPlayerId).toBe('C');
      expect(room.state.skulkingTrickOrder).toEqual(['A', 'C']);
      expect(room.state.skulkingPlayTimer).toBeDefined();
    });

    it('이미 낸 사람이 나가면 현재 차례를 유지한다', () => {
      startTrick(2);
      leave(a, 'A');
      expect(room.state.skulkingCurrentPlayerId).toBe('C');
      expect(room.state.skulkingTrickIndex).toBe(1);
    });

    it('마지막 차례가 나가면 낸 카드로 트릭을 끝낸다', () => {
      startTrick(2);
      leave(c, 'C');
      expect(receivedEvent(a, 'skulkingTrickResult')).toHaveLength(1);
    });

    it('거부된 카드 요청은 자동 제출 타이머를 지우지 않는다', () => {
      startTrick(0);
      room.state.hands.set(b, [card('sk-yellow', 1)]);
      const timer = room.state.skulkingPlayTimer;
      handler.handlePlayCard({ roomName: R, cardIndex: 0 }, b);
      expect(errors(b)).toEqual(['지금 카드 낼 차례가 아닙니다']);
      expect(room.state.skulkingPlayTimer).toBe(timer);
    });

    it('트릭이 끝난 뒤 같은 사람이 또 내도 이중 집계하지 않는다', () => {
      startTrick(2);
      room.state.hands.set(c, [card('sk-yellow', 9), card('sk-yellow', 8)]);
      handler.handlePlayCard({ roomName: R, cardIndex: 0 }, c);
      handler.handlePlayCard({ roomName: R, cardIndex: 0 }, c);
      expect(receivedEvent(a, 'skulkingTrickResult')).toHaveLength(1);
      expect(room.state.skulkingTrickCount).toBe(1);
    });

    it('비드 대기 중 안 낸 사람이 나가면 플레이를 시작한다', () => {
      room.gameStarted = true;
      room.state.skulkingRound = 1;
      room.state.skulkingPhase = 'bid';
      room.state.bids = new Map([['A', 0], ['B', 1]]);
      leave(c, 'C');
      expect(room.state.skulkingPhase).toBe('play');
    });

    it('비드하고 나간 사람은 집계에서 뺀다', () => {
      room.gameStarted = true;
      room.state.skulkingRound = 1;
      room.state.skulkingPhase = 'bid';
      room.state.bids = new Map([['A', 0]]);
      leave(a, 'A');
      handler.handleBid({ roomName: R, bid: 0 }, b);
      expect(room.state.skulkingPhase).toBe('bid');
    });

    it('숫자가 아닌 비드를 거부한다', () => {
      room.gameStarted = true;
      room.state.skulkingRound = 3;
      room.state.skulkingPhase = 'bid';
      room.state.bids = new Map();
      handler.handleBid({ roomName: R, bid: 'abc' as unknown as number }, a);
      expect(room.state.bids.size).toBe(0);
    });

    it('안 뽑은 사람이 나가면 선뽑기를 마친다', async () => {
      await handler.handleStartGame({ roomName: R }, a);
      handler.handleFirstDraw({ roomName: R }, a);
      handler.handleFirstDraw({ roomName: R }, b);
      leave(c, 'C');
      expect(receivedEvent(a, 'skulkingFirstDrawFinished')).toHaveLength(1);
    });

    it('혼자 남으면 게임을 끝낸다', () => {
      startTrick(0);
      leave(c, 'C');
      leave(b, 'B');
      expect(receivedEvent(a, 'skulkingGameOver')).toHaveLength(1);
    });

    describe('재시작', () => {
      const finishPreviousGame = () => {
        room.gameStarted = true;
        room.state.skulkingRound = 10;
        room.state.scores = new Map([['A', 10], ['B', 20], ['C', 0]]);
        room.state.roundScores = new Map();
        room.state.roundBidTrickHistory = [];
        (handler as any).endGame(R);
      };

      it('재시작하면 이전 판 라운드를 지운다', async () => {
        finishPreviousGame();
        await handler.handleStartGame({ roomName: R }, a);
        expect(room.state.skulkingRound).toBeUndefined();
      });

      it('재시작 선뽑기 중에는 skulkingNextRound를 무시한다', async () => {
        const startNewRound = jest.fn();
        (handler as any).startNewRound = startNewRound;
        finishPreviousGame();
        await handler.handleStartGame({ roomName: R }, a);
        handler.handleNextRound({ roomName: R }, a);
        expect(startNewRound).not.toHaveBeenCalled();
      });

      it('이전 판의 종료 대기 타이머가 새 판을 끝내지 않는다', async () => {
        room.gameStarted = true;
        room.state.skulkingRound = 10;
        room.state.bids = new Map([['A', 0], ['B', 0], ['C', 0]]);
        room.state.tricks = new Map();
        room.state.scores = new Map();
        room.state.roundScores = new Map();
        room.state.roundBidTrickHistory = [];
        (handler as any).endRound(R);
        leave(c, 'C');
        (handler as any).endGame(R);
        await handler.handleStartGame({ roomName: R }, a);
        const before = receivedEvent(a, 'skulkingGameOver').length;
        jest.advanceTimersByTime(5000);
        expect(receivedEvent(a, 'skulkingGameOver')).toHaveLength(before);
        expect(room.gameStarted).toBe(true);
      });

      it('종료 결과는 그 판을 한 사람에게만 복원한다', () => {
        finishPreviousGame();
        expect(handler.buildSkulkingState(room, 'A')).toHaveProperty('skulkingGameOverResult');
        expect(handler.buildSkulkingState(room, 'newcomer')).not.toHaveProperty(
          'skulkingGameOverResult',
        );
      });
    });

    it('선뽑기 중 혼자 남으면 취소하고 대기 상태로 돌아간다', async () => {
      await handler.handleStartGame({ roomName: R }, a);
      leave(c, 'C');
      leave(b, 'B');
      expect(receivedEvent(a, 'skulkingFirstDrawCancelled')).toHaveLength(1);
      expect(room.gameStarted).toBe(false);
      expect(room.state.skulkingFirstDraw).toBeUndefined();
    });

    it('결과 발표 후 2초 사이 혼자 남으면 본 게임을 시작하지 않는다', async () => {
      await handler.handleStartGame({ roomName: R }, a);
      leave(c, 'C');
      handler.handleFirstDraw({ roomName: R }, a);
      handler.handleFirstDraw({ roomName: R }, b);
      expect(receivedEvent(a, 'skulkingFirstDrawFinished')).toHaveLength(1);
      leave(b, 'B');
      expect(() => jest.advanceTimersByTime(2000)).not.toThrow();
      expect(room.state.skulkingRound).toBeUndefined();
    });

    it('카드를 내고 나간 사람도 트릭 결과에 닉네임으로 나온다', () => {
      startTrick(1);
      room.state.hands.set(b, [card('sk-yellow', 13)]);
      handler.handlePlayCard({ roomName: R, cardIndex: 0 }, b);
      leave(b, 'B');
      room.state.hands.set(c, [card('sk-yellow', 2)]);
      handler.handlePlayCard({ roomName: R, cardIndex: 0 }, c);
      const trick = receivedEvent(a, 'skulkingTrickResult')[0].data;
      expect(trick.winnerNickname).toBe('nick-B');
    });

    it('방이 없어지면 타이머를 모두 끝낸다', () => {
      startTrick(0);
      leave(a, 'A');
      leave(b, 'B');
      leave(c, 'C');
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('카지노', () => {
    let handler: CasinoHandler;
    let room: Room;

    beforeEach(async () => {
      handler = new CasinoHandler(ctx, fakeDb());
      room = threePlayers('casino');
      await handler.handleStart({ roomName: R, timeLimit: 300, initialBalance: 1000 }, a);
    });

    it('방이 없어지면 시간 제한 타이머를 끝낸다', () => {
      for (const [sock, id] of [[a, 'A'], [b, 'B'], [c, 'C']] as [WebSocket, string][]) {
        ctx.leaveRoom(sock, R);
        handler.handlePlayerLeft(room, id);
      }
      expect(room.casinoTimer).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('같은 이름의 새 방은 옛 타이머로 끝나지 않는다', () => {
      ctx.rooms.delete(R);
      const next = addRoom(ctx, R, 'casino', [[b, 'B']]);
      next.gameStarted = true;
      jest.advanceTimersByTime(300_000);
      expect(next.gameStarted).toBe(true);
    });

    it('시간 종료 때 결과가 안 온 베팅금은 돌려준다', () => {
      handler.handleSwitchGame({ roomName: R, game: 'roulette' }, a);
      handler.handleBetPlace({ roomName: R, amount: 500 }, a);
      jest.advanceTimersByTime(300_000);
      const players = receivedEvent(a, 'casinoGameOver')[0].data.players;
      expect(players.find((p: any) => p.playerId === 'A').finalBalance).toBe(1000);
    });

    it('최소 베팅액보다 적은 잔액이면 초기금 5% 이상이어도 대출할 수 있다', () => {
      room.state.casinoBalances!.set('A', 60);
      handler.handleLoan({ roomName: R, amount: 100 }, a);
      expect(errors(a)).toEqual([]);
      expect(room.state.casinoBalances!.get('A')).toBe(160);
    });

    it('종료 후 재연결하면 결과를 다시 받는다', () => {
      jest.advanceTimersByTime(300_000);
      expect(handler.buildCasinoState(room, 'A')).toHaveProperty('casinoLastResult');
    });

    it('그 판을 하지 않은 사람에게는 결과를 보내지 않는다', () => {
      jest.advanceTimersByTime(300_000);
      expect(handler.buildCasinoState(room, 'newcomer')).not.toHaveProperty('casinoLastResult');
    });

    it('이탈로 필요한 표 수가 줄면 다시 계산해 종료한다', () => {
      const d = fakeSocket();
      room.clients.add(d);
      room.playerIds.set(d, 'D');
      room.nicknames.set(d, 'nick-D');
      room.state.casinoVotes = new Set(['A', 'B']);
      ctx.leaveRoom(d, R);
      handler.handlePlayerLeft(room, 'D');
      expect(receivedEvent(a, 'casinoGameOver')).toHaveLength(1);
    });
  });
});
