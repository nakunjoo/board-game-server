import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { MafiaRole, Room } from '../../game.types';
import { MafiaHandler } from './mafia.handler';
import {
  addRoom,
  errors,
  fakeDb,
  fakeSocket,
  receivedEvent,
} from '../../../../test/game-test-utils';

describe('MafiaHandler', () => {
  let ctx: GameContext;
  let handler: MafiaHandler;
  let socks: WebSocket[];
  let ids: string[];
  let room: Room;
  const R = 'room';

  const sockOf = (id: string) => socks[ids.indexOf(id)];
  const m = () => room.mafia!;
  const withRole = (role: MafiaRole) =>
    ids.filter((id) => m().roles.get(id) === role);
  const act = (id: string, targetId: string | null) =>
    handler.handleAction({ roomName: R, targetId }, sockOf(id));
  const say = (id: string, text: string) =>
    handler.handleText({ roomName: R, text }, sockOf(id));
  const chatsOf = (id: string) =>
    receivedEvent(sockOf(id), 'mafiaChat').map(
      (e) => e.data as { text: string; scope: string },
    );

  const setup = async (n: number) => {
    ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
    socks = ids.map(() => fakeSocket());
    room = addRoom(
      ctx,
      R,
      'mafia',
      ids.map((id, i) => [socks[i], id] as [WebSocket, string]),
    );
    await handler.handleStart({ roomName: R, discussTimeSec: 90 }, socks[0]);
    jest.advanceTimersByTime(MafiaHandler.ROLE_TIME_MS); // → 첫 밤
  };

  /** 밤: 마피아가 target을 죽이고 경찰·의사는 아무 데나 (heal을 주면 그 사람을 살림) */
  const night = (target: string, heal?: string) => {
    for (const id of withRole('mafia').filter((x) => m().alive.has(x)))
      act(id, target);
    const police = withRole('police').find((x) => m().alive.has(x));
    if (police) act(police, ids.find((x) => x !== police && m().alive.has(x))!);
    const doctor = withRole('doctor').find((x) => m().alive.has(x));
    if (doctor) act(doctor, heal ?? doctor);
    // 할 일이 끝나도 밤은 최소 시간만큼 간다
    jest.advanceTimersByTime(MafiaHandler.MIN_NIGHT_MS);
  };
  /** 낮: 산 사람 모두 target에게 (target 본인은 다른 사람에게) */
  const dayVote = (target: string) => {
    const alive = [...m().alive];
    for (const id of alive)
      act(id, id === target ? alive.find((x) => x !== id)! : target);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ctx = new GameContext();
    handler = new MafiaHandler(ctx, fakeDb());
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('시작·역할', () => {
    it('4명 미만이면 시작하지 않는다', async () => {
      ids = ['a', 'b', 'c'];
      socks = ids.map(() => fakeSocket());
      room = addRoom(
        ctx,
        R,
        'mafia',
        ids.map((id, i) => [socks[i], id] as [WebSocket, string]),
      );
      await handler.handleStart({ roomName: R, discussTimeSec: 90 }, socks[0]);
      expect(room.gameStarted).toBe(false);
      expect(errors(socks[0])[0]).toContain('최소 4명');
    });

    it.each([
      [4, 1, 0],
      [5, 1, 0],
      [6, 2, 1],
      [8, 2, 1],
    ])(
      '%i명이면 마피아 %i명, 경찰 1명, 의사 %i명',
      async (n, mafias, doctors) => {
        await setup(n);
        expect(withRole('mafia')).toHaveLength(mafias);
        expect(withRole('police')).toHaveLength(1);
        expect(withRole('doctor')).toHaveLength(doctors);
        expect(withRole('citizen')).toHaveLength(n - mafias - 1 - doctors);
      },
    );

    it('역할은 각자에게만, 마피아만 동료를 안다', async () => {
      await setup(6);
      for (const id of ids) {
        const msg = receivedEvent(sockOf(id), 'mafiaRole')[0].data as {
          role: string;
          mafiaTeam: string[];
        };
        expect(msg.role).toBe(m().roles.get(id));
        expect(msg.mafiaTeam).toEqual(
          msg.role === 'mafia' ? expect.arrayContaining(withRole('mafia')) : [],
        );
      }
      // 재연결 상태에도 남의 역할은 없다
      const citizen = withRole('citizen')[0];
      const st = JSON.stringify(handler.buildMafiaState(room, citizen));
      for (const id of withRole('mafia'))
        expect(st).not.toContain(`"mafiaTeam":["${id}`);
      expect(st).not.toContain('"roles"');
    });
    it('4~8명 모두 한 사람에 역할 하나, 인원별 역할 수가 맞고 누구나 어떤 역할이든 받을 수 있다', async () => {
      for (let n = 4; n <= 8; n++) {
        const got = new Map<string, Set<string>>();
        for (let t = 0; t < 200; t++) {
          jest.clearAllTimers();
          ctx = new GameContext();
          handler = new MafiaHandler(ctx, fakeDb());
          await setup(n);
          expect([...m().roles.keys()].sort()).toEqual([...ids].sort());
          const count = (r: MafiaRole) => withRole(r).length;
          expect(count('mafia')).toBe(n >= 6 ? 2 : 1);
          expect(count('police')).toBe(1);
          expect(count('doctor')).toBe(n >= 6 ? 1 : 0);
          expect(count('citizen')).toBe(
            n - count('mafia') - 1 - count('doctor'),
          );
          for (const [i, id] of ids.entries()) {
            const sent = receivedEvent(socks[i], 'mafiaRole');
            expect(sent).toHaveLength(1);
            expect((sent[0].data as { role: string }).role).toBe(
              m().roles.get(id),
            );
            const seen = got.get(id) ?? new Set<string>();
            seen.add(m().roles.get(id)!);
            got.set(id, seen);
          }
        }
        for (const id of ids) expect(got.get(id)!.size).toBe(n >= 6 ? 4 : 3);
      }
    });
    it('모두에게 보내는 참가자·생존자 목록은 입장 순서라 역할이 드러나지 않는다', async () => {
      for (let t = 0; t < 20; t++) {
        jest.clearAllTimers();
        ctx = new GameContext();
        handler = new MafiaHandler(ctx, fakeDb());
        await setup(8);
        const started = receivedEvent(socks[1], 'mafiaStarted')[0].data as {
          players: string[];
        };
        expect(started.players).toEqual(ids);
        const st = handler.buildMafiaState(room, ids[1]).mafia as {
          players: string[];
          alive: string[];
        };
        expect(st.players).toEqual(ids);
        expect(st.alive).toEqual(ids);
      }
    });
  });

  describe('밤', () => {
    it('마피아가 고른 사람이 죽고, 모두 할 일을 하면 바로 낮이 된다', async () => {
      await setup(5);
      const victim = withRole('citizen')[0];
      night(victim);
      expect(m().phase).toBe('day');
      expect(m().alive.has(victim)).toBe(false);
      expect(receivedEvent(socks[0], 'mafiaDay')[0].data).toMatchObject({
        killedId: victim,
      });
    });

    it('의사가 살리면 아무도 죽지 않는다 (자기 자신도 언제나)', async () => {
      await setup(6);
      const doctor = withRole('doctor')[0];
      night(doctor, doctor);
      expect(m().alive.has(doctor)).toBe(true);
      expect(receivedEvent(socks[0], 'mafiaDay')[0].data).toMatchObject({
        killedId: null,
      });
    });

    it('경찰 조사 결과는 경찰에게만, 하룻밤에 한 번', async () => {
      await setup(5);
      const police = withRole('police')[0];
      const mafia = withRole('mafia')[0];
      act(police, mafia);
      act(police, withRole('citizen')[0]); // 두 번째는 무시
      const res = receivedEvent(sockOf(police), 'mafiaInvestigated');
      expect(res).toHaveLength(1);
      expect(res[0].data).toMatchObject({ targetId: mafia, isMafia: true });
      for (const id of ids.filter((x) => x !== police))
        expect(receivedEvent(sockOf(id), 'mafiaInvestigated')).toHaveLength(0);
    });

    it('마피아는 동료를, 시민은 아무도 지목할 수 없다', async () => {
      await setup(6);
      const [m1, m2] = withRole('mafia');
      act(m1, m2);
      expect(m().kills.size).toBe(0);
      act(withRole('citizen')[0], m1);
      expect(m().kills.size).toBe(0);
    });

    it('마피아 둘이 다르게 고르면 먼저 고른 사람이 죽는다', async () => {
      await setup(6);
      const [m1, m2] = withRole('mafia');
      const [c1, c2] = withRole('citizen');
      act(m1, c1);
      act(m2, c2);
      jest.advanceTimersByTime(MafiaHandler.NIGHT_TIME_MS);
      expect(m().alive.has(c1)).toBe(false);
      expect(m().alive.has(c2)).toBe(true);
    });

    it('30초가 지나면 한 일만으로 낮이 된다 (아무도 안 고르면 아무도 안 죽음)', async () => {
      await setup(5);
      jest.advanceTimersByTime(MafiaHandler.NIGHT_TIME_MS);
      expect(m().phase).toBe('day');
      expect(m().alive.size).toBe(5);
    });
  });

  describe('낮', () => {
    it('가장 많이 받은 사람을 처형하고, 모두 투표하면 바로 끝난다', async () => {
      await setup(5);
      night(withRole('citizen')[0]);
      const mafia = withRole('mafia')[0];
      dayVote(mafia);
      // 마피아가 다 죽어 시민 승리
      expect(room.mafia).toBeUndefined();
      expect(receivedEvent(socks[1], 'mafiaExecuted')[0].data).toMatchObject({
        executedId: mafia,
      });
      expect(receivedEvent(socks[1], 'mafiaGameOver')[0].data).toMatchObject({
        winner: 'citizens',
      });
    });

    it('동점이면 아무도 처형하지 않고 다음 밤', async () => {
      await setup(6);
      jest.advanceTimersByTime(MafiaHandler.NIGHT_TIME_MS);
      const [a, b, c, d] = ids;
      act(a, b);
      act(b, a);
      act(c, a);
      act(d, b);
      jest.advanceTimersByTime(90_000);
      expect(
        receivedEvent(socks[0], 'mafiaExecuted').at(-1)!.data,
      ).toMatchObject({ executedId: null });
      jest.advanceTimersByTime(MafiaHandler.EXECUTION_SHOW_MS);
      expect(m().phase).toBe('night');
      expect(m().day).toBe(2);
    });

    it('죽은 사람은 투표할 수 없고, 자기 자신에게도 못 한다', async () => {
      await setup(5);
      const victim = withRole('citizen')[0];
      night(victim);
      act(victim, ids.find((x) => x !== victim)!);
      act(ids[0], ids[0]);
      expect(m().votes.size).toBe(0);
    });

    it('마피아 수가 나머지 이상이 되면 마피아 승리', async () => {
      await setup(4); // 마피아 1, 경찰, 의사, 시민
      const mafia = withRole('mafia')[0];
      const [p] = withRole('police');
      const [c] = withRole('citizen');
      night(c, withRole('doctor')[0]);
      dayVote(p); // 경찰 처형 → 마피아1 vs 의사1
      expect(room.mafia).toBeUndefined();
      expect(
        receivedEvent(sockOf(mafia), 'mafiaGameOver')[0].data,
      ).toMatchObject({ winner: 'mafia' });
    });
  });

  describe('채팅', () => {
    it('밤에는 마피아끼리만, 나머지 산 사람은 말할 수 없다', async () => {
      await setup(6);
      const [m1, m2] = withRole('mafia');
      const citizen = withRole('citizen')[0];
      say(m1, '누구 죽일까');
      expect(chatsOf(m2).at(-1)).toMatchObject({
        text: '누구 죽일까',
        scope: 'mafia',
      });
      expect(chatsOf(citizen)).toHaveLength(0);
      say(citizen, '안녕');
      expect(receivedEvent(sockOf(citizen), 'mafiaSilent')).toHaveLength(1);
      expect(chatsOf(m1).some((c) => c.text === '안녕')).toBe(false);
    });

    it('낮에는 모두에게, 죽은 사람 말은 죽은 사람끼리만', async () => {
      await setup(6);
      const [c1, c2] = withRole('citizen');
      for (const id of withRole('mafia')) act(id, c1);
      jest.advanceTimersByTime(MafiaHandler.NIGHT_TIME_MS);
      say(c2, '누가 죽었어?');
      for (const id of ids)
        expect(chatsOf(id).at(-1)).toMatchObject({
          text: '누가 죽었어?',
          scope: 'all',
        });
      say(c1, '나 죽었어');
      expect(chatsOf(c1).at(-1)).toMatchObject({
        text: '나 죽었어',
        scope: 'dead',
      });
      expect(chatsOf(c2).some((c) => c.text === '나 죽었어')).toBe(false);
    });

    it('밤에 마피아끼리 쓰던 말이 낮에 도착하면 공개하지 않고 버린다', async () => {
      await setup(6);
      const [m1] = withRole('mafia');
      const c1 = withRole('citizen')[0];
      handler.handleText(
        { roomName: R, text: '누구 죽일까', whisper: true },
        sockOf(m1),
      );
      expect(chatsOf(c1)).toHaveLength(0);
      jest.advanceTimersByTime(MafiaHandler.NIGHT_TIME_MS);
      handler.handleText(
        { roomName: R, text: '봇3 가자', whisper: true },
        sockOf(m1),
      );
      expect(receivedEvent(sockOf(m1), 'mafiaWhisperLate')).toHaveLength(1);
      for (const id of ids)
        expect(chatsOf(id).some((c) => c.text === '봇3 가자')).toBe(false);
    });
  });

  describe('나가기', () => {
    it('나간 사람은 죽은 것으로 치고 승패를 다시 본다', async () => {
      await setup(4);
      const mafia = withRole('mafia')[0];
      ctx.leaveRoom(sockOf(mafia), R);
      handler.handlePlayerLeft(room, mafia);
      // 4명 미만이 되어 인원 부족으로 끝남
      expect(room.mafia).toBeUndefined();
      expect(
        receivedEvent(
          socks.find((s) => s !== sockOf(mafia))!,
          'mafiaGameOver',
        )[0].data,
      ).toMatchObject({
        winner: 'none',
      });
    });

    it('5명 중 시민 하나가 나가면 계속하고, 밤에 할 일이 끝났으면 바로 넘어간다', async () => {
      await setup(5);
      const [c1, c2] = withRole('citizen');
      ctx.leaveRoom(sockOf(c1), R);
      handler.handlePlayerLeft(room, c1);
      expect(room.mafia).toBeDefined();
      expect(m().alive.has(c1)).toBe(false);
      night(c2);
      expect(m().phase).toBe('day');
    });
  });

  describe('밤 최소 시간', () => {
    it('할 일이 몇 초 만에 끝나도 최소 시간이 지나야 낮이 된다', async () => {
      await setup(6);
      const victim = withRole('citizen')[0];
      for (const id of withRole('mafia')) act(id, victim);
      act(withRole('police')[0], victim);
      act(withRole('doctor')[0], withRole('doctor')[0]);
      jest.advanceTimersByTime(MafiaHandler.MIN_NIGHT_MS - 1000);
      expect(m().phase).toBe('night');
      jest.advanceTimersByTime(1000);
      expect(m().phase).toBe('day');
      expect(m().alive.has(victim)).toBe(false);
    });
  });
});
