import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { GameEngineFactory } from './game-engine.factory';
import { Room, PlayerHand } from './game.types';

@WebSocketGateway({
  path: '/ws',
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private static readonly DISCONNECT_GRACE_MS = 5000;

  private clients: Set<WebSocket> = new Set();
  private rooms: Map<string, Room> = new Map();
  private clientRooms: Map<WebSocket, Set<string>> = new Map();

  constructor(private readonly engineFactory: GameEngineFactory) {}

  handleConnection(client: WebSocket) {
    this.clients.add(client);
    this.clientRooms.set(client, new Set());
    console.log(`Client connected. Total clients: ${this.clients.size}`);
  }

  handleDisconnect(client: WebSocket) {
    const rooms = this.clientRooms.get(client);
    if (rooms) {
      rooms.forEach((roomName) => {
        const room = this.rooms.get(roomName);
        if (!room) return;

        const nickname = room.nicknames.get(client);
        if (!nickname) return;

        // 즉시 퇴장하지 않고 grace period 타이머 설정
        const timer = setTimeout(() => {
          room.disconnectTimers.delete(nickname);
          this.leaveRoom(client, roomName);
          console.log(
            `'${nickname}' grace period expired, removed from '${roomName}'`,
          );
        }, GameGateway.DISCONNECT_GRACE_MS);

        room.disconnectTimers.set(nickname, timer);
        console.log(
          `'${nickname}' disconnected from '${roomName}', waiting ${GameGateway.DISCONNECT_GRACE_MS}ms for reconnect`,
        );
      });
    }
    this.clientRooms.delete(client);
    this.clients.delete(client);
    console.log(`Client disconnected. Total clients: ${this.clients.size}`);
  }

  @SubscribeMessage('createRoom')
  handleCreateRoom(
    @MessageBody() data: { name: string; nickname: string; gameType?: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { name, nickname, gameType = 'gang' } = data;

    if (this.rooms.has(name)) {
      this.sendToClient(client, 'error', {
        message: `'${name}' 방이 이미 존재합니다`,
      });
      return;
    }

    const engine = this.engineFactory.get(gameType);

    const room: Room = {
      name,
      gameType,
      clients: new Set([client]),
      nicknames: new Map([[client, nickname]]),
      disconnectTimers: new Map(),
      state: {
        deck: engine.createDeck(),
        hands: new Map([[client, []]]),
        currentTurn: 0,
        playerOrder: [client],
      },
      createdAt: new Date(),
    };
    this.rooms.set(name, room);
    this.clientRooms.get(client)?.add(name);

    console.log(
      `Room '${name}' (${gameType}) created by '${nickname}'. Total rooms: ${this.rooms.size}`,
    );

    this.sendToClient(client, 'roomCreated', {
      name,
      gameType,
      memberCount: 1,
      players: [{ nickname, order: 0 }],
      deck: room.state.deck,
      playerHands: this.getPlayerHands(room),
      myHand: room.state.hands.get(client) ?? [],
    });
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    @MessageBody() data: { name: string; nickname: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { name, nickname } = data;
    const room = this.rooms.get(name);

    if (!room) {
      this.sendToClient(client, 'error', {
        message: `'${name}' 방이 존재하지 않습니다`,
      });
      return;
    }

    // 재연결 체크: 같은 닉네임으로 disconnect 타이머가 돌고 있으면 재연결
    const disconnectTimer = room.disconnectTimers.get(nickname);
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      room.disconnectTimers.delete(nickname);

      // 이전 소켓 찾아서 교체
      const oldClient = this.findClientByNickname(room, nickname);
      if (oldClient) {
        this.replaceClient(room, oldClient, client);
      }

      this.clientRooms.get(client)?.add(name);

      console.log(`'${nickname}' reconnected to room '${name}'`);

      this.sendToClient(client, 'roomJoined', {
        name,
        gameType: room.gameType,
        memberCount: room.clients.size,
        players: this.getPlayersWithOrder(room),
        deck: room.state.deck,
        playerHands: this.getPlayerHands(room),
        myHand: room.state.hands.get(client) ?? [],
      });
      return;
    }

    // 신규 입장
    room.clients.add(client);
    room.nicknames.set(client, nickname);
    room.state.hands.set(client, []);
    room.state.playerOrder.push(client);
    this.clientRooms.get(client)?.add(name);

    const players = this.getPlayersWithOrder(room);
    const order = players.find((p) => p.nickname === nickname)?.order ?? 0;

    console.log(
      `'${nickname}' joined room '${name}' with order ${order}. Room size: ${room.clients.size}`,
    );

    this.sendToClient(client, 'roomJoined', {
      name,
      gameType: room.gameType,
      memberCount: room.clients.size,
      players,
      deck: room.state.deck,
      playerHands: this.getPlayerHands(room),
      myHand: room.state.hands.get(client) ?? [],
    });

    this.broadcastToRoom(
      name,
      'userJoined',
      {
        roomName: name,
        memberCount: room.clients.size,
        nickname,
        order,
        players,
      },
      client,
    );
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(
    @MessageBody() data: { name: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    this.leaveRoom(client, data.name);
    this.sendToClient(client, 'roomLeft', {
      name: data.name,
      message: `'${data.name}' 방에서 퇴장했습니다`,
    });
  }

  @SubscribeMessage('drawCard')
  handleDrawCard(
    @MessageBody() data: { roomName: string; nickname: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName } = data;
    const room = this.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    const engine = this.engineFactory.get(room.gameType);

    try {
      const prevTurn = room.state.currentTurn;
      const targetClient = room.state.playerOrder[prevTurn];
      const targetNickname = room.nicknames.get(targetClient) ?? '';

      const result = engine.drawCard(room.state);

      this.broadcastToRoom(roomName, 'cardDrawn', {
        roomName,
        card: result.card,
        deck: room.state.deck,
        playerNickname: targetNickname,
        playerHands: this.getPlayerHands(room),
      });
    } catch (e) {
      this.sendToClient(client, 'error', {
        message: (e as Error).message,
      });
    }
  }

  @SubscribeMessage('roomMessage')
  handleRoomMessage(
    @MessageBody() data: { roomName: string; message: unknown },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName, message } = data;
    const room = this.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    this.broadcastToRoom(roomName, 'roomMessage', {
      roomName,
      message,
    });
  }

  @SubscribeMessage('getRooms')
  handleGetRooms(@ConnectedSocket() client: WebSocket): void {
    const roomList = Array.from(this.rooms.values()).map((room) => ({
      name: room.name,
      gameType: room.gameType,
      memberCount: room.clients.size,
      createdAt: room.createdAt,
    }));

    this.sendToClient(client, 'roomList', { rooms: roomList });
  }

  @SubscribeMessage('message')
  handleMessage(
    @MessageBody() data: string,
    @ConnectedSocket() client: WebSocket,
  ): void {
    console.log('Received message:', data);
    client.send(JSON.stringify({ event: 'message', data: `Echo: ${data}` }));
  }

  private leaveRoom(client: WebSocket, roomName: string): void {
    const room = this.rooms.get(roomName);
    if (!room) return;

    const nickname = room.nicknames.get(client);

    // disconnect 타이머가 있으면 정리
    if (nickname) {
      const timer = room.disconnectTimers.get(nickname);
      if (timer) {
        clearTimeout(timer);
        room.disconnectTimers.delete(nickname);
      }
    }

    // playerOrder에서 제거
    const orderIndex = room.state.playerOrder.indexOf(client);
    if (orderIndex !== -1) {
      room.state.playerOrder.splice(orderIndex, 1);
      // currentTurn 보정
      if (room.state.playerOrder.length > 0) {
        if (room.state.currentTurn >= room.state.playerOrder.length) {
          room.state.currentTurn = 0;
        }
      }
    }

    room.state.hands.delete(client);
    room.clients.delete(client);
    room.nicknames.delete(client);
    this.clientRooms.get(client)?.delete(roomName);

    if (room.clients.size === 0) {
      this.rooms.delete(roomName);
      console.log(`Room '${roomName}' deleted (empty)`);
    } else {
      const players = this.getPlayersWithOrder(room);
      this.broadcastToRoom(roomName, 'userLeft', {
        roomName,
        memberCount: room.clients.size,
        nickname,
        players,
      });
    }
  }

  // 닉네임으로 기존 소켓 찾기
  private findClientByNickname(
    room: Room,
    nickname: string,
  ): WebSocket | undefined {
    for (const [client, name] of room.nicknames) {
      if (name === nickname) return client;
    }
    return undefined;
  }

  // 이전 소켓을 새 소켓으로 교체 (손패, 순서 등 유지)
  private replaceClient(
    room: Room,
    oldClient: WebSocket,
    newClient: WebSocket,
  ): void {
    const nickname = room.nicknames.get(oldClient);
    const hand = room.state.hands.get(oldClient) ?? [];

    // clients 교체
    room.clients.delete(oldClient);
    room.clients.add(newClient);

    // nicknames 교체
    room.nicknames.delete(oldClient);
    if (nickname) room.nicknames.set(newClient, nickname);

    // hands 교체
    room.state.hands.delete(oldClient);
    room.state.hands.set(newClient, hand);

    // playerOrder 교체
    const orderIndex = room.state.playerOrder.indexOf(oldClient);
    if (orderIndex !== -1) {
      room.state.playerOrder[orderIndex] = newClient;
    }
  }

  private getPlayersWithOrder(
    room: Room,
  ): { nickname: string; order: number }[] {
    return Array.from(room.nicknames.values()).map((nickname, index) => ({
      nickname,
      order: index,
    }));
  }

  private getPlayerHands(room: Room): PlayerHand[] {
    return Array.from(room.nicknames.entries()).map(([client, nickname]) => ({
      nickname,
      cardCount: room.state.hands.get(client)?.length ?? 0,
    }));
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
    room.clients.forEach((client: WebSocket) => {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcast(event: string, data: unknown): void {
    const message = JSON.stringify({ event, data });
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  sendToClient(client: WebSocket, event: string, data: unknown): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  }
}
