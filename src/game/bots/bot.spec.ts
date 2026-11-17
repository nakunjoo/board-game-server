import { WebSocket } from 'ws';
import { GameContext } from '../game.context';
import { GameEngineFactory } from '../game-engine.factory';
import { StandardCardEngine } from '../engines/standard-card.engine';
import { SpiceEngine } from '../engines/spice.engine';
import { SkulkingEngine } from '../engines/skulking.engine';
import { GangHandler } from '../games/gang/gang.handler';
import { SpiceHandler } from '../games/spice/spice.handler';
import { SkulkingHandler } from '../games/skulking/skulking.handler';
import { DatabaseService } from '../../database/database.service';
import { Card, Room } from '../game.types';
import { BotService } from './bot.service';
import { MafiaHandler } from '../games/mafia/mafia.handler';
import { LiarHandler } from '../games/liar/liar.handler';
import { createBotSocket, isBotId } from './bot.util';
import { createGangBot } from './gang.bot';
import { createSpiceBot } from './spice.bot';
import { createSkulkingBot } from './skulking.bot';
import { skulkingBid } from './skulking.bot';
import { spiceChoose } from './spice.bot';
import {
  addRoom,
  errors,
  fakeDb,
  fakeSocket,
  receivedEvent,
} from '../../../test/game-test-utils';

describe('봇', () => {
  let ctx: GameContext;
  let gang: GangHandler;
  let spice: SpiceHandler;
  let skulking: SkulkingHandler;
  let bots: BotService;
  const R = 'room';

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
    bots = new BotService(
      ctx,
      gang,
      spice,
      skulking,
      new LiarHandler(ctx, fakeDb()),
      new MafiaHandler(ctx, fakeDb()),
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const botIds = (room: Room) => [...room.playerIds.values()].filter(isBotId);

  describe('넣고 빼기', () => {
    it('방장만, 게임 시작 전에만, 지원하는 게임에만, 정원까지만 넣을 수 있다', () => {
      const host = fakeSocket();
      const guest = fakeSocket();
      const room = addRoom(ctx, R, 'gang', [
        [host, 'h'],
        [guest, 'g'],
      ]);
      bots.addBot({ roomName: R }, guest, 6);
      expect(errors(guest)).toContain('방장만 봇을 넣고 뺄 수 있습니다');

      for (let i = 0; i < 6; i++) bots.addBot({ roomName: R }, host, 6);
      expect(room.clients.size).toBe(6);
      expect(errors(host)).toContain('방이 가득 찼습니다 (최대 6명)');
      expect([...room.nicknames.values()]).toEqual(
        expect.arrayContaining(['🤖봇1', '🤖봇2', '🤖봇3', '🤖봇4']),
      );
      // 들어올 때 사람과 같은 userJoined
      expect(receivedEvent(guest, 'userJoined')).toHaveLength(4);

      room.gameStarted = true;
      bots.removeBot({ roomName: R }, host);
      expect(errors(host)).toContain('게임 중에는 봇을 넣고 뺄 수 없습니다');

      const h2 = fakeSocket();
      addRoom(ctx, 'draw', 'drawing', [[h2, 'h2']]);
      bots.addBot({ roomName: 'draw' }, h2, 6);
      expect(errors(h2)).toContain('이 게임은 아직 봇을 지원하지 않습니다');
    });

    it('빼면 마지막 봇(또는 지정한 봇)이 나가고 userLeft가 간다', () => {
      const host = fakeSocket();
      const room = addRoom(ctx, R, 'spice', [[host, 'h']]);
      bots.addBot({ roomName: R }, host, 6);
      bots.addBot({ roomName: R }, host, 6);
      const [first, second] = botIds(room);
      bots.removeBot({ roomName: R }, host);
      expect(botIds(room)).toEqual([first]);
      bots.removeBot({ roomName: R, playerId: first }, host);
      expect(botIds(room)).toEqual([]);
      expect(
        receivedEvent(host, 'userLeft').map((m) => m.data.playerId),
      ).toEqual([second, first]);
    });

    it('사람이 모두 나가면 봇도 빠지고 방이 닫힌다', () => {
      const host = fakeSocket();
      addRoom(ctx, R, 'gang', [[host, 'h']]);
      bots.addBot({ roomName: R }, host, 6);
      bots.addBot({ roomName: R }, host, 6);
      ctx.leaveRoom(host, R);
      expect(ctx.rooms.has(R)).toBe(false);
    });

    it('방장이 나가도 봇은 방장이 되지 않는다', () => {
      const host = fakeSocket();
      const guest = fakeSocket();
      const room = addRoom(ctx, R, 'gang', [[host, 'h']]);
      bots.addBot({ roomName: R }, host, 6);
      room.clients.add(guest);
      room.playerIds.set(guest, 'g');
      room.nicknames.set(guest, 'nick-g');
      ctx.leaveRoom(host, R);
      expect(room.hostPlayerId).toBe('g');
    });
  });

  describe('전적', () => {
    it('봇은 DB에 넣지 않고, 사람 기록은 그대로 저장한다', async () => {
      const save = jest.fn((rows: unknown) => Promise.resolve(rows));
      const create = jest.fn((x: unknown) => x);
      const update = jest.fn(() => Promise.resolve({}));
      const count = jest.fn(() => Promise.resolve(0));
      const db = new DatabaseService(
        {} as never,
        { save, create, update } as never,
        { count } as never,
      );
      await db.insertPlayerResults([
        { sessionId: 's', userId: 'user-uuid', nickname: '사람' },
        { sessionId: 's', userId: 'bot:abc', nickname: '🤖봇1' },
      ]);
      expect(save.mock.calls[0][0]).toEqual([
        expect.objectContaining({ userId: 'user-uuid' }),
      ]);
      await db.finalizePlayerResult({
        sessionId: 's',
        userId: 'bot:abc',
        isWinner: true,
      });
      await db.markAbandoned('s', 'bot:abc');
      expect(update).not.toHaveBeenCalled();
      expect(await db.isAdmin('bot:abc')).toBe(false);
      expect(count).not.toHaveBeenCalled();
    });
  });

  describe('판단', () => {
    it('스컬킹 비드: 센 카드가 많을수록 높고, 라운드 수를 넘지 않는다', () => {
      const c = (type: string, value = 0) =>
        ({ type, value, image: '', name: '' }) as Card;
      expect(skulkingBid([c('sk-escape'), c('sk-yellow', 2)], 2, 4)).toBe(0);
      expect(
        skulkingBid(
          [c('sk-skulking'), c('sk-pirate'), c('sk-pirate'), c('sk-black', 13)],
          4,
          3,
        ),
      ).toBeGreaterThanOrEqual(3);
      expect(skulkingBid(Array(3).fill(c('sk-skulking')), 2, 2)).toBe(2);
    });

    it('향신료: 참말로 낼 수 있으면 가장 작은 숫자로 낸다', () => {
      const c = (type: string, value: number) =>
        ({ type, value, image: '', name: '' }) as Card;
      const hand = [c('pepper', 9), c('pepper', 5), c('saffron', 6)];
      expect(spiceChoose(hand, 'pepper', 4, () => 0.99)).toEqual({
        cardIndex: 1,
        declaredSuit: 'pepper',
        declaredNumber: 5,
      });
      // 리셋(10 이후)이면 1~3만
      expect(spiceChoose([c('cinnamon', 2)], 'pepper', 10, () => 0.99)).toEqual(
        {
          cardIndex: 0,
          declaredSuit: 'cinnamon',
          declaredNumber: 2,
        },
      );
      // 낼 게 없고 거짓말도 안 하면 패스
      expect(
        spiceChoose([c('pepper', 2), c('pepper', 1)], 'pepper', 8, () => 0.99),
      ).toBeNull();
    });
  });

  /**
   * 사람 자리(방장)도 같은 두뇌로 움직여서, 봇만으로 게임이 끝까지 가는지 본다.
   * 봇이 서버에게 거절당한(error) 행동이 없어야 한다
   */
  describe('끝까지 진행', () => {
    const events = (sock: WebSocket) =>
      (
        sock as unknown as {
          _events: { event: string; data: Record<string, unknown> }[];
        }
      )._events;
    const autoBids = (sock: WebSocket) =>
      events(sock).filter(
        (m) => m.event === 'skulkingBidUpdate' && m.data.autoSubmitted,
      ).length;
    const autoPasses = (sock: WebSocket) =>
      events(sock).filter((m) => m.event === 'cardPassed' && m.data.auto)
        .length;
    const run = async (
      gameType: 'gang' | 'spice' | 'skulking',
      botCount: number,
      done: (room: Room) => boolean,
      maxSec = 3600,
    ) => {
      const brains = {
        gang: (self: Parameters<typeof createGangBot>[2]) =>
          createGangBot(ctx, gang, self),
        spice: (self: Parameters<typeof createSpiceBot>[2]) =>
          createSpiceBot(ctx, spice, self),
        skulking: (self: Parameters<typeof createSkulkingBot>[2]) =>
          createSkulkingBot(ctx, skulking, self),
      };
      const errs: string[] = [];
      let brain: (e: string, d: unknown) => void = () => {};
      const seen: { event: string; data: Record<string, unknown> }[] = [];
      const host = createBotSocket((e, d) => {
        seen.push({ event: e, data: d as Record<string, unknown> });
        if (e === 'error')
          errs.push(`host: ${(d as { message: string }).message}`);
        brain(e, d);
      });
      (host as unknown as { _events: typeof seen })._events = seen;
      const room = addRoom(ctx, R, gameType, [[host, 'host-uuid']]);
      brain = brains[gameType]({ id: 'host-uuid', sock: host, roomName: R });
      for (let i = 0; i < botCount; i++) bots.addBot({ roomName: R }, host, 6);
      // 봇이 받은 error를 모은다
      for (const [sock, id] of room.playerIds) {
        if (!isBotId(id)) continue;
        const orig = sock.send.bind(sock);
        (sock as unknown as { send: (raw: string) => void }).send = (
          raw: string,
        ) => {
          const m = JSON.parse(raw) as {
            event: string;
            data: { message: string };
          };
          if (m.event === 'error') errs.push(`${id}: ${m.data.message}`);
          orig(raw);
        };
      }
      if (gameType === 'gang')
        await gang.handleStartGame({ roomName: R }, host);
      if (gameType === 'spice') spice.handleStartGame({ roomName: R }, host);
      if (gameType === 'skulking')
        await skulking.handleStartGame({ roomName: R }, host);
      // 향신료는 선뽑기 동안 아직 gameStarted가 아니다
      expect(room.gameStarted || !!room.state.firstDraw).toBe(true);

      let sec = 0;
      while (!done(room) && sec < maxSec) {
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
        sec++;
      }
      return { room, errs, sec, host };
    };

    it('갱스터: 방장 + 봇 3명이 3승이나 3패까지 간다', async () => {
      const { room, errs, sec } = await run('gang', 3, (r) => !!r.gameOver);
      expect(room.gameOver).toBe(true);
      expect(['victory', 'defeat']).toContain(room.gameOverResult);
      expect(errs).toEqual([]);
      expect(sec).toBeLessThan(3600);
    });

    it('스컬킹: 방장 + 봇 3명이 10라운드를 끝낸다', async () => {
      const { room, errs, sec, host } = await run(
        'skulking',
        3,
        (r) => !!r.skulkingGameOverResult,
        7200,
      );
      expect(room.skulkingGameOverResult).toBeDefined();
      expect(errs).toEqual([]);
      // 서버가 시간 초과로 대신 낸 게 아니라 봇이 직접 냈는지: 비드 자동 제출이 없고,
      // 전체 시간이 타이머(차례마다 20초)로 갔을 때보다 훨씬 짧다 (55장 × 20초 = 1100초 이상)
      expect(autoBids(host)).toBe(0);
      expect(sec).toBeLessThan(600);
    });

    it('향신료: 방장 + 봇 3명이 게임 종료까지 간다', async () => {
      const { room, errs, host } = await run(
        'spice',
        3,
        (r) => !!r.spiceGameOverMeta,
        7200,
      );
      expect(room.spiceGameOverMeta).toBeDefined();
      // 30초 시간 초과로 서버가 대신 패스한 차례가 없어야 한다
      expect(autoPasses(host)).toBe(0);
      // 늦은 도전은 에러가 아니라 challengeTooLate로 온다
      expect(errs).toEqual([]);
    });
  });
});
