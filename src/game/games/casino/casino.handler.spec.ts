import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { Room } from '../../game.types';
import { CasinoHandler } from './casino.handler';
import { addRoom, errors, fakeDb, fakeSocket, receivedEvent } from '../../../../test/game-test-utils';

describe('CasinoHandler 서버 검증', () => {
  let ctx: GameContext;
  let handler: CasinoHandler;
  let host: WebSocket;
  let guest: WebSocket;
  let room: Room;
  const R = 'room';

  const balanceOf = (id: string) => room.state.casinoBalances!.get(id);

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ctx = new GameContext();
    handler = new CasinoHandler(ctx, fakeDb(['admin']));
    host = fakeSocket();
    guest = fakeSocket();
    room = addRoom(ctx, R, 'casino', [
      [host, 'admin'],
      [guest, 'p2'],
    ]);
    await handler.handleStart({ roomName: R, timeLimit: 300, initialBalance: 10_000 }, host);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('시작 설정', () => {
    it('UI에 없는 초기 자금은 거부한다', async () => {
      const r2 = addRoom(ctx, 'r2', 'casino', [[fakeSocket(), 'h']]);
      const h = [...r2.clients][0];
      await handler.handleStart({ roomName: 'r2', timeLimit: 300, initialBalance: 1e12 }, h);
      expect(r2.gameStarted).toBe(false);
      expect(errors(h)).toContain('허용되지 않은 초기 자금입니다');
    });

    it('UI에 없는 게임 시간(무제한 포함)은 거부한다', async () => {
      const r2 = addRoom(ctx, 'r2', 'casino', [[fakeSocket(), 'h']]);
      const h = [...r2.clients][0];
      await handler.handleStart({ roomName: 'r2', timeLimit: null, initialBalance: 1_000 }, h);
      expect(r2.gameStarted).toBe(false);
    });
  });

  describe('베팅', () => {
    it.each([-5000, 0, 1.5, NaN])('비정상 금액 %p 는 거부하고 잔액을 바꾸지 않는다', (amount) => {
      handler.handleBetPlace({ roomName: R, amount }, guest);
      expect(balanceOf('p2')).toBe(10_000);
      expect(errors(guest)).toContain('유효하지 않은 베팅 금액입니다');
    });

    it('정상 베팅은 차감되고 묶인 베팅액에 쌓인다', () => {
      handler.handleBetPlace({ roomName: R, amount: 500 }, guest);
      expect(balanceOf('p2')).toBe(9_500);
      expect(room.state.casinoPendingStakes!.get('p2')).toBe(500);
    });
  });

  describe('결과 반영', () => {
    beforeEach(() => {
      handler.handleSwitchGame({ roomName: R, game: 'horseracing' }, guest);
    });

    it('베팅 없이 보낸 결과는 거부한다', () => {
      handler.handleResult({ roomName: R, delta: 99_999_999, gameType: 'horseracing' }, guest);
      expect(balanceOf('p2')).toBe(10_000);
      expect(errors(guest)).toContain('유효하지 않은 게임 결과입니다');
    });

    it('베팅액 × 최대 배수(경마 4배)까지는 받는다', () => {
      handler.handleBetPlace({ roomName: R, amount: 1_000 }, guest);
      handler.handleResult({ roomName: R, delta: 4_000, gameType: 'horseracing' }, guest);
      expect(balanceOf('p2')).toBe(13_000);
    });

    it('최대 배수를 넘는 결과는 거부한다', () => {
      handler.handleBetPlace({ roomName: R, amount: 1_000 }, guest);
      handler.handleResult({ roomName: R, delta: 4_001, gameType: 'horseracing' }, guest);
      expect(balanceOf('p2')).toBe(9_000);
    });

    it('한 번 반영하면 묶인 베팅액이 비워져 같은 베팅으로 두 번 받을 수 없다', () => {
      handler.handleBetPlace({ roomName: R, amount: 1_000 }, guest);
      handler.handleResult({ roomName: R, delta: 4_000, gameType: 'horseracing' }, guest);
      handler.handleResult({ roomName: R, delta: 4_000, gameType: 'horseracing' }, guest);
      expect(balanceOf('p2')).toBe(13_000);
    });

    it('음수 결과는 거부한다', () => {
      handler.handleBetPlace({ roomName: R, amount: 1_000 }, guest);
      handler.handleResult({ roomName: R, delta: -1, gameType: 'horseracing' }, guest);
      expect(balanceOf('p2')).toBe(9_000);
    });

    it('지금 하는 게임과 다른 gameType(더 큰 배수)으로는 받을 수 없다', () => {
      handler.handleBetPlace({ roomName: R, amount: 1_000 }, guest);
      handler.handleResult({ roomName: R, delta: 900_000, gameType: 'mines' }, guest);
      expect(balanceOf('p2')).toBe(9_000);
    });

    it('블랙잭 더블(베팅 2번)은 합계 기준으로 상한을 계산한다', () => {
      handler.handleSwitchGame({ roomName: R, game: 'blackjack' }, guest);
      handler.handleBetPlace({ roomName: R, amount: 1_000 }, guest);
      handler.handleBetPlace({ roomName: R, amount: 1_000 }, guest); // 더블
      handler.handleResult({ roomName: R, delta: 4_000, gameType: 'blackjack' }, guest);
      expect(balanceOf('p2')).toBe(12_000);
    });

    it('판 도중 게임을 바꾸면 건 돈은 몰수되고 새 게임 결과 상한으로 넘어가지 않는다', () => {
      handler.handleBetPlace({ roomName: R, amount: 1_000 }, guest);
      handler.handleSwitchGame({ roomName: R, game: 'slots' }, guest);
      handler.handleResult({ roomName: R, delta: 100_000, gameType: 'slots' }, guest);
      expect(balanceOf('p2')).toBe(9_000);
    });
  });

  describe('대출', () => {
    it('잔액이 초기금의 5% 이상이면 거부한다', () => {
      handler.handleLoan({ roomName: R, amount: 1_000 }, guest);
      expect(balanceOf('p2')).toBe(10_000);
      expect(errors(guest)).toContain('잔액이 충분해 대출을 받을 수 없습니다');
    });

    it('5% 미만이면 받을 수 있고, 받은 뒤엔 다시 못 받는다', () => {
      room.state.casinoBalances!.set('p2', 100);
      handler.handleLoan({ roomName: R, amount: 5_000 }, guest);
      expect(balanceOf('p2')).toBe(5_100);
      handler.handleLoan({ roomName: R, amount: 5_000 }, guest);
      expect(balanceOf('p2')).toBe(5_100);
      expect(room.state.casinoLoans!.get('p2')).toBe(5_000);
    });
  });

  describe('강제 종료', () => {
    it('관리자가 아니면 거부하고 게임은 계속된다', async () => {
      await handler.handleForceEnd({ roomName: R }, guest);
      expect(room.gameStarted).toBe(true);
      expect(errors(guest)).toContain('관리자만 강제 종료할 수 있습니다');
    });

    it('관리자는 종료할 수 있다', async () => {
      await handler.handleForceEnd({ roomName: R }, host);
      expect(room.gameStarted).toBe(false);
      expect(receivedEvent(guest, 'casinoGameOver')).toHaveLength(1);
    });
  });
});
