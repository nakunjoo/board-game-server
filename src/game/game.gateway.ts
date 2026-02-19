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
import { GameContext } from './game.context';
import { GangHandler } from './games/gang/gang.handler';
import { SpiceHandler } from './games/spice/spice.handler';

@WebSocketGateway({ path: '/ws' })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly engineFactory: GameEngineFactory,
    private readonly ctx: GameContext,
    private readonly gangHandler: GangHandler,
    private readonly spiceHandler: SpiceHandler,
  ) {}

  // ── 연결 관리 ─────────────────────────────────────────────

  handleConnection(client: WebSocket) {
    this.ctx.clients.add(client);
    this.ctx.clientRooms.set(client, new Set());
    console.log(`Client connected. Total clients: ${this.ctx.clients.size}`);
  }

  handleDisconnect(client: WebSocket) {
    const rooms = this.ctx.clientRooms.get(client);
    if (rooms) {
      rooms.forEach((roomName) => {
        const room = this.ctx.rooms.get(roomName);
        if (!room) return;

        const playerId = room.playerIds.get(client);
        if (!playerId) return;

        const timer = setTimeout(() => {
          room.disconnectTimers.delete(playerId);
          this.ctx.leaveRoom(client, roomName);
          console.log(
            `'${playerId}' grace period expired, removed from '${roomName}'`,
          );
        }, GameContext.DISCONNECT_GRACE_MS);

        room.disconnectTimers.set(playerId, timer);
        console.log(
          `'${playerId}' disconnected from '${roomName}', waiting ${GameContext.DISCONNECT_GRACE_MS}ms for reconnect`,
        );
      });
    }
    this.ctx.clientRooms.delete(client);
    this.ctx.clients.delete(client);
    console.log(`Client disconnected. Total clients: ${this.ctx.clients.size}`);
  }

  // ── 공통: 방 관리 ─────────────────────────────────────────

  @SubscribeMessage('createRoom')
  handleCreateRoom(
    @MessageBody()
    data: {
      name: string;
      playerId: string;
      nickname: string;
      gameType?: string;
      password?: string;
    },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { name, playerId, nickname, gameType = 'gang', password } = data;

    if (this.ctx.rooms.has(name)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${name}' 방이 이미 존재합니다`,
      });
      return;
    }

    const engine = this.engineFactory.get(gameType);

    const room = {
      name,
      gameType,
      clients: new Set([client]),
      playerIds: new Map([[client, playerId]]),
      nicknames: new Map([[client, nickname]]),
      disconnectTimers: new Map(),
      state: {
        deck: engine.createDeck(),
        hands: new Map([[client, []]]),
        currentTurn: 0,
        playerOrder: [client],
        openCards: [],
        chips: [],
        currentStep: 1,
        playerReady: new Set<string>(),
        nextRoundReady: new Set<string>(),
        previousChips: new Map<string, number[]>(),
        winLossRecord: new Map<string, boolean[]>(),
      },
      createdAt: new Date(),
      gameStarted: false,
      gameFinished: false,
      hostPlayerId: playerId,
      hostNickname: nickname,
      password: password || undefined,
      successCount: 0,
    };

    this.ctx.rooms.set(name, room);
    this.ctx.clientRooms.get(client)?.add(name);

    console.log(
      `Room '${name}' (${gameType}) created by '${nickname}' (${playerId}). Total rooms: ${this.ctx.rooms.size}`,
    );

    this.ctx.sendToClient(client, 'roomCreated', {
      name,
      gameType,
      memberCount: 1,
      players: [{ playerId, nickname, order: 0 }],
      deck: room.state.deck,
      playerHands: this.ctx.getPlayerHands(room),
      myHand: [],
      gameStarted: false,
      gameFinished: false,
      lastGameResults: undefined,
      gameOver: false,
      gameOverResult: null,
      openCards: [],
      hostPlayerId: playerId,
      hostNickname: nickname,
      chips: [],
      currentStep: 1,
      readyPlayers: [],
      previousChips: {},
      winLossRecord: {},
    });
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    @MessageBody()
    data: {
      name: string;
      playerId: string;
      nickname: string;
      password?: string;
    },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { name, playerId, nickname, password } = data;
    const room = this.ctx.rooms.get(name);

    if (!room) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${name}' 방이 존재하지 않습니다`,
      });
      return;
    }

    if (room.password && room.password !== password) {
      this.ctx.sendToClient(client, 'error', {
        message: '비밀번호가 일치하지 않습니다',
      });
      return;
    }

    const disconnectTimer = room.disconnectTimers.get(playerId);

    if (room.gameStarted && !disconnectTimer) {
      this.ctx.sendToClient(client, 'error', {
        message: '이미 게임이 시작된 방입니다',
      });
      return;
    }

    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      room.disconnectTimers.delete(playerId);

      const oldClient = this.ctx.findClientByPlayerId(room, playerId);
      if (oldClient) this.ctx.replaceClient(room, oldClient, client);

      this.ctx.clientRooms.get(client)?.add(name);
      console.log(`'${nickname}' (${playerId}) reconnected to room '${name}'`);

      const players = this.ctx.getPlayersWithOrder(room);
      const order = players.find((p) => p.playerId === playerId)?.order ?? 0;

      this.ctx.sendToClient(client, 'roomJoined', {
        name,
        gameType: room.gameType,
        memberCount: room.clients.size,
        players,
        deck: room.state.deck,
        playerHands: this.ctx.getPlayerHands(room),
        myHand: room.state.hands.get(client) ?? [],
        gameStarted: room.gameStarted,
        openCards: room.state.openCards,
        hostPlayerId: room.hostPlayerId,
        hostNickname: room.hostNickname,
        chips: room.state.chips,
        currentStep: room.state.currentStep,
        readyPlayers: Array.from(room.state.playerReady),
        previousChips: Object.fromEntries(room.state.previousChips),
        winLossRecord: Object.fromEntries(room.state.winLossRecord),
      });

      this.ctx.broadcastToRoom(
        name,
        'userJoined',
        { roomName: name, memberCount: room.clients.size, playerId, nickname, order, players },
        client,
      );
      return;
    }

    // 이미 같은 playerId로 입장한 경우 (재입장) - 기존 클라이언트 교체
    const existingClient = this.ctx.findClientByPlayerId(room, playerId);
    if (existingClient && existingClient !== client) {
      this.ctx.replaceClient(room, existingClient, client);
      this.ctx.clientRooms.get(client)?.add(name);

      const players = this.ctx.getPlayersWithOrder(room);
      this.ctx.sendToClient(client, 'roomJoined', {
        name,
        gameType: room.gameType,
        memberCount: room.clients.size,
        players,
        deck: room.state.deck,
        playerHands: this.ctx.getPlayerHands(room),
        myHand: room.state.hands.get(client) ?? [],
        gameStarted: room.gameStarted,
        gameFinished: room.gameFinished,
        lastGameResults: room.lastGameResults,
        gameOver: room.gameOver,
        gameOverResult: room.gameOverResult,
        openCards: room.state.openCards,
        hostPlayerId: room.hostPlayerId,
        hostNickname: room.hostNickname,
        chips: room.state.chips,
        currentStep: room.state.currentStep,
        readyPlayers: Array.from(room.state.playerReady),
        previousChips: Object.fromEntries(room.state.previousChips),
        winLossRecord: Object.fromEntries(room.state.winLossRecord),
      });
      return;
    }

    // 신규 입장
    room.clients.add(client);
    room.playerIds.set(client, playerId);
    room.nicknames.set(client, nickname);
    room.state.hands.set(client, []);
    room.state.playerOrder.push(client);
    this.ctx.clientRooms.get(client)?.add(name);

    const players = this.ctx.getPlayersWithOrder(room);
    const order = players.find((p) => p.playerId === playerId)?.order ?? 0;

    console.log(
      `'${nickname}' (${playerId}) joined room '${name}' with order ${order}. Room size: ${room.clients.size}`,
    );

    this.ctx.sendToClient(client, 'roomJoined', {
      name,
      gameType: room.gameType,
      memberCount: room.clients.size,
      players,
      deck: room.state.deck,
      playerHands: this.ctx.getPlayerHands(room),
      myHand: room.state.hands.get(client) ?? [],
      gameStarted: room.gameStarted,
      gameFinished: room.gameFinished,
      lastGameResults: room.lastGameResults,
      gameOver: room.gameOver,
      gameOverResult: room.gameOverResult,
      openCards: room.state.openCards,
      hostPlayerId: room.hostPlayerId,
      hostNickname: room.hostNickname,
      chips: room.state.chips,
      currentStep: room.state.currentStep,
      readyPlayers: Array.from(room.state.playerReady),
      previousChips: Object.fromEntries(room.state.previousChips),
      winLossRecord: Object.fromEntries(room.state.winLossRecord),
    });

    this.ctx.broadcastToRoom(
      name,
      'userJoined',
      { roomName: name, memberCount: room.clients.size, playerId, nickname, order, players },
      client,
    );
  }

  @SubscribeMessage('verifyPassword')
  handleVerifyPassword(
    @MessageBody() data: { name: string; password: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { name, password } = data;
    const room = this.ctx.rooms.get(name);

    if (!room) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${name}' 방이 존재하지 않습니다`,
      });
      return;
    }

    const success = !room.password || room.password === password;
    this.ctx.sendToClient(client, 'passwordVerified', { name, success });
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(
    @MessageBody() data: { name: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    this.ctx.leaveRoom(client, data.name);
    this.ctx.sendToClient(client, 'roomLeft', {
      name: data.name,
      message: `'${data.name}' 방에서 퇴장했습니다`,
    });
  }

  @SubscribeMessage('kickPlayer')
  handleKickPlayer(
    @MessageBody() data: { roomName: string; targetPlayerId: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName, targetPlayerId } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    if (room.playerIds.get(client) !== room.hostPlayerId) {
      this.ctx.sendToClient(client, 'error', { message: '방장만 강퇴할 수 있습니다' });
      return;
    }

    if (room.gameStarted) {
      this.ctx.sendToClient(client, 'error', { message: '게임 시작 후에는 강퇴할 수 없습니다' });
      return;
    }

    if (targetPlayerId === room.hostPlayerId) {
      this.ctx.sendToClient(client, 'error', { message: '자기 자신은 강퇴할 수 없습니다' });
      return;
    }

    const targetClient = this.ctx.findClientByPlayerId(room, targetPlayerId);
    if (!targetClient) {
      this.ctx.sendToClient(client, 'error', { message: '해당 플레이어를 찾을 수 없습니다' });
      return;
    }

    const targetNickname = room.nicknames.get(targetClient) ?? targetPlayerId;
    this.ctx.sendToClient(targetClient, 'kicked', { roomName, message: '방장에 의해 강퇴되었습니다' });
    this.ctx.leaveRoom(targetClient, roomName);
    console.log(`'${targetNickname}' (${targetPlayerId}) kicked from room '${roomName}' by host`);
  }

  @SubscribeMessage('getRooms')
  handleGetRooms(@ConnectedSocket() client: WebSocket): void {
    const roomList = Array.from(this.ctx.rooms.values()).map((room) => ({
      name: room.name,
      gameType: room.gameType,
      memberCount: room.clients.size,
      createdAt: room.createdAt,
      gameStarted: room.gameStarted,
      isPrivate: !!room.password,
    }));
    this.ctx.sendToClient(client, 'roomList', { rooms: roomList });
  }

  @SubscribeMessage('getPlayerList')
  handleGetPlayerList(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방이 존재하지 않습니다` });
      return;
    }
    if (!room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }

    this.ctx.sendToClient(client, 'playerList', {
      roomName,
      players: this.ctx.getPlayersWithOrder(room),
    });
  }

  @SubscribeMessage('roomMessage')
  handleRoomMessage(
    @MessageBody() data: { roomName: string; message: unknown },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName, message } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }
    this.ctx.broadcastToRoom(roomName, 'roomMessage', { roomName, message });
  }

  @SubscribeMessage('message')
  handleMessage(
    @MessageBody() data: string,
    @ConnectedSocket() client: WebSocket,
  ): void {
    console.log('Received message:', data);
    client.send(JSON.stringify({ event: 'message', data: `Echo: ${data}` }));
  }

  // ── 게임 이벤트 (gameType에 따라 핸들러 위임) ────────────

  private getGameType(roomName: string): string {
    return this.ctx.rooms.get(roomName)?.gameType ?? 'gang';
  }

  @SubscribeMessage('startGame')
  handleStartGame(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    if (this.getGameType(data.roomName) === 'spice') {
      this.spiceHandler.handleStartGame(data, client);
    } else {
      this.gangHandler.handleStartGame(data, client);
    }
  }

  @SubscribeMessage('drawCard')
  handleDrawCard(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    this.gangHandler.handleDrawCard(data, client);
  }

  @SubscribeMessage('selectChip')
  handleSelectChip(
    @MessageBody() data: { roomName: string; chipNumber: number },
    @ConnectedSocket() client: WebSocket,
  ): void {
    if (this.getGameType(data.roomName) === 'spice') {
      this.spiceHandler.handleSelectChip(data, client);
    } else {
      this.gangHandler.handleSelectChip(data, client);
    }
  }

  @SubscribeMessage('playerReady')
  handlePlayerReady(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    if (this.getGameType(data.roomName) === 'spice') {
      this.spiceHandler.handlePlayerReady(data, client);
    } else {
      this.gangHandler.handlePlayerReady(data, client);
    }
  }

  @SubscribeMessage('readyNextRound')
  handleReadyNextRound(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    if (this.getGameType(data.roomName) === 'spice') {
      this.spiceHandler.handleReadyNextRound(data, client);
    } else {
      this.gangHandler.handleReadyNextRound(data, client);
    }
  }

  @SubscribeMessage('testSuccess')
  handleTestSuccess(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    this.gangHandler.handleTestSuccess(data, client);
  }

  @SubscribeMessage('testFail')
  handleTestFail(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    this.gangHandler.handleTestFail(data, client);
  }
}
