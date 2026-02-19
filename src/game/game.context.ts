import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { Room, PlayerHand } from './game.types';

/**
 * 모든 게임이 공유하는 상태(rooms, clients)와 유틸 메서드를 제공합니다.
 * 게임별 핸들러에서 주입받아 사용합니다.
 */
@Injectable()
export class GameContext {
  static readonly DISCONNECT_GRACE_MS = 5000;
  static readonly CARD_IMAGE_BASE_URL =
    process.env.CARD_IMAGE_BASE_URL ||
    'https://storage.googleapis.com/teak-banner-431004-n3.appspot.com/images/cards';

  readonly clients: Set<WebSocket> = new Set();
  readonly rooms: Map<string, Room> = new Map();
  readonly clientRooms: Map<WebSocket, Set<string>> = new Map();

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

  leaveRoom(client: WebSocket, roomName: string): void {
    const room = this.rooms.get(roomName);
    if (!room) return;

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
      this.broadcastToRoom(roomName, 'userLeft', {
        roomName,
        memberCount: room.clients.size,
        playerId,
        nickname,
        players: this.getPlayersWithOrder(room),
      });
    }
  }

  // ── 소켓 교체 (재연결) ────────────────────────────────────

  replaceClient(room: Room, oldClient: WebSocket, newClient: WebSocket): void {
    const playerId = room.playerIds.get(oldClient);
    const nickname = room.nicknames.get(oldClient);
    const hand = room.state.hands.get(oldClient) ?? [];

    room.clients.delete(oldClient);
    room.clients.add(newClient);

    room.playerIds.delete(oldClient);
    if (playerId) room.playerIds.set(newClient, playerId);

    room.nicknames.delete(oldClient);
    if (nickname) room.nicknames.set(newClient, nickname);

    room.state.hands.delete(oldClient);
    room.state.hands.set(newClient, hand);

    const idx = room.state.playerOrder.indexOf(oldClient);
    if (idx !== -1) room.state.playerOrder[idx] = newClient;
  }
}
