import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { Card, Room, PlayerHand } from './game.types';

/**
 * 모든 게임이 공유하는 상태(rooms, clients)와 유틸 메서드를 제공합니다.
 * 게임별 핸들러에서 주입받아 사용합니다.
 */
@Injectable()
export class GameContext {
  static readonly DISCONNECT_GRACE_MS = 30000;
  private static readonly HIDDEN_CARD = { type: 'hidden', value: 0, image: '', name: '' } as unknown as Card;
  static readonly CARD_IMAGE_BASE_URL =
    process.env.CARD_IMAGE_BASE_URL ||
    'https://storage.googleapis.com/teak-banner-431004-n3.appspot.com/images/cards';

  readonly clients: Set<WebSocket> = new Set();
  readonly rooms: Map<string, Room> = new Map();
  readonly clientRooms: Map<WebSocket, Set<string>> = new Map();
  readonly clientAuth: Map<WebSocket, string> = new Map(); // socket → userId

  // ── 전송 ─────────────────────────────────────────────────

  sendToClient(client: WebSocket, event: string, data: unknown): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  }

  broadcastToRoom(
    roomName: string,
    event: string,
    data: unknown,
    exclude?: WebSocket,
  ): void {
    const room = this.rooms.get(roomName);
    if (!room) return;
    const message = JSON.stringify({ event, data });
    room.clients.forEach((c: WebSocket) => {
      if (c !== exclude && c.readyState === WebSocket.OPEN) {
        c.send(message);
      }
    });
  }

  broadcast(event: string, data: unknown): void {
    const message = JSON.stringify({ event, data });
    this.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) c.send(message);
    });
  }

  // ── 조회 ─────────────────────────────────────────────────

  findClientByPlayerId(room: Room, playerId: string): WebSocket | undefined {
    for (const [client, id] of room.playerIds) {
      if (id === playerId) return client;
    }
    return undefined;
  }

  getNicknameByPlayerId(room: Room, playerId: string): string {
    for (const [client, id] of room.playerIds) {
      if (id === playerId) return room.nicknames.get(client) ?? playerId;
    }
    return playerId;
  }

  getPlayersWithOrder(
    room: Room,
  ): { playerId: string; nickname: string; order: number }[] {
    const result: { playerId: string; nickname: string; order: number }[] = [];
    let index = 0;
    for (const [client] of room.playerIds) {
      result.push({
        playerId: room.playerIds.get(client) ?? '',
        nickname: room.nicknames.get(client) ?? '',
        order: index++,
      });
    }
    return result;
  }

  getPlayerHands(room: Room): PlayerHand[] {
    return Array.from(room.nicknames.entries()).map(([client, nickname]) => ({
      nickname,
      cardCount: room.state.hands.get(client)?.length ?? 0,
    }));
  }

  // ── 방 나가기 ─────────────────────────────────────────────

  /** 방에서 플레이어를 뺀다. 게임 진행 상태는 호출한 쪽이 반환값으로 다시 맞춘다 */
  leaveRoom(
    client: WebSocket,
    roomName: string,
  ): { room: Room; playerId: string; orderIndex: number } | null {
    const room = this.rooms.get(roomName);
    if (!room) return null;

    const playerId = room.playerIds.get(client);
    const nickname = room.nicknames.get(client);

    if (playerId) {
      const timer = room.disconnectTimers.get(playerId);
      if (timer) {
        clearTimeout(timer);
        room.disconnectTimers.delete(playerId);
      }
    }

    const orderIndex = room.state.playerOrder.indexOf(client);
    if (orderIndex !== -1) {
      room.state.playerOrder.splice(orderIndex, 1);
      if (
        room.state.playerOrder.length > 0 &&
        room.state.currentTurn >= room.state.playerOrder.length
      ) {
        room.state.currentTurn = 0;
      }
    }

    room.state.hands.delete(client);
    room.clients.delete(client);
    room.playerIds.delete(client);
    room.nicknames.delete(client);
    this.clientRooms.get(client)?.delete(roomName);

    if (room.clients.size === 0) {
      this.rooms.delete(roomName);
      console.log(`Room '${roomName}' deleted (empty)`);
    } else {
      if (playerId === room.hostPlayerId) this.delegateHost(room);
      this.broadcastToRoom(roomName, 'userLeft', {
        roomName,
        memberCount: room.clients.size,
        playerId,
        nickname,
        players: this.getPlayersWithOrder(room),
        hostPlayerId: room.hostPlayerId,
        hostNickname: room.hostNickname,
      });
    }

    return playerId ? { room, playerId, orderIndex } : null;
  }

  /** 끊겨서 유예 중인 사람보다 접속 중인 사람에게 먼저 방장을 넘긴다 */
  private delegateHost(room: Room): void {
    const clients = Array.from(room.playerIds.keys());
    const next = clients.find((c) => c.readyState === WebSocket.OPEN) ?? clients[0];
    room.hostPlayerId = room.playerIds.get(next) ?? '';
    room.hostNickname = room.nicknames.get(next) ?? '';
  }

  /** 클라이언트는 덱 장수만 쓴다. 순서가 내려가면 다음 카드를 미리 볼 수 있어 내용을 가린다 */
  hiddenDeck(room: Room): Card[] {
    return room.state.deck.map(() => GameContext.HIDDEN_CARD);
  }

  // ── 소켓 교체 (재연결) ────────────────────────────────────

  replaceClient(room: Room, oldClient: WebSocket, newClient: WebSocket): void {
    // 좌석과 트릭 순서가 Map 순서를 따르므로, 지우고 다시 넣지 않고 제자리에서 바꾼다
    const swapKey = <V>(map: Map<WebSocket, V>) => {
      const entries = Array.from(map, ([c, v]): [WebSocket, V] => [
        c === oldClient ? newClient : c,
        v,
      ]);
      map.clear();
      entries.forEach(([c, v]) => map.set(c, v));
    };
    const clients = Array.from(room.clients, (c) => (c === oldClient ? newClient : c));
    room.clients.clear();
    clients.forEach((c) => room.clients.add(c));

    swapKey(room.playerIds);
    swapKey(room.nicknames);
    swapKey(room.state.hands);

    const idx = room.state.playerOrder.indexOf(oldClient);
    if (idx !== -1) room.state.playerOrder[idx] = newClient;
  }
}
