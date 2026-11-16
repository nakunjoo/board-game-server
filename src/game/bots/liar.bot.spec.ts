import { GameContext } from '../game.context';
import { GameEngineFactory } from '../game-engine.factory';
import { GangHandler } from '../games/gang/gang.handler';
import { SpiceHandler } from '../games/spice/spice.handler';
import { SkulkingHandler } from '../games/skulking/skulking.handler';
import { LiarHandler } from '../games/liar/liar.handler';
import { Room } from '../game.types';
import { BotService } from './bot.service';
import { BotBrain } from './bot.brain';
import { createBotSocket, isBotId } from './bot.util';
import { createLiarBot } from './liar.bot';
import { callLlm, LlmCall, LlmRequest } from './llm';
import { addRoom, fakeDb } from '../../../test/game-test-utils';

const normalize = (s: string) =>
  s.replace(/[\s\p{P}\p{S}ㄱ-ㆎ]/gu, '').toLowerCase();

describe('라이어 봇', () => {
  let ctx: GameContext;
  let liar: LiarHandler;
  let bots: BotService;
  const R = 'room';
  let errs: string[];
  let blocked: number;
  let over: number;
  let calls: LlmRequest[];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ctx = new GameContext();
    const f = new GameEngineFactory([]);
    liar = new LiarHandler(ctx, fakeDb());
    bots = new BotService(
      ctx,
      new GangHandler(ctx, f, fakeDb()),
      new SpiceHandler(ctx, f, fakeDb()),
      new SkulkingHandler(ctx, f, fakeDb()),
      liar,
    );
    errs = [];
    blocked = 0;
    over = 0;
    calls = [];
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** 방장 자리도 같은 두뇌(같은 LLM)로. 봇 3명. 받은 error·막힌 말·게임 종료를 센다 */
  const setup = (llm: LlmCall, botCount = 3) => {
    const wrapped: LlmCall = (req) => {
      calls.push(req);
      return llm(req);
    };
    bots.llm = wrapped;
    let brain: BotBrain = () => {};
    const count = (e: string, d: unknown) => {
      if (e === 'error') errs.push((d as { message: string }).message);
      if (e === 'liarBlocked') blocked++;
    };
    const host = createBotSocket((e, d) => {
      count(e, d);
      if (e === 'liarGameOver') over++; // 게임 종료는 방장 자리에서만 센다
      brain(e, d);
    });
    const room = addRoom(ctx, R, 'liar', [[host, 'host-uuid']]);
    brain = createLiarBot(
      ctx,
      liar,
      { id: 'host-uuid', sock: host, roomName: R },
      wrapped,
    );
    for (let i = 0; i < botCount; i++) bots.addBot({ roomName: R }, host, 8);
    for (const [sock, id] of room.playerIds) {
      if (!isBotId(id)) continue;
      const orig = sock.send.bind(sock);
      (sock as unknown as { send: (raw: string) => void }).send = (raw) => {
        const m = JSON.parse(raw) as { event: string; data: unknown };
        count(m.event, m.data);
        orig(raw);
      };
    }
    return { host, room };
  };

  const play = async (room: Room, host: never, rounds = 3) => {
    await liar.handleStart(
      { roomName: R, rounds, laps: 1, discussTimeSec: 60 },
      host,
    );
    const descs: { text: string; skipped: boolean; word: string }[] = [];
    let seen = 0;
    for (let s = 0; s < 3600 && over === 0; s++) {
      jest.advanceTimersByTime(1000);
      // LLM 응답(Promise)이 돌 수 있게
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const st = room.liar;
      if (st && st.descriptions.length > seen) {
        for (const d of st.descriptions.slice(seen))
          descs.push({
            ...d,
            word: d.playerId === st.liarId ? st.liarWord : st.word,
          });
        seen = st.descriptions.length;
      }
      if (st && st.descriptions.length < seen) seen = 0; // 새 판
    }
    return descs;
  };

  it('LLM이 없으면(키 없음) 미리 써 둔 문장으로 3판을 끝까지 한다', async () => {
    const { host, room } = setup(() => Promise.resolve(null));
    const descs = await play(room, host as never);
    expect(over).toBe(1);
    expect(errs).toEqual([]);
    expect(blocked).toBe(0);
    // 시간 초과 없이 직접 설명했다
    expect(descs.length).toBe(12);
    expect(descs.every((d) => !d.skipped)).toBe(true);
  });

  it('LLM 답을 쓰되, 자기 단어가 들어간 답은 버리고 대신 말한다', async () => {
    const { host, room } = setup((req) => {
      // 설명 요청이면 절반은 일부러 자기 단어를 넣어 본다
      const word = /내 제시어: (.+)/.exec(req.user)?.[1] ?? '';
      if (req.user.includes('내 설명:'))
        return Promise.resolve(
          Math.random() < 0.5 ? `"${word} 같은 거"` : '1. 생각보다 자주 봐요',
        );
      if (req.user.includes('투표할 이름:')) {
        const names = /후보: (.+)/.exec(req.user)?.[1].split(', ') ?? [];
        return Promise.resolve(`${names[0]}이 수상해`);
      }
      return Promise.resolve('흠 누구지');
    });
    const descs = await play(room, host as never);
    expect(over).toBe(1);
    expect(errs).toEqual([]);
    expect(blocked).toBe(0);
    for (const d of descs)
      expect(normalize(d.text).includes(normalize(d.word))).toBe(false);
    // 번호·따옴표를 떼고 한 줄로
    expect(descs.some((d) => d.text === '생각보다 자주 봐요')).toBe(true);
  });

  it('LLM이 너무 늦으면 차례를 놓쳐도 엉뚱한 때 설명을 보내지 않는다', async () => {
    const { host, room } = setup(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve('늦게 온 설명'), 40_000),
        ),
    );
    const descs = await play(room, host as never, 1);
    expect(over).toBe(1);
    expect(errs).toEqual([]);
    // 모두 시간 초과로 넘어갔고, 늦게 온 답이 남의 차례에 끼어들지 않았다
    expect(descs.every((d) => d.skipped)).toBe(true);
    expect(descs.some((d) => d.text === '늦게 온 설명')).toBe(false);
  });

  it('투표는 LLM이 고른 이름을 따른다', async () => {
    const { host, room } = setup((req) => {
      if (req.user.includes('투표할 이름:')) {
        const names = /후보: (.+)/.exec(req.user)?.[1].split(', ') ?? [];
        // 방장이 아닌 사람이면 방장을, 방장이면 첫 후보를
        const target = names.find((n) => n === 'nick-host-uuid') ?? names[0];
        return Promise.resolve(target);
      }
      return Promise.resolve(null);
    });
    await liar.handleStart(
      { roomName: R, rounds: 1, laps: 1, discussTimeSec: 60 },
      host as never,
    );
    for (let s = 0; s < 200 && room.liar?.phase !== 'discuss'; s++) {
      jest.advanceTimersByTime(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    const botVoted = () =>
      [...(room.liar?.votes.keys() ?? [])].filter(isBotId).length;
    for (let s = 0; s < 60 && botVoted() < 3; s++) {
      jest.advanceTimersByTime(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    const votes = [...(room.liar?.votes ?? new Map<string, string>())];
    const botVotes = votes.filter(([voter]) => isBotId(voter));
    expect(botVotes.length).toBe(3);
    expect(botVotes.every(([, target]) => target === 'host-uuid')).toBe(true);
  });

  it('설명 차례에 넘기는 정보에 남의 단어·라이어가 누군지는 없다', async () => {
    const { host, room } = setup(() => Promise.resolve(null));
    await liar.handleStart(
      { roomName: R, rounds: 1, laps: 1, discussTimeSec: 60 },
      host as never,
    );
    for (let s = 0; s < 120 && room.liar?.phase !== 'discuss'; s++) {
      jest.advanceTimersByTime(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    const st = room.liar!;
    const descCalls = calls.filter((c) => c.user.includes('내 설명:'));
    expect(descCalls.length).toBeGreaterThan(0);
    for (const c of descCalls) {
      const mine = /내 제시어: (.+)/.exec(c.user)![1];
      const other = mine === st.word ? st.liarWord : st.word;
      expect(c.user + c.system).not.toContain(other);
      expect(c.user + c.system).not.toMatch(/라이어는 [^\n]*님/);
    }
  });
});

describe('callLlm', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('키가 없으면 호출하지 않고 null', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchSpy = jest.spyOn(global, 'fetch');
    expect(await callLlm({ system: 's', user: 'u' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('응답의 첫 답을 돌려주고, 실패하면 null', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: ' 짧은 설명 ' } }],
        }),
      ),
    );
    expect(await callLlm({ system: 's', user: 'u' })).toBe('짧은 설명');
    const body = JSON.parse(
      fetchSpy.mock.calls[0][1]?.body as string,
    ) as Record<string, unknown>;
    expect(body.model).toBe('gpt-5-mini');
    expect(body.reasoning_effort).toBe('minimal');
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    expect(await callLlm({ system: 's', user: 'u' })).toBeNull();
  });

  it('하루 한도를 넘으면 null', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.BOT_LLM_DAILY_LIMIT = '0';
    const fetchSpy = jest.spyOn(global, 'fetch');
    expect(await callLlm({ system: 's', user: 'u' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
