import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { GameEngineFactory } from '../../game-engine.factory';
import { Room } from '../../game.types';
import { SkulkingHandler } from './skulking.handler';
import {
  addRoom,
  errors,
  fakeDb,
  fakeSocket,
  receivedEvent,
} from '../../../../test/game-test-utils';

const GAME_OVER_DELAY = 5000;

describe('SkulkingHandler 게임 종료', () => {
  let ctx: GameContext;
  let handler: SkulkingHandler;
  let a: WebSocket;
  let b: WebSocket;
  let room: Room;
  const R = 'room';

  function playRoundEnd(round: number) {
    room.gameStarted = true;
    room.state.skulkingRound = round;
    room.state.bids = new Map([
      ['A', 1],
      ['B', 0],
    ]);
    room.state.tricks = new Map([
      ['A', 1],
      ['B', 0],
    ]);
    room.state.scores = new Map();
    room.state.roundScores = new Map();
    room.state.roundBidTrickHistory = [];
    (handler as any).endRound(R);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = new GameContext();
    handler = new SkulkingHandler(ctx, new GameEngineFactory([]), fakeDb());
    a = fakeSocket();
    b = fakeSocket();
    room = addRoom(ctx, R, 'skulking', [
      [a, 'A'],
      [b, 'B'],
    ]);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('10라운드가 끝나면 클라이언트 요청 없이 서버가 게임을 종료한다', () => {
    playRoundEnd(10);
    expect(receivedEvent(a, 'skulkingGameOver')).toHaveLength(0);

    jest.advanceTimersByTime(GAME_OVER_DELAY);

    expect(receivedEvent(a, 'skulkingGameOver')).toHaveLength(1);
    expect(receivedEvent(b, 'skulkingGameOver')[0].data.ranking[0]).toMatchObject({
      playerId: 'B', // 10라운드 비드 0 성공 = 100점, A는 비드 1 성공 = 20점
      rank: 1,
    });
    expect(room.gameStarted).toBe(false);
    expect(room.gameOver).toBe(true);
  });

  it('마지막 라운드가 아니면 종료하지 않고 서버가 다음 라운드를 시작한다', () => {
    const startNewRound = jest.fn();
    (handler as any).startNewRound = startNewRound;
    playRoundEnd(9);

    jest.advanceTimersByTime(7999);
    expect(startNewRound).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(startNewRound).toHaveBeenCalledWith(R, 10);
    expect(receivedEvent(a, 'skulkingGameOver')).toHaveLength(0);
    expect(room.gameStarted).toBe(true);
  });

  it('진행 중인 라운드에서는 skulkingNextRound를 무시한다', () => {
    const startNewRound = jest.fn();
    (handler as any).startNewRound = startNewRound;
    room.gameStarted = true;
    room.state.skulkingRound = 3;
    room.state.skulkingPhase = 'play';

    handler.handleNextRound({ roomName: R }, a);

    expect(startNewRound).not.toHaveBeenCalled();
  });

  it('구버전 클라이언트가 skulkingNextRound를 보내도 종료는 한 번만 처리된다', () => {
    playRoundEnd(10);
    handler.handleNextRound({ roomName: R }, a);
    jest.advanceTimersByTime(GAME_OVER_DELAY);
    expect(receivedEvent(a, 'skulkingGameOver')).toHaveLength(1);
  });

  it('대기 중에 방이 사라지면 종료 처리를 건너뛴다', () => {
    playRoundEnd(10);
    ctx.rooms.delete(R);
    expect(() => jest.advanceTimersByTime(GAME_OVER_DELAY)).not.toThrow();
    expect(receivedEvent(a, 'skulkingGameOver')).toHaveLength(0);
  });

  it('종료 후에는 방장이 다시 시작할 수 있다', async () => {
    playRoundEnd(10);
    jest.advanceTimersByTime(GAME_OVER_DELAY);

    await handler.handleStartGame({ roomName: R }, a);

    expect(errors(a)).toEqual([]);
    expect(receivedEvent(a, 'skulkingFirstDrawStarted')).toHaveLength(1);
    expect(room.gameFinished).toBe(false);
    expect(room.gameOver).toBe(false);
  });
});
