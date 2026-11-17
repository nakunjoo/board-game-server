import { GameContext } from '../game.context';
import { GameEngineFactory } from '../game-engine.factory';
import { GangHandler } from '../games/gang/gang.handler';
import { SpiceHandler } from '../games/spice/spice.handler';
import { SkulkingHandler } from '../games/skulking/skulking.handler';
import { LiarHandler } from '../games/liar/liar.handler';
import { MafiaHandler } from '../games/mafia/mafia.handler';
import { Room } from '../game.types';
import { BotService } from './bot.service';
import { BotBrain } from './bot.brain';
import { createBotSocket, isBotId } from './bot.util';
import { createMafiaBot } from './mafia.bot';
import { LlmCall, LlmRequest } from './llm';
import { addRoom, fakeDb } from '../../../test/game-test-utils';

describe('마피아 봇', () => {
  let ctx: GameContext;
  let mafia: MafiaHandler;
  let bots: BotService;
  const R = 'room';
  let errs: string[];
  let over: Record<string, unknown> | null;
  let calls: LlmRequest[];
  let chats: { id: string; text: string; scope: string }[];
  let dayLengths: number[];
  let dayStart: number;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ctx = new GameContext();
    const f = new GameEngineFactory([]);
    mafia = new MafiaHandler(ctx, fakeDb());
    bots = new BotService(
      ctx,
      new GangHandler(ctx, f, fakeDb()),
      new SpiceHandler(ctx, f, fakeDb()),
      new SkulkingHandler(ctx, f, fakeDb()),
      new LiarHandler(ctx, fakeDb()),
      mafia,
    );
    errs = [];
    over = null;
    calls = [];
    chats = [];
    dayLengths = [];
    dayStart = 0;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** 방장 자리도 같은 두뇌로 */
  const setup = (n: number, llm: LlmCall) => {
    const wrapped: LlmCall = (req) => {
      calls.push(req);
      return llm(req);
    };
    bots.llm = wrapped;
    let brain: BotBrain = () => {};
    const host = createBotSocket((e, d) => {
      const data = d as Record<string, unknown>;
      if (e === 'error') errs.push(String(data.message));
      if (e === 'mafiaGameOver') over = data;
      if (e === 'mafiaDay') dayStart = Date.now();
      if (e === 'mafiaExecuted') dayLengths.push(Date.now() - dayStart);
      if (e === 'mafiaChat')
        chats.push({
          id: String(data.playerId),
          text: String(data.text),
          scope: String(data.scope),
        });
      brain(e, d);
    });
    const room = addRoom(ctx, R, 'mafia', [[host, 'host-uuid']]);
    brain = createMafiaBot(
      ctx,
      mafia,
      { id: 'host-uuid', sock: host, roomName: R },
      wrapped,
    );
    for (let i = 0; i < n - 1; i++) bots.addBot({ roomName: R }, host, 8);
    for (const [sock, id] of room.playerIds) {
      if (!isBotId(id)) continue;
      const orig = sock.send.bind(sock);
      (sock as unknown as { send: (raw: string) => void }).send = (raw) => {
        const m = JSON.parse(raw) as {
          event: string;
          data: { message: string };
        };
        if (m.event === 'error') errs.push(`${id}: ${m.data.message}`);
        orig(raw);
      };
    }
    return { host, room };
  };

  const play = async (room: Room, host: never) => {
    await mafia.handleStart({ roomName: R, discussTimeSec: 90 }, host);
    const votes: {
      day: number;
      voter: string;
      target: string;
      team: string[];
    }[] = [];
    for (let s = 0; s < 3600 && !over; s++) {
      const st = room.mafia;
      if (st?.phase === 'day') {
        const team = [...st.roles]
          .filter(([, r]) => r === 'mafia')
          .map(([id]) => id);
        for (const [voter, target] of st.votes)
          if (!votes.some((v) => v.day === st.day && v.voter === voter))
            votes.push({ day: st.day, voter, target, team });
      }
      jest.advanceTimersByTime(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    return votes;
  };

  it.each([4, 6, 8])('%i명: LLM 없이도 승부가 날 때까지 간다', async (n) => {
    const { room, host } = setup(n, () => Promise.resolve(null));
    const votes = await play(room, host as never);
    expect(over).not.toBeNull();
    expect(['mafia', 'citizens']).toContain(over!.winner);
    expect(errs).toEqual([]);
    // 마피아는 동료에게 투표하지 않는다
    for (const v of votes)
      if (v.team.includes(v.voter))
        expect(v.team.includes(v.target)).toBe(false);
  });

  it('마피아 봇은 밤에 마피아끼리만 말하고, 낮에 자기가 마피아라고 말하지 않는다', async () => {
    const { room, host } = setup(6, (req) =>
      Promise.resolve(
        req.user.includes('내 채팅:') ? '나 마피아야 ㅋㅋ' : null,
      ),
    );
    await play(room, host as never);
    const result = over as unknown as { roles: Record<string, string> };
    for (const c of chats) {
      if (result.roles[c.id] === 'mafia' && c.scope === 'all')
        expect(c.text).not.toMatch(/나\s*(는|가)?\s*마피아/);
    }
  });

  it('LLM에 넘기는 내용에 남의 역할은 없다 (마피아는 동료, 경찰은 자기 조사 결과만)', async () => {
    const { room, host } = setup(6, () => Promise.resolve(null));
    await play(room, host as never);
    const result = over as unknown as {
      roles: Record<string, string>;
      nicknames: Record<string, string>;
    };
    for (const c of calls) {
      const me = Object.entries(result.nicknames).find(([, n]) =>
        c.system.includes(`"${n}"`),
      )?.[0];
      if (!me) continue;
      if (result.roles[me] === 'citizen' || result.roles[me] === 'doctor') {
        expect(c.system).not.toContain('동료:');
        expect(c.system).not.toContain('조사 결과:');
      }
    }
  });

  // LLM 없이 측정한 승률(60판): 4명 마피아 48%, 6명 70%, 8명 72%. 20판이면 한쪽만 이길 확률은 0.1% 미만
  it('여러 판 돌려도 한쪽만 이기지 않는다 (6명)', async () => {
    const wins = { mafia: 0, citizens: 0 };
    for (let g = 0; g < 20; g++) {
      ctx.rooms.delete(R);
      over = null;
      const { room, host } = setup(6, () => Promise.resolve(null));
      await play(room, host as never);
      const w = (over as unknown as { winner: 'mafia' | 'citizens' }).winner;
      wins[w]++;
      jest.clearAllTimers();
    }
    expect(wins.mafia).toBeGreaterThan(0);
    expect(wins.citizens).toBeGreaterThan(0);
  });

  it('봇 투표 때문에 낮이 일찍 끝나지 않는다 (토론 시간의 60% 이상)', async () => {
    const { room, host } = setup(6, () => Promise.resolve(null));
    await play(room, host as never);
    expect(dayLengths.length).toBeGreaterThan(0);
    for (const ms of dayLengths)
      expect(ms).toBeGreaterThanOrEqual(90_000 * 0.6);
  });

  it('LLM 없이도 봇끼리 같은 말을 되풀이하지 않는다', async () => {
    const { room, host } = setup(6, () => Promise.resolve(null));
    await play(room, host as never);
    const said = chats.filter((c) => c.scope === 'all').map((c) => c.text);
    expect(said.length).toBeGreaterThan(5);
    const first = said.slice(0, 15);
    expect(new Set(first).size).toBe(first.length);
  });

  it('LLM이 같은 말을 내놓으면 버리고 다른 말을 한다', async () => {
    const { room, host } = setup(6, (req) =>
      Promise.resolve(req.user.includes('내 채팅:') ? '누가 마피아일까' : null),
    );
    await play(room, host as never);
    const said = chats.filter((c) => c.scope === 'all').map((c) => c.text);
    // 최근 40마디 안에서는 한 번만 (아주 오래전에 한 말은 다시 나올 수 있다)
    const recent = said.slice(0, 40);
    expect(recent.filter((t) => t === '누가 마피아일까').length).toBe(1);
  });
});
