import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { Room } from '../../game.types';
import { LiarHandler } from './liar.handler';
import { LIAR_TOPICS } from './liar.words';
import {
  addRoom,
  errors,
  fakeDb,
  fakeSocket,
  receivedEvent,
} from '../../../../test/game-test-utils';

describe('LiarHandler', () => {
  let ctx: GameContext;
  let handler: LiarHandler;
  let socks: WebSocket[];
  let room: Room;
  const R = 'room';
  const IDS = ['p1', 'p2', 'p3', 'p4'];

  const sockOf = (id: string) => socks[IDS.indexOf(id)];
  const liar = () => room.liar!;

  /** 설명 차례를 모두 채워 토론으로 넘긴다 */
  const describeAll = () => {
    while (liar().phase === 'describe') {
      const speaker =
        liar().speakOrder[liar().speakIndex % liar().speakOrder.length];
      handler.handleText(
        { roomName: R, text: `설명-${speaker}` },
        sockOf(speaker),
      );
    }
  };

  const start = async (rounds = 1) => {
    await handler.handleStart(
      { roomName: R, rounds, laps: 1, discussTimeSec: 60 },
      socks[0],
    );
    jest.advanceTimersByTime(LiarHandler.WORD_TIME_MS);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ctx = new GameContext();
    handler = new LiarHandler(ctx, fakeDb());
    socks = IDS.map(() => fakeSocket());
    room = addRoom(
      ctx,
      R,
      'liar',
      IDS.map((id, i) => [socks[i], id] as [WebSocket, string]),
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('3명 미만이면 시작하지 않는다', async () => {
    const r2 = addRoom(ctx, 'r2', 'liar', [
      [fakeSocket(), 'a'],
      [fakeSocket(), 'b'],
    ]);
    const h = [...r2.clients][0];
    await handler.handleStart(
      { roomName: 'r2', rounds: 1, laps: 1, discussTimeSec: 60 },
      h,
    );
    expect(r2.gameStarted).toBe(false);
    expect(errors(h)[0]).toContain('최소 3명');
  });

  it('허용되지 않은 설정은 거부한다', async () => {
    await handler.handleStart(
      { roomName: R, rounds: 99, laps: 1, discussTimeSec: 60 },
      socks[0],
    );
    expect(room.gameStarted).toBe(false);
  });

  it('라이어는 같은 주제의 다른 단어를 받고, 아무도 라이어라고 안내받지 않는다', async () => {
    await start();
    for (const id of IDS) {
      const msg = receivedEvent(sockOf(id), 'liarRound')[0].data;
      expect(msg.topic).toBe(liar().topic);
      expect(msg.isLiar).toBe(false);
      expect(msg.word).toBe(
        id === liar().liarId ? liar().liarWord : liar().word,
      );
    }
    expect(liar().liarWord).not.toBe(liar().word);
    // 주제만 같은 게 아니라 비슷한 것끼리 묶은 같은 묶음에서 나온다
    const group = LIAR_TOPICS.find(
      (t) => t.topic === liar().topic,
    )!.groups.find((g) => g.includes(liar().word))!;
    expect(group).toContain(liar().liarWord);
  });

  it('한 번 쓴 묶음은 같은 게임에서 다시 나오지 않는다', async () => {
    await start(5);
    const groupOf = (w: string) =>
      LIAR_TOPICS.flatMap((t) => t.groups).findIndex((g) => g.includes(w));
    const seen = new Set<number>();
    for (let r = 0; r < 5; r++) {
      const g = groupOf(liar().word);
      expect(seen.has(g)).toBe(false);
      seen.add(g);
      // 설명·토론을 시간 초과로 흘려보내 다음 판으로
      while (liar().phase !== 'result') jest.advanceTimersByTime(1_000);
      jest.advanceTimersByTime(LiarHandler.RESULT_TIME_MS);
      jest.advanceTimersByTime(LiarHandler.WORD_TIME_MS);
      if (!room.liar) break;
    }
  });

  it('제시어 목록: 묶음은 2개 이상, 한 글자 단어 없음, 묶음 안에서 서로 품지 않음', () => {
    for (const t of LIAR_TOPICS)
      for (const g of t.groups) {
        expect(g.length).toBeGreaterThanOrEqual(2);
        for (const a of g) {
          expect(a.length).toBeGreaterThan(1);
          for (const b of g) if (a !== b) expect(a.includes(b)).toBe(false);
        }
      }
  });

  it('설명 중에도 차례가 아닌 사람은 채팅할 수 있고, 자기 단어가 들어간 말은 막는다', async () => {
    await start();
    const speaker = liar().speakOrder[0];
    const other = IDS.find((id) => id !== speaker)!;
    handler.handleText({ roomName: R, text: '아무 말' }, sockOf(other));
    expect(receivedEvent(sockOf(speaker), 'liarChat')[0].data).toMatchObject({
      playerId: other,
      text: '아무 말',
    });
    // 채팅은 설명으로 치지 않고 차례도 넘어가지 않는다
    expect(liar().descriptions).toHaveLength(0);
    expect(liar().speakIndex).toBe(0);

    const citizen = IDS.find((id) => id !== liar().liarId)!;
    handler.handleText(
      { roomName: R, text: `이건 ${liar().word} 같아요` },
      sockOf(citizen),
    );
    expect(receivedEvent(sockOf(citizen), 'liarBlocked')).toHaveLength(1);
  });

  it('시간이 지나면 설명을 건너뛰고 다음 사람 차례', async () => {
    await start();
    jest.advanceTimersByTime(LiarHandler.DESC_TIME_MS);
    expect(liar().descriptions[0]).toMatchObject({
      skipped: true,
      text: '(시간 초과)',
    });
    expect(liar().speakIndex).toBe(1);
  });

  it('모두 설명하면 토론, 모두 라이어를 찍으면 라이어 맞히기 → 못 맞히면 시민 승', async () => {
    await start();
    describeAll();
    expect(liar().phase).toBe('discuss');
    const liarId = liar().liarId;
    const citizens = IDS.filter((id) => id !== liarId);
    for (const id of citizens)
      handler.handleVote({ roomName: R, targetId: liarId }, sockOf(id));
    handler.handleVote({ roomName: R, targetId: citizens[0] }, sockOf(liarId));
    expect(liar().phase).toBe('liarGuess');
    // 지목된 뒤에야 자기가 라이어인 걸 안다 (재연결 상태에도)
    expect(
      (handler.buildLiarState(room, liarId).liar as { isLiar: boolean }).isLiar,
    ).toBe(true);

    handler.handleText({ roomName: R, text: '전혀아닌단어' }, sockOf(liarId));
    expect(liar().phase).toBe('result');
    expect(liar().lastResult).toMatchObject({
      winner: 'citizens',
      reason: 'guessFailed',
    });
    for (const id of citizens) expect(liar().scores.get(id)).toBe(1);
    expect(liar().scores.get(liarId)).toBe(0);
  });

  it('시민이 이겨도 라이어를 맞게 찍은 시민만 +1', async () => {
    await start();
    describeAll();
    const liarId = liar().liarId;
    const [c0, c1, c2] = IDS.filter((id) => id !== liarId);
    handler.handleVote({ roomName: R, targetId: liarId }, sockOf(c0));
    handler.handleVote({ roomName: R, targetId: liarId }, sockOf(c1));
    handler.handleVote({ roomName: R, targetId: c0 }, sockOf(c2)); // 엉뚱한 사람
    jest.advanceTimersByTime(60_000); // 라이어는 투표 안 함 → 시간 마감, 라이어 2표
    expect(liar().phase).toBe('liarGuess');
    jest.advanceTimersByTime(LiarHandler.LIAR_GUESS_TIME_MS); // 못 맞힘
    expect(liar().lastResult).toMatchObject({ winner: 'citizens' });
    expect(liar().lastResult!.gains).toEqual({ [c0]: 1, [c1]: 1 });
    expect(liar().scores.get(c2)).toBe(0);
  });

  it('지목된 라이어가 제시어를 맞히면 라이어 승', async () => {
    await start();
    describeAll();
    const liarId = liar().liarId;
    for (const id of IDS) {
      const target = id === liarId ? IDS.find((x) => x !== liarId)! : liarId;
      handler.handleVote({ roomName: R, targetId: target }, sockOf(id));
    }
    handler.handleText({ roomName: R, text: liar().word }, sockOf(liarId));
    expect(liar().lastResult).toMatchObject({
      winner: 'liar',
      reason: 'guessed',
    });
    expect(liar().scores.get(liarId)).toBe(LiarHandler.LIAR_WIN_POINTS);
  });

  it('동점이면 라이어 승', async () => {
    await start();
    describeAll();
    jest.advanceTimersByTime(60_000); // 아무도 투표 안 함
    expect(liar().lastResult).toMatchObject({ winner: 'liar', reason: 'tie' });
  });

  it('자기 자신에게는 투표할 수 없다', async () => {
    await start();
    describeAll();
    handler.handleVote({ roomName: R, targetId: 'p1' }, sockOf('p1'));
    expect(liar().votes.size).toBe(0);
  });

  it('설명 차례인 사람이 끊기면 바로 넘긴다', async () => {
    await start();
    const speaker = liar().speakOrder[0];
    room.disconnectTimers.set(
      speaker,
      setTimeout(() => {}, 1e9),
    );
    handler.handleDisconnect(room, speaker);
    expect(liar().descriptions[0]).toMatchObject({
      playerId: speaker,
      skipped: true,
    });
    expect(liar().speakIndex).toBe(1);
  });

  it('라이어가 나가면 그 판은 무효', async () => {
    await start(3);
    const liarId = liar().liarId;
    ctx.leaveRoom(sockOf(liarId), R);
    handler.handlePlayerLeft(room, liarId);
    expect(liar().lastResult).toMatchObject({
      winner: 'none',
      reason: 'liarLeft',
    });
  });

  it('정해진 판 수가 끝나면 게임 종료', async () => {
    await start(1);
    describeAll();
    jest.advanceTimersByTime(60_000);
    jest.advanceTimersByTime(LiarHandler.RESULT_TIME_MS);
    expect(room.liar).toBeUndefined();
    expect(room.gameStarted).toBe(false);
    expect(receivedEvent(socks[0], 'liarGameOver')).toHaveLength(1);
  });

  it('재연결 상태에 다른 사람의 단어가 새지 않는다', async () => {
    await start();
    const liarId = liar().liarId;
    const citizen = IDS.find((id) => id !== liarId)!;
    const forLiar = handler.buildLiarState(room, liarId).liar as Record<
      string,
      unknown
    >;
    const forCitizen = handler.buildLiarState(room, citizen).liar as Record<
      string,
      unknown
    >;
    expect(forLiar.word).toBe(liar().liarWord);
    expect(forLiar.isLiar).toBe(false);
    expect(forCitizen.word).toBe(liar().word);
    expect(JSON.stringify(forLiar)).not.toContain(`"${liar().word}"`);
  });
});
