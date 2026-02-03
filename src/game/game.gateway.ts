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
    @MessageBody() data: { name: string; nickname: string; gameType?: string; password?: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { name, nickname, gameType = 'gang', password } = data;

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
        openCards: [],
        chips: [],
        currentStep: 1,
        playerReady: new Set(),
        previousChips: new Map(),
        winLossRecord: new Map(),
      },
      createdAt: new Date(),
      gameStarted: false,
      hostNickname: nickname,
      password: password || undefined,
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
      gameStarted: room.gameStarted,
      openCards: room.state.openCards,
      hostNickname: room.hostNickname,
      chips: room.state.chips,
      currentStep: room.state.currentStep,
      readyPlayers: Array.from(room.state.playerReady),
      previousChips: Object.fromEntries(room.state.previousChips),
      winLossRecord: Object.fromEntries(room.state.winLossRecord),
    });
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    @MessageBody() data: { name: string; nickname: string; password?: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { name, nickname, password } = data;
    const room = this.rooms.get(name);

    if (!room) {
      this.sendToClient(client, 'error', {
        message: `'${name}' 방이 존재하지 않습니다`,
      });
      return;
    }

    // 비밀방 체크
    if (room.password && room.password !== password) {
      this.sendToClient(client, 'error', {
        message: '비밀번호가 일치하지 않습니다',
      });
      return;
    }

    // 재연결 체크: 같은 닉네임으로 disconnect 타이머가 돌고 있으면 재연결
    const disconnectTimer = room.disconnectTimers.get(nickname);

    // 게임이 시작된 방은 신규 입장 불가 (재연결은 가능)
    if (room.gameStarted && !disconnectTimer) {
      this.sendToClient(client, 'error', {
        message: '이미 게임이 시작된 방입니다',
      });
      return;
    }
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

      const players = this.getPlayersWithOrder(room);
      const order = players.find((p) => p.nickname === nickname)?.order ?? 0;

      this.sendToClient(client, 'roomJoined', {
        name,
        gameType: room.gameType,
        memberCount: room.clients.size,
        players,
        deck: room.state.deck,
        playerHands: this.getPlayerHands(room),
        myHand: room.state.hands.get(client) ?? [],
        gameStarted: room.gameStarted,
        openCards: room.state.openCards,
        hostNickname: room.hostNickname,
        chips: room.state.chips,
        currentStep: room.state.currentStep,
        readyPlayers: Array.from(room.state.playerReady),
        previousChips: Object.fromEntries(room.state.previousChips),
        winLossRecord: Object.fromEntries(room.state.winLossRecord),
      });

      // 재연결 시에도 다른 플레이어들에게 알림
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
      gameStarted: room.gameStarted,
      openCards: room.state.openCards,
      hostNickname: room.hostNickname,
      chips: room.state.chips,
      currentStep: room.state.currentStep,
      readyPlayers: Array.from(room.state.playerReady),
      previousChips: Object.fromEntries(room.state.previousChips),
      winLossRecord: Object.fromEntries(room.state.winLossRecord),
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

  @SubscribeMessage('kickPlayer')
  handleKickPlayer(
    @MessageBody() data: { roomName: string; targetNickname: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName, targetNickname } = data;
    const room = this.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    // 방장 확인
    const hostNickname = room.hostNickname;
    const requestNickname = room.nicknames.get(client);

    if (requestNickname !== hostNickname) {
      this.sendToClient(client, 'error', {
        message: '방장만 강퇴할 수 있습니다',
      });
      return;
    }

    // 게임 시작 후에는 강퇴 불가
    if (room.gameStarted) {
      this.sendToClient(client, 'error', {
        message: '게임 시작 후에는 강퇴할 수 없습니다',
      });
      return;
    }

    // 자기 자신은 강퇴 불가
    if (targetNickname === hostNickname) {
      this.sendToClient(client, 'error', {
        message: '자기 자신은 강퇴할 수 없습니다',
      });
      return;
    }

    // 대상 플레이어 찾기
    const targetClient = this.findClientByNickname(room, targetNickname);

    if (!targetClient) {
      this.sendToClient(client, 'error', {
        message: '해당 플레이어를 찾을 수 없습니다',
      });
      return;
    }

    // 강퇴 대상에게 알림
    this.sendToClient(targetClient, 'kicked', {
      roomName,
      message: '방장에 의해 강퇴되었습니다',
    });

    // 강퇴 처리
    this.leaveRoom(targetClient, roomName);

    console.log(`'${targetNickname}' kicked from room '${roomName}' by '${hostNickname}'`);
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

  @SubscribeMessage('startGame')
  handleStartGame(
    @MessageBody() data: { roomName: string },
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

    if (room.clients.size < 3) {
      this.sendToClient(client, 'error', {
        message: '게임을 시작하려면 최소 3명이 필요합니다',
      });
      return;
    }

    const engine = this.engineFactory.get(room.gameType);
    room.state.deck = engine.createDeck();
    room.gameStarted = true;

    // 칩 생성 (플레이어 수만큼)
    room.state.chips = Array.from({ length: room.clients.size }, (_, i) => ({
      number: i + 1,
      state: 0, // 초기 상태는 흰색
      owner: null,
    }));

    // 공개 카드 3장만 깔기 (스텝 1)
    room.state.openCards = [];
    room.state.currentStep = 1;
    room.state.playerReady = new Set();
    room.state.previousChips = new Map();

    // 모든 플레이어의 손패 초기화
    room.state.hands.clear();
    room.state.playerOrder.forEach((playerClient) => {
      room.state.hands.set(playerClient, []);
    });

    for (let i = 0; i < 3; i++) {
      if (room.state.deck.length > 0) {
        const card = room.state.deck.pop()!;
        room.state.openCards.push(card);
      }
    }

    // 모든 플레이어에게 카드 2장씩 나눠주기
    for (let round = 0; round < 2; round++) {
      for (const playerClient of room.state.playerOrder) {
        if (room.state.deck.length > 0) {
          const card = room.state.deck.pop()!;
          const hand = room.state.hands.get(playerClient) ?? [];
          hand.push(card);
          room.state.hands.set(playerClient, hand);
        }
      }
    }

    console.log(`Game started in room '${roomName}' with ${room.clients.size} players`);

    // 각 클라이언트에게 자신의 손패와 함께 gameStarted 전송
    room.clients.forEach((playerClient) => {
      this.sendToClient(playerClient, 'gameStarted', {
        roomName,
        deck: room.state.deck,
        myHand: room.state.hands.get(playerClient) ?? [],
        playerHands: this.getPlayerHands(room),
        openCards: room.state.openCards,
        chips: room.state.chips,
      });
    });
  }

  @SubscribeMessage('selectChip')
  handleSelectChip(
    @MessageBody() data: { roomName: string; chipNumber: number },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName, chipNumber } = data;
    const room = this.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    const nickname = room.nicknames.get(client);
    if (!nickname) return;

    const chip = room.state.chips.find((c) => c.number === chipNumber);
    if (!chip) return;

    // 이전 소유자 확인 (빼앗기는 사람)
    const previousOwner = chip.owner;

    // 이미 칩을 가지고 있으면 기존 칩 반납
    const existingChip = room.state.chips.find((c) => c.owner === nickname);
    if (existingChip) {
      existingChip.owner = null;
    }

    // 새 칩 선택 (다른 사람이 가진 칩도 가져올 수 있음)
    chip.owner = nickname;

    // 칩 변경된 플레이어들의 준비 상태 해제
    const affectedPlayers = [nickname];
    if (previousOwner && previousOwner !== nickname) {
      affectedPlayers.push(previousOwner);
    }

    // 영향받은 플레이어들의 준비 완료 해제
    const unreadyPlayers: string[] = [];
    affectedPlayers.forEach((player) => {
      if (room.state.playerReady.has(player)) {
        room.state.playerReady.delete(player);
        unreadyPlayers.push(player);
      }
    });

    // 칩을 빼앗긴 경우 메시지 전송
    if (previousOwner && previousOwner !== nickname) {
      this.broadcastToRoom(roomName, 'roomMessage', {
        roomName,
        message: `${nickname}님이 ${previousOwner}님의 ${chipNumber}번 칩을 가져갔습니다.`,
        isSystem: true,
      });
    }

    // 모든 클라이언트에게 업데이트 브로드캐스트
    this.broadcastToRoom(roomName, 'chipSelected', {
      roomName,
      chips: room.state.chips,
      stolenFrom: previousOwner && previousOwner !== nickname ? previousOwner : undefined,
      stolenBy: previousOwner && previousOwner !== nickname ? nickname : undefined,
      chipNumber: previousOwner && previousOwner !== nickname ? chipNumber : undefined,
    });

    // 준비 상태가 해제된 플레이어가 있으면 알림
    if (unreadyPlayers.length > 0) {
      this.broadcastToRoom(roomName, 'playerReadyUpdate', {
        roomName,
        readyPlayers: Array.from(room.state.playerReady),
        allReady: false,
      });
    }
  }

  @SubscribeMessage('playerReady')
  handlePlayerReady(
    @MessageBody() data: { roomName: string },
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

    const nickname = room.nicknames.get(client);
    if (!nickname) return;

    // 플레이어가 칩을 선택했는지 확인
    const playerChip = room.state.chips.find((c) => c.owner === nickname);
    if (!playerChip) {
      this.sendToClient(client, 'error', {
        message: '칩을 먼저 선택해주세요',
      });
      return;
    }

    // 준비 완료 표시
    room.state.playerReady.add(nickname);

    // 모든 플레이어가 준비되었는지 확인
    const allReady = room.clients.size === room.state.playerReady.size;

    this.broadcastToRoom(roomName, 'playerReadyUpdate', {
      roomName,
      readyPlayers: Array.from(room.state.playerReady),
      allReady,
    });

    if (allReady) {
      // 다음 스텝으로 진행
      this.proceedToNextStep(roomName);
    }
  }

  private proceedToNextStep(roomName: string): void {
    const room = this.rooms.get(roomName);
    if (!room) return;

    // 현재 칩을 이전 칩으로 저장
    for (const chip of room.state.chips) {
      if (chip.owner) {
        const prev = room.state.previousChips.get(chip.owner) || [];
        prev.push(chip.number);
        room.state.previousChips.set(chip.owner, prev);
      }
    }

    // 다음 스텝으로
    room.state.currentStep++;

    // 스텝 4(마지막)을 넘으면 게임 종료
    if (room.state.currentStep > 4) {
      // 각 플레이어의 결과 데이터 생성 및 승패 판정
      const playerResults = room.state.playerOrder.map((client) => {
        const nickname = room.nicknames.get(client) ?? '';
        const hand = room.state.hands.get(client) ?? [];
        const playerPrevChips = room.state.previousChips.get(nickname) ?? [];

        return {
          nickname,
          hand,
          chips: playerPrevChips,
        };
      });

      // 승패 판정: 칩 번호가 오름차순인지 확인
      const isWinner = this.checkWinCondition(
        playerResults,
        room.state.openCards,
      );

      // 각 플레이어의 승패를 winLossRecord에 기록
      for (const result of playerResults) {
        const record = room.state.winLossRecord.get(result.nickname) || [];
        // 최대 5개만 유지
        if (record.length >= 5) {
          record.shift(); // 가장 오래된 기록 제거
        }
        record.push(isWinner);
        room.state.winLossRecord.set(result.nickname, record);
      }

      this.broadcastToRoom(roomName, 'gameFinished', {
        roomName,
        finalChips: room.state.chips,
        previousChips: Object.fromEntries(room.state.previousChips),
        openCards: room.state.openCards,
        playerResults,
        isWinner,
        winLossRecord: Object.fromEntries(room.state.winLossRecord),
      });
      return;
    }

    // 칩 상태 업데이트 (스텝에 따라 색상 변경)
    const chipState = room.state.currentStep - 1; // 1->0, 2->1, 3->2, 4->3
    for (const chip of room.state.chips) {
      chip.state = chipState;
      chip.owner = null; // 칩 초기화
    }

    // 오픈 카드 1장 추가
    if (room.state.deck.length > 0) {
      const card = room.state.deck.pop()!;
      room.state.openCards.push(card);
    }

    // 준비 상태 초기화
    room.state.playerReady.clear();

    // 다음 스텝 브로드캐스트
    this.broadcastToRoom(roomName, 'nextStep', {
      roomName,
      currentStep: room.state.currentStep,
      openCards: room.state.openCards,
      chips: room.state.chips,
      deck: room.state.deck,
      previousChips: Object.fromEntries(room.state.previousChips),
    });
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
      gameStarted: room.gameStarted,
      isPrivate: !!room.password,
    }));

    this.sendToClient(client, 'roomList', { rooms: roomList });
  }

  @SubscribeMessage('getPlayerList')
  handleGetPlayerList(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName } = data;
    const room = this.rooms.get(roomName);

    if (!room) {
      this.sendToClient(client, 'error', {
        message: `'${roomName}' 방이 존재하지 않습니다`,
      });
      return;
    }

    if (!room.clients.has(client)) {
      this.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    const players = this.getPlayersWithOrder(room);

    this.sendToClient(client, 'playerList', {
      roomName,
      players,
    });
  }

  @SubscribeMessage('readyNextRound')
  handleReadyNextRound(
    @MessageBody() data: { roomName: string },
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

    const nickname = room.nicknames.get(client);
    if (!nickname) return;

    // 다음 라운드 준비 플레이어 추가
    if (!room.state.playerReady.has(nickname)) {
      room.state.playerReady.add(nickname);
    }

    // 모든 플레이어가 준비되었는지 확인
    const allReady = room.clients.size === room.state.playerReady.size;

    this.broadcastToRoom(roomName, 'nextRoundReadyUpdate', {
      roomName,
      readyPlayers: Array.from(room.state.playerReady),
      allReady,
    });

    // 모두 준비되면 게임 시작
    if (allReady) {
      // 준비 상태 초기화
      room.state.playerReady.clear();

      // 게임 시작
      this.handleStartGame(
        { roomName },
        client,
      );
    }
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

  private checkWinCondition(
    playerResults: Array<{ nickname: string; hand: any[]; chips: number[] }>,
    openCards: any[],
  ): boolean {
    // 모든 플레이어의 칩 번호와 족보를 계산
    const playerRanks = playerResults.map((result) => {
      const allCards = [...result.hand, ...openCards];
      const rank = this.evaluateHandRank(allCards);
      return {
        nickname: result.nickname,
        chips: result.chips,
        rank,
      };
    });

    // 칩 번호 순서대로 정렬 (4개 스텝이므로 4개 칩)
    const sortedByChip = [...playerRanks].sort((a, b) => {
      const aLastChip = a.chips[a.chips.length - 1] || 0;
      const bLastChip = b.chips[b.chips.length - 1] || 0;
      return aLastChip - bLastChip;
    });

    // 칩 번호 순서대로 족보가 오름차순인지 확인
    for (let i = 0; i < sortedByChip.length - 1; i++) {
      if (sortedByChip[i].rank >= sortedByChip[i + 1].rank) {
        return false; // 족보가 오름차순이 아님 -> 실패
      }
    }

    return true; // 모든 조건 만족 -> 성공
  }

  private evaluateHandRank(cards: any[]): number {
    // 간단한 족보 평가 (실제로는 더 복잡한 로직 필요)
    // 7장 중 최고 5장으로 족보 계산
    // 숫자가 높을수록 좋은 족보

    const values = cards.map((c) => c.value).sort((a, b) => b - a);
    const suits = cards.map((c) => c.type);

    // 플러시 체크
    const suitCounts: Record<string, number> = {};
    suits.forEach((suit) => {
      suitCounts[suit] = (suitCounts[suit] || 0) + 1;
    });
    const hasFlush = Object.values(suitCounts).some((count) => count >= 5);

    // 페어, 트리플 등 체크
    const valueCounts: Record<number, number> = {};
    values.forEach((value) => {
      valueCounts[value] = (valueCounts[value] || 0) + 1;
    });
    const counts = Object.values(valueCounts).sort((a, b) => b - a);

    // 족보 점수 (높을수록 강함)
    if (counts[0] === 4) return 7000; // 포카드
    if (counts[0] === 3 && counts[1] === 2) return 6000; // 풀하우스
    if (hasFlush) return 5000; // 플러시
    if (counts[0] === 3) return 3000; // 트리플
    if (counts[0] === 2 && counts[1] === 2) return 2000; // 투페어
    if (counts[0] === 2) return 1000; // 원페어

    // 하이카드
    return values[0];
  }
}
