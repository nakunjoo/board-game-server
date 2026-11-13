import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { GameContext } from './game.context';
import { GameGateway } from './game.gateway';
import { Room } from './game.types';
import { getSupabaseAdmin } from '../database/supabase-admin';
import {
  addRoom,
  errors,
  fakeDb,
  fakeSocket,
  receivedEvent,
} from '../../test/game-test-utils';

jest.mock('../database/supabase-admin', () => ({
  getSupabaseAdmin: jest.fn(),
}));

describe('GameGateway', () => {
  let ctx: GameContext;
  let gang: { handleStartGame: jest.Mock };
  let casino: { handleStart: jest.Mock };
  let gateway: GameGateway;
  let host: WebSocket;

  function connectAs(playerId: string): WebSocket {
    const sock = fakeSocket();
    ctx.clientAuth.set(sock, playerId);
    ctx.clientRooms.set(sock, new Set());
    return sock;
  }

  function privateRoom(): Room {
    const room = addRoom(ctx, 'secret', 'gang', [[host, 'HOST']]);
    room.password = '1234';
    ctx.clientRooms.set(host, new Set(['secret']));
    return room;
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    ctx = new GameContext();
    gang = { handleStartGame: jest.fn() };
    casino = { handleStart: jest.fn() };
    gateway = new GameGateway(
      {} as any,
      ctx,
      gang as any,
      {} as any,
      {} as any,
      casino as any,
      {} as any,
      fakeDb(),
    );
    host = fakeSocket();
  });

  afterEach(() => {
    for (const room of ctx.rooms.values()) {
      room.disconnectTimers.forEach((t) => clearTimeout(t));
    }
    jest.restoreAllMocks();
  });

  describe('async 핸들러 예외', () => {
    it('casinoStart의 rejection을 반환해 Nest가 잡을 수 있게 한다', async () => {
      casino.handleStart.mockRejectedValue(new TypeError('bad payload'));
      await expect(gateway.handleCasinoStart({} as any, host)).rejects.toThrow('bad payload');
    });

    it('startGame의 rejection을 반환해 Nest가 잡을 수 있게 한다', async () => {
      gang.handleStartGame.mockRejectedValue(new Error('db down'));
      await expect(
        gateway.handleStartGame({ roomName: 'none' }, host),
      ).rejects.toThrow('db down');
    });

    it('카지노 방의 startGame은 Gang 핸들러로 넘기지 않는다', () => {
      addRoom(ctx, 'c', 'casino', [[host, 'HOST']]);
      gateway.handleStartGame({ roomName: 'c' }, host);
      expect(gang.handleStartGame).not.toHaveBeenCalled();
    });
  });

  describe('비공개 방 입장', () => {
    it('비밀번호가 맞으면 신규 입장할 수 있다', () => {
      const room = privateRoom();
      const guest = connectAs('GUEST');
      gateway.handleJoinRoom({ name: 'secret', nickname: 'g', password: '1234' }, guest);
      expect(errors(guest)).toEqual([]);
      expect(receivedEvent(guest, 'roomJoined')).toHaveLength(1);
      expect(room.clients.has(guest)).toBe(true);
    });

    it('비밀번호 없이는 신규 입장할 수 없다', () => {
      const room = privateRoom();
      const guest = connectAs('GUEST');
      gateway.handleJoinRoom({ name: 'secret', nickname: 'g' }, guest);
      expect(errors(guest)).toEqual(['비밀번호가 일치하지 않습니다']);
      expect(room.clients.has(guest)).toBe(false);
    });

    it('끊겼던 멤버는 비밀번호 없이 재연결된다', () => {
      const room = privateRoom();
      ctx.clientAuth.set(host, 'HOST');
      gateway.handleDisconnect(host);
      const next = connectAs('HOST');

      gateway.handleJoinRoom({ name: 'secret', nickname: 'h' }, next);

      expect(errors(next)).toEqual([]);
      expect(receivedEvent(next, 'roomJoined')).toHaveLength(1);
      expect(room.clients.has(next)).toBe(true);
      expect(room.disconnectTimers.size).toBe(0);
    });

    it('소켓만 바뀐 멤버도 비밀번호 없이 재입장된다', () => {
      const room = privateRoom();
      const next = connectAs('HOST');
      gateway.handleJoinRoom({ name: 'secret', nickname: 'h' }, next);
      expect(errors(next)).toEqual([]);
      expect(room.playerIds.get(next)).toBe('HOST');
    });
  });

  describe('연결 인증', () => {
    const req = { url: '/ws?token=t' } as IncomingMessage;

    function mockGetUser(id: string | null) {
      (getSupabaseAdmin as jest.Mock).mockReturnValue({
        auth: {
          getUser: jest.fn(async () => ({
            data: { user: id ? { id } : null },
            error: null,
          })),
        },
      });
    }

    it('인증이 끝나면 authenticated를 보낸다', async () => {
      mockGetUser('U1');
      const sock = fakeSocket();
      await gateway.handleConnection(sock, { url: '/ws?token=ok-1' } as IncomingMessage);
      expect(receivedEvent(sock, 'authenticated')).toHaveLength(1);
      expect(ctx.clientAuth.get(sock)).toBe('U1');
    });

    it('검증 중에 끊긴 소켓은 등록하지 않는다', async () => {
      mockGetUser('U2');
      const sock = { readyState: WebSocket.CLOSED, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;
      await gateway.handleConnection(sock, { url: '/ws?token=ok-2' } as IncomingMessage);
      expect(ctx.clients.has(sock)).toBe(false);
      expect(ctx.clientAuth.has(sock)).toBe(false);
    });

    it('유효하지 않은 토큰은 연결을 닫는다', async () => {
      mockGetUser(null);
      const sock = { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() } as unknown as WebSocket;
      await gateway.handleConnection(sock, req);
      expect(errors(sock)).toEqual(['인증에 실패했습니다']);
      expect(sock.close).toHaveBeenCalled();
      expect(receivedEvent(sock, 'authenticated')).toHaveLength(0);
    });
  });
});
