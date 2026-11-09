import { WebSocket } from 'ws';
import { Card, Room } from '../src/game/game.types';
import { GameContext } from '../src/game/game.context';

/** 테스트용 가짜 소켓 — OPEN 상태로 send만 기록한다 */
export function fakeSocket(): WebSocket {
  return { readyState: WebSocket.OPEN, send: jest.fn() } as unknown as WebSocket;
}

/** 소켓이 받은 이벤트 목록 */
export function received(sock: WebSocket): { event: string; data: any }[] {
  return (sock.send as jest.Mock).mock.calls.map(([raw]) => JSON.parse(raw as string));
}

export function receivedEvent(sock: WebSocket, event: string) {
  return received(sock).filter((m) => m.event === event);
}

export function errors(sock: WebSocket): string[] {
  return receivedEvent(sock, 'error').map((m) => m.data.message as string);
}

/** DatabaseService 대체 — isAdmin만 의미 있게, 나머지는 아무것도 안 하는 비동기 함수 */
export function fakeDb(adminIds: string[] = []): any {
  return new Proxy(
    { isAdmin: jest.fn(async (id: string) => adminIds.includes(id)) },
    {
      get: (target: any, prop: string) =>
        prop in target ? target[prop] : jest.fn(async () => null),
    },
  );
}

export function card(type: string, value: number): Card {
  return { type, value, image: '', name: `${type}-${value}` } as Card;
}

/** players: [소켓, playerId] — 첫 번째가 방장 */
export function addRoom(
  ctx: GameContext,
  name: string,
  gameType: string,
  players: [WebSocket, string][],
): Room {
  const room: Room = {
    name,
    gameType,
    clients: new Set(players.map(([s]) => s)),
    playerIds: new Map(players),
    nicknames: new Map(players.map(([s, id]) => [s, `nick-${id}`])),
    disconnectTimers: new Map(),
    state: {
      deck: [],
      hands: new Map(players.map(([s]) => [s, [] as Card[]])),
      currentTurn: 0,
      playerOrder: players.map(([s]) => s),
      openCards: [],
      chips: [],
      currentStep: 1,
      playerReady: new Set(),
      nextRoundReady: new Set(),
      previousChips: new Map(),
      winLossRecord: new Map(),
    },
    createdAt: new Date(),
    gameStarted: false,
    gameFinished: false,
    hostPlayerId: players[0][1],
    hostNickname: `nick-${players[0][1]}`,
  } as Room;
  ctx.rooms.set(name, room);
  return room;
}
