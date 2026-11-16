import { WebSocket } from 'ws';
import { GameContext } from '../game.context';
import { GameGateway } from '../game.gateway';
import { GameEngineFactory } from '../game-engine.factory';
import { StandardCardEngine } from '../engines/standard-card.engine';
import { SpiceEngine } from '../engines/spice.engine';
import { SkulkingEngine } from '../engines/skulking.engine';
import { GangHandler } from '../games/gang/gang.handler';
import { SpiceHandler } from '../games/spice/spice.handler';
import { SkulkingHandler } from '../games/skulking/skulking.handler';
import { Room } from '../game.types';
import { BotService } from './bot.service';
import { LiarHandler } from '../games/liar/liar.handler';
import { BotBrain, BotSelf } from './bot.brain';
import { createBotSocket, isBotId } from './bot.util';
import { createGangBot } from './gang.bot';
import { createSpiceBot } from './spice.bot';
import { createSkulkingBot } from './skulking.bot';
import { fakeDb } from '../../../test/game-test-utils';

jest.mock('../../database/supabase-admin', () => ({
  getSupabaseAdmin: jest.fn(),
}));

type Game = 'gang' | 'spice' | 'skulking';
/** 게임이 끝났다는 이벤트 (사람 자리에서 센다) */
const OVER: Record<Game, (e: string, d: Record<string, unknown>) => boolean> = {
  gang: (e, d) => e === 'gameFinished' && d.gameOver === true,
  spice: (e) => e === 'spiceGameOver',
  skulking: (e) => e === 'skulkingGameOver',
};

/**
 * 봇 시나리오: 게이트웨이를 거쳐(방 만들기·입장·봇 넣기·강퇴·나가기·연결 끊김) 진짜 흐름으로 본다.
 * 사람 자리도 같은 두뇌로 움직이되 id는 사람 것(봇 아님)이다
 */
describe('봇 시나리오 (게이트웨이 경유)', () => {
  let ctx: GameContext;
  let gang: GangHandler;
  let spice: SpiceHandler;
  let skulking: SkulkingHandler;
  let gateway: GameGateway;
  const R = 'room';
  let errs: string[];
  let autoActs: number;
  let overCount: Map<string, number>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ctx = new GameContext();
    const factory = new GameEngineFactory([
      new StandardCardEngine(),
      new SpiceEngine(),
      new SkulkingEngine(),
    ]);
    gang = new GangHandler(ctx, factory, fakeDb());
    spice = new SpiceHandler(ctx, factory, fakeDb());
    skulking = new SkulkingHandler(ctx, factory, fakeDb());
    gateway = new GameGateway(
      factory,
      ctx,
      gang,
      spice,
      skulking,
      {} as never,
      {} as never,
      {} as never,
      fakeDb(),
      new BotService(
        ctx,
        gang,
        spice,
        skulking,
        new LiarHandler(ctx, fakeDb()),
      ),
    );
    errs = [];
    autoActs = 0;
    overCount = new Map();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const brainFor = (game: Game, self: BotSelf): BotBrain =>
    game === 'gang'
      ? createGangBot(ctx, gang, self)
      : game === 'spice'
        ? createSpiceBot(ctx, spice, self)
        : createSkulkingBot(ctx, skulking, self);

  /** 사람 한 명 (두뇌로 자동 플레이). 받은 error·게임 종료·서버 대신 행동을 센다 */
  const human = (game: Game, id: string) => {
    let brain: BotBrain = () => {};
    const sock = createBotSocket((e, d) => {
      const data = (d ?? {}) as Record<string, unknown>;
      if (e === 'error') errs.push(`${id}: ${String(data.message)}`);
      if (OVER[game](e, data)) overCount.set(id, (overCount.get(id) ?? 0) + 1);
      if (e === 'skulkingBidUpdate' && data.autoSubmitted) autoActs++;
      if (e === 'cardPassed' && data.auto) autoActs++;
      brain(e, d);
    });
    // 진짜 소켓처럼 인증·방 목록에 등록 (게이트웨이가 쓴다). 사람은 봇 표시를 떼어 둔다
    (sock as unknown as { isBot?: boolean }).isBot = undefined;
    ctx.clientAuth.set(sock, id);
    ctx.clientRooms.set(sock, new Set());
    brain = brainFor(game, { id, sock, roomName: R });
    return sock;
  };

  /** 봇이 받는 error도 모은다 */
  const watchBots = (room: Room) => {
    for (const [sock, id] of room.playerIds) {
      if (!isBotId(id) || (sock as unknown as { watched?: boolean }).watched)
        continue;
      (sock as unknown as { watched: boolean }).watched = true;
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
  };

  const setup = (game: Game, humans: string[], bots: number) => {
    const host = human(game, humans[0]);
    gateway.handleCreateRoom(
      { name: R, nickname: humans[0], gameType: game },
      host,
    );
    const others = humans.slice(1).map((id) => {
      const s = human(game, id);
      gateway.handleJoinRoom({ name: R, nickname: id }, s);
      return s;
    });
    for (let i = 0; i < bots; i++) gateway.handleAddBot({ roomName: R }, host);
    const room = ctx.rooms.get(R)!;
    watchBots(room);
    return { host, others, room };
  };

  const start = async (host: WebSocket) => {
    await gateway.handleStartGame({ roomName: R }, host);
  };

  /** 조건이 될 때까지 1초씩 (최대 maxSec) */
  const runUntil = async (cond: () => boolean, maxSec = 7200) => {
    let sec = 0;
    while (!cond() && sec < maxSec) {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      sec++;
    }
    return sec;
  };

  describe('1. 게임이 끝난 뒤 봇과 다시 시작', () => {
    it.each(['gang', 'spice', 'skulking'] as Game[])(
      '%s: 두 게임을 연달아 끝까지 한다',
      async (game) => {
        const { host, room } = setup(game, ['host-uuid'], 3);
        await start(host);
        await runUntil(() => (overCount.get('host-uuid') ?? 0) >= 1);
        expect(overCount.get('host-uuid')).toBe(1);
        expect(room.gameStarted).toBe(false);
        // 결과를 잠깐 본 뒤 방장이 다시 시작
        jest.advanceTimersByTime(5000);
        await start(host);
        await runUntil(() => (overCount.get('host-uuid') ?? 0) >= 2);
        expect(overCount.get('host-uuid')).toBe(2);
        expect([...room.playerIds.values()].filter(isBotId)).toHaveLength(3);
        expect(errs).toEqual([]);
        expect(autoActs).toBe(0);
      },
    );
  });

  describe('2. 실제 강퇴 경로로 봇 내보내기', () => {
    it('강퇴한 봇은 빠지고 소켓이 닫히며, 남은 사람·봇으로 게임이 끝까지 간다', async () => {
      const { host, room } = setup('gang', ['host-uuid'], 3);
      const [kickId, kickSock] = [...room.playerIds]
        .map(([s, id]) => [id, s] as const)
        .find(([id]) => isBotId(id))!;
      gateway.handleKickPlayer({ roomName: R, targetPlayerId: kickId }, host);
      expect(room.playerIds.has(kickSock)).toBe(false);
      expect(kickSock.readyState).toBe(WebSocket.CLOSED);
      expect(room.clients.size).toBe(3);
      await start(host);
      await runUntil(() => (overCount.get('host-uuid') ?? 0) >= 1);
      expect(overCount.get('host-uuid')).toBe(1);
      expect(errs).toEqual([]);
    });
  });

  describe('3. 게임 도중 사람이 나가거나 끊김', () => {
    it.each(['gang', 'spice', 'skulking'] as Game[])(
      '%s: 사람 2명 + 봇 2명 판에서 한 사람이 나가도 남은 사람·봇으로 끝까지 간다',
      async (game) => {
        const { host, others, room } = setup(
          game,
          ['host-uuid', 'guest-uuid'],
          2,
        );
        await start(host);
        await runUntil(() => room.gameStarted, 60);
        await runUntil(() => false, 40); // 한참 진행된 뒤
        gateway.handleLeaveRoom({ name: R }, others[0]);
        expect(room.clients.size).toBe(3);
        expect(room.hostPlayerId).toBe('host-uuid');
        await runUntil(() => (overCount.get('host-uuid') ?? 0) >= 1);
        expect(overCount.get('host-uuid')).toBe(1);
        expect(errs).toEqual([]);
      },
    );

    it('방장이 나가면 봇이 아니라 남은 사람이 방장이 된다', () => {
      const { host, room } = setup('gang', ['host-uuid', 'guest-uuid'], 2);
      gateway.handleLeaveRoom({ name: R }, host);
      expect(room.hostPlayerId).toBe('guest-uuid');
    });

    it.each(['gang', 'spice', 'skulking'] as Game[])(
      '%s: 마지막 사람이 게임 중에 끊기면 30초 동안은 기다리고, 그 뒤 봇과 함께 방이 정리된다',
      async (game) => {
        const { host, room } = setup(game, ['host-uuid'], 3);
        const botSocks = [...room.playerIds]
          .filter(([, id]) => isBotId(id))
          .map(([s]) => s);
        await start(host);
        await runUntil(() => false, 15);
        (host as unknown as { readyState: number }).readyState =
          WebSocket.CLOSED;
        gateway.handleDisconnect(host);
        await runUntil(() => false, 25);
        expect(ctx.rooms.has(R)).toBe(true); // 아직 유예 중
        await runUntil(() => false, 10);
        expect(ctx.rooms.has(R)).toBe(false);
        expect(botSocks.every((s) => s.readyState === WebSocket.CLOSED)).toBe(
          true,
        );
        // 남은 타이머가 돌아도 문제가 없다
        const errorsBefore = (console.error as jest.Mock).mock.calls.length;
        await runUntil(() => false, 300);
        expect((console.error as jest.Mock).mock.calls.length).toBe(
          errorsBefore,
        );
      },
    );
  });

  describe('4. 6명 꽉 찬 판', () => {
    it.each(['gang', 'spice', 'skulking'] as Game[])(
      '%s: 사람 1명 + 봇 5명이 끝까지 간다',
      async (game) => {
        const { host, room } = setup(game, ['host-uuid'], 5);
        expect(room.clients.size).toBe(6);
        gateway.handleAddBot({ roomName: R }, host); // 7번째는 거절
        jest.advanceTimersByTime(1); // 소켓 이벤트는 다음 틱에 도착
        expect(room.clients.size).toBe(6);
        expect(errs).toContain('host-uuid: 방이 가득 찼습니다 (최대 6명)');
        errs.length = 0;
        await start(host);
        await runUntil(() => (overCount.get('host-uuid') ?? 0) >= 1, 10800);
        expect(overCount.get('host-uuid')).toBe(1);
        expect(errs).toEqual([]);
        expect(autoActs).toBe(0);
      },
    );
  });
});
