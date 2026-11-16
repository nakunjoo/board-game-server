import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { Room } from '../../game.types';
import { LiarHandler } from './liar.handler';
import {
  addRoom,
  errors,
  fakeDb,
  fakeSocket,
  receivedEvent,
} from '../../../../test/game-test-utils';

/** 라이어: 중간에 나가기·끊김·투표 변경·재시작·입력 변형 같은 예외 상황 */
describe('LiarHandler 예외 상황', () => {
  let ctx: GameContext;
  let handler: LiarHandler;
  let socks: WebSocket[];
  let room: Room;
  const R = 'room';
  let IDS: string[];

  const sockOf = (id: string) => socks[IDS.indexOf(id)];
  const s = () => room.liar!;
  const speaker = () => s().speakOrder[s().speakIndex % s().speakOrder.length];
  const citizens = () => IDS.filter((id) => id !== s().liarId);

  const describeAll = () => {
    while (s().phase === 'describe')
      handler.handleText({ roomName: R, text: '설명' }, sockOf(speaker()));
  };
  const start = async (rounds = 1, from = IDS[0]) => {
    await handler.handleStart(
      { roomName: R, rounds, laps: 1, discussTimeSec: 60 },
      sockOf(from),
    );
    jest.advanceTimersByTime(LiarHandler.WORD_TIME_MS);
  };
  const leave = (id: string) => {
    ctx.leaveRoom(sockOf(id), R);
    handler.handlePlayerLeft(room, id);
  };

  const setup = (n: number) => {
    IDS = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    socks = IDS.map(() => fakeSocket());
    room = addRoom(
      ctx,
      R,
      'liar',
      IDS.map((id, i) => [socks[i], id] as [WebSocket, string]),
    );
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ctx = new GameContext();
    handler = new LiarHandler(ctx, fakeDb());
    setup(5);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('시작', () => {
    it('방장이 아니면 시작할 수 없다', async () => {
      await handler.handleStart(
        { roomName: R, rounds: 1, laps: 1, discussTimeSec: 60 },
        sockOf('p2'),
      );
      expect(room.gameStarted).toBe(false);
      expect(errors(sockOf('p2'))).toContain(
        '방장만 게임을 시작할 수 있습니다',
      );
    });

    it('진행 중에는 다시 시작할 수 없다', async () => {
      await start();
      const round = s().round;
      await handler.handleStart(
        { roomName: R, rounds: 5, laps: 2, discussTimeSec: 120 },
        sockOf('p1'),
      );
      expect(errors(sockOf('p1'))).toContain('이미 게임이 시작되었습니다');
      expect(s().totalRounds).toBe(1);
      expect(s().round).toBe(round);
    });

    it('시작 전에도 채팅은 모두에게 간다', () => {
      handler.handleText({ roomName: R, text: '안녕' }, sockOf('p3'));
      expect(receivedEvent(sockOf('p1'), 'liarChat')[0].data).toMatchObject({
        playerId: 'p3',
        text: '안녕',
      });
    });

    it('끝난 뒤 다시 시작하면 점수·판 수가 새로 시작된다', async () => {
      await start(1);
      describeAll();
      jest.advanceTimersByTime(60_000); // 동점 → 라이어 +3
      jest.advanceTimersByTime(LiarHandler.RESULT_TIME_MS);
      expect(room.liarGameOverResult).toBeDefined();
      await start(3);
      expect(room.liarGameOverResult).toBeUndefined();
      expect(s().round).toBe(1);
      expect(s().totalRounds).toBe(3);
      expect([...s().scores.values()].every((v) => v === 0)).toBe(true);
    });

    it('5판 동안 같은 사람이 연달아 라이어가 되지 않는다', async () => {
      await start(5);
      const liars: string[] = [];
      while (room.liar) {
        liars.push(s().liarId);
        describeAll();
        jest.advanceTimersByTime(60_000);
        jest.advanceTimersByTime(LiarHandler.RESULT_TIME_MS);
        jest.advanceTimersByTime(LiarHandler.WORD_TIME_MS);
      }
      expect(liars).toHaveLength(5);
      for (let i = 1; i < liars.length; i++)
        expect(liars[i]).not.toBe(liars[i - 1]);
    });
  });

  describe('입력', () => {
    it('설명은 40자에서 자른다', async () => {
      await start();
      handler.handleText(
        { roomName: R, text: '가'.repeat(60) },
        sockOf(speaker()),
      );
      expect(s().descriptions[0].text).toHaveLength(
        LiarHandler.MAX_DESC_LENGTH,
      );
    });

    it('띄어쓰기·기호를 섞어도 자기 단어가 들어간 말은 막는다', async () => {
      await start();
      const c = citizens()[0];
      const w = s().word;
      const spaced = `혹시 ${[...w].join(' ')}!?`;
      handler.handleText({ roomName: R, text: spaced }, sockOf(c));
      expect(receivedEvent(sockOf(c), 'liarBlocked')).toHaveLength(1);
      // 라이어도 자기(다른) 단어는 막힌다
      handler.handleText(
        { roomName: R, text: `${s().liarWord}ㅋㅋ` },
        sockOf(s().liarId),
      );
      expect(receivedEvent(sockOf(s().liarId), 'liarBlocked')).toHaveLength(1);
    });

    it('라이어의 정답은 띄어쓰기·기호가 섞여도 인정한다', async () => {
      await start();
      describeAll();
      const liarId = s().liarId;
      for (const id of IDS)
        handler.handleVote(
          { roomName: R, targetId: id === liarId ? citizens()[0] : liarId },
          sockOf(id),
        );
      expect(s().phase).toBe('liarGuess');
      handler.handleText(
        { roomName: R, text: ` ${[...s().word].join(' ')}! ` },
        sockOf(liarId),
      );
      expect(s().lastResult).toMatchObject({
        winner: 'liar',
        reason: 'guessed',
      });
    });

    it('결과 단계에서는 제시어가 든 말도 자유롭게 채팅할 수 있다', async () => {
      await start();
      describeAll();
      jest.advanceTimersByTime(60_000);
      expect(s().phase).toBe('result');
      const c = citizens()[0];
      handler.handleText(
        { roomName: R, text: `정답은 ${s().word}` },
        sockOf(c),
      );
      expect(receivedEvent(sockOf(c), 'liarBlocked')).toHaveLength(0);
      expect(
        receivedEvent(sockOf('p1'), 'liarChat').at(-1)!.data.text,
      ).toContain(s().word);
    });
  });

  describe('투표', () => {
    it('바꾸거나 취소할 수 있고, 투표한 사람 목록만 알린다', async () => {
      await start();
      describeAll();
      const [a, b, c] = citizens();
      handler.handleVote({ roomName: R, targetId: b }, sockOf(a));
      handler.handleVote({ roomName: R, targetId: c }, sockOf(a));
      expect(s().votes.get(a)).toBe(c);
      handler.handleVote({ roomName: R, targetId: null }, sockOf(a));
      expect(s().votes.has(a)).toBe(false);
      const updates = receivedEvent(sockOf('p1'), 'liarVoteUpdate');
      expect(updates.at(-1)!.data.voted).toEqual([]);
      // 누구를 찍었는지는 결과 전까지 보내지 않는다
      expect(JSON.stringify(updates)).not.toContain(c);
    });

    it('방에 없는 사람·토론 시간이 아닐 때의 투표는 무시한다', async () => {
      await start();
      handler.handleVote({ roomName: R, targetId: 'p2' }, sockOf('p1'));
      expect(s().votes.size).toBe(0); // 설명 중
      describeAll();
      handler.handleVote({ roomName: R, targetId: 'nobody' }, sockOf('p1'));
      expect(s().votes.size).toBe(0);
    });

    it('토론 중 나간 사람의 표와 그 사람이 받은 표는 빼고, 남은 사람이 다 찍었으면 바로 집계', async () => {
      await start();
      describeAll();
      const liarId = s().liarId;
      const [a, b, c, d] = citizens();
      handler.handleVote({ roomName: R, targetId: liarId }, sockOf(a));
      handler.handleVote({ roomName: R, targetId: liarId }, sockOf(b));
      handler.handleVote({ roomName: R, targetId: d }, sockOf(c));
      handler.handleVote({ roomName: R, targetId: a }, sockOf(liarId));
      expect(s().phase).toBe('discuss'); // d가 아직
      leave(d);
      // c의 표(d에게 간)는 빠지고, 남은 4명이 다 찍은 상태 → 라이어 2표로 지목
      expect(s().votes.has(c)).toBe(false);
      expect(s().phase).toBe('discuss'); // c가 다시 찍어야 함
      handler.handleVote({ roomName: R, targetId: liarId }, sockOf(c));
      expect(s().phase).toBe('liarGuess');
    });
  });

  describe('나가기·끊김', () => {
    it('설명 차례인 사람이 나가면 바로 다음 사람 차례', async () => {
      await start();
      // 라이어가 나가면 판이 무효가 되므로 라이어가 아닌 사람 차례까지 넘긴다
      while (speaker() === s().liarId)
        handler.handleText({ roomName: R, text: '설명' }, sockOf(speaker()));
      const who = speaker();
      const idx = s().speakIndex;
      leave(who);
      expect(s().speakIndex).toBe(idx + 1);
      expect(s().descriptions.some((d) => d.playerId === who)).toBe(false);
    });

    it('라이어가 정답을 맞히는 중에 끊기면 시간이 지나 시민 승', async () => {
      await start();
      describeAll();
      const liarId = s().liarId;
      for (const id of IDS)
        handler.handleVote(
          { roomName: R, targetId: id === liarId ? citizens()[0] : liarId },
          sockOf(id),
        );
      room.disconnectTimers.set(
        liarId,
        setTimeout(() => {}, 1e9),
      );
      handler.handleDisconnect(room, liarId);
      expect(s().phase).toBe('liarGuess');
      jest.advanceTimersByTime(LiarHandler.LIAR_GUESS_TIME_MS);
      expect(s().lastResult).toMatchObject({
        winner: 'citizens',
        reason: 'guessFailed',
        liarGuess: null,
      });
    });

    it('3명 미만이 되면 인원 부족으로 끝나고, 나간 사람도 순위에 남는다', async () => {
      await start(3);
      describeAll();
      jest.advanceTimersByTime(60_000); // 동점 → 라이어 +3
      const liarId = s().liarId;
      const others = citizens();
      leave(others[0]);
      leave(others[1]);
      expect(room.liar).toBeDefined(); // 3명 남음 → 계속
      leave(others[2]);
      expect(room.liar).toBeUndefined();
      const over = receivedEvent(sockOf(liarId), 'liarGameOver')[0].data;
      expect(over.reason).toBe('notEnough');
      expect(over.ranking).toHaveLength(5);
      expect(over.ranking[0]).toMatchObject({ playerId: liarId, score: 3 });
    });

    it('재연결 상태에 설명 기록·현재 차례·바퀴가 들어 있다', async () => {
      await start();
      handler.handleText({ roomName: R, text: '첫 설명' }, sockOf(speaker()));
      const now = speaker();
      const st = handler.buildLiarState(room, citizens()[0]).liar as Record<
        string,
        unknown
      >;
      expect(st).toMatchObject({ phase: 'describe', speakerId: now, lap: 1 });
      expect((st.descriptions as { text: string }[])[0].text).toBe('첫 설명');
      expect(st.timeLeftMs).toBeGreaterThan(0);
    });
  });

  describe('라이어가 나가면', () => {
    /** 라이어를 각 단계까지 데려간다 */
    const goTo = async (phase: string, rounds = 3) => {
      await handler.handleStart(
        { roomName: R, rounds, laps: 1, discussTimeSec: 60 },
        sockOf('p1'),
      );
      if (phase === 'word') return;
      jest.advanceTimersByTime(LiarHandler.WORD_TIME_MS);
      if (phase === 'describe') return;
      describeAll();
      if (phase === 'discuss') return;
      const liarId = s().liarId;
      for (const id of IDS)
        handler.handleVote(
          { roomName: R, targetId: id === liarId ? citizens()[0] : liarId },
          sockOf(id),
        );
      if (phase === 'liarGuess') return;
      handler.handleText({ roomName: R, text: '오답' }, sockOf(liarId));
    };

    it.each(['word', 'describe', 'discuss', 'liarGuess'])(
      '%s 단계: 그 판은 무효(점수 없음)이고 다음 판은 남은 사람 중 새 라이어로 이어진다',
      async (phase) => {
        await goTo(phase);
        expect(s().phase).toBe(phase);
        const liarId = s().liarId;
        leave(liarId);
        expect(s().phase).toBe('result');
        expect(s().lastResult).toMatchObject({
          winner: 'none',
          reason: 'liarLeft',
          liarId,
          gains: {},
        });
        expect([...s().scores.values()].every((v) => v === 0)).toBe(true);
        // 모두에게 결과가 갔다
        for (const id of IDS.filter((x) => x !== liarId))
          expect(
            receivedEvent(sockOf(id), 'liarRoundResult').at(-1)!.data.reason,
          ).toBe('liarLeft');
        jest.advanceTimersByTime(LiarHandler.RESULT_TIME_MS);
        expect(s().round).toBe(2);
        expect(s().phase).toBe('word');
        expect(s().liarId).not.toBe(liarId);
        expect(s().speakOrder).not.toContain(liarId);
      },
    );

    it('결과 단계에 나가면 이미 끝난 판이라 그대로 다음 판으로 간다', async () => {
      await goTo('result');
      expect(s().phase).toBe('result');
      const before = s().lastResult;
      const liarId = s().liarId;
      leave(liarId);
      expect(s().lastResult).toBe(before);
      jest.advanceTimersByTime(LiarHandler.RESULT_TIME_MS);
      expect(s().round).toBe(2);
      expect(s().speakOrder).not.toContain(liarId);
    });

    it('마지막 판에서 나가면 무효 결과 뒤 게임이 끝난다', async () => {
      await goTo('describe', 1);
      const liarId = s().liarId;
      // 라이어가 p1일 수도 있으니 남아 있는 사람 기준으로 본다
      const stayer = citizens()[0];
      leave(liarId);
      expect(s().lastResult).toMatchObject({ reason: 'liarLeft' });
      jest.advanceTimersByTime(LiarHandler.RESULT_TIME_MS);
      expect(room.liar).toBeUndefined();
      expect(receivedEvent(sockOf(stayer), 'liarGameOver')[0].data.reason).toBe(
        'finished',
      );
    });

    it('라이어가 끊기기만 하면 판은 그대로 이어진다 (30초 안에 돌아올 수 있으니)', async () => {
      await goTo('discuss');
      const liarId = s().liarId;
      room.disconnectTimers.set(
        liarId,
        setTimeout(() => {}, 1e9),
      );
      handler.handleDisconnect(room, liarId);
      expect(s().phase).toBe('discuss');
      expect(s().liarId).toBe(liarId);
    });
  });
});
