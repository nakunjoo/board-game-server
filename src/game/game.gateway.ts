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
  private static readonly CARD_IMAGE_BASE_URL =
    process.env.CARD_IMAGE_BASE_URL ||
    'https://storage.googleapis.com/teak-banner-431004-n3.appspot.com/images/cards';

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

        const playerId = room.playerIds.get(client);
        if (!playerId) return;

        // 즉시 퇴장하지 않고 grace period 타이머 설정
        const timer = setTimeout(() => {
          room.disconnectTimers.delete(playerId);
          this.leaveRoom(client, roomName);
          console.log(
            `'${playerId}' grace period expired, removed from '${roomName}'`,
          );
        }, GameGateway.DISCONNECT_GRACE_MS);

        room.disconnectTimers.set(playerId, timer);
        console.log(
          `'${playerId}' disconnected from '${roomName}', waiting ${GameGateway.DISCONNECT_GRACE_MS}ms for reconnect`,
        );
      });
    }
    this.clientRooms.delete(client);
    this.clients.delete(client);
    console.log(`Client disconnected. Total clients: ${this.clients.size}`);
  }

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
        playerReady: new Set(),
        nextRoundReady: new Set(),
        previousChips: new Map(),
        winLossRecord: new Map(),
      },
      createdAt: new Date(),
      gameStarted: false,
      gameFinished: false,
      hostPlayerId: playerId,
      hostNickname: nickname,
      password: password || undefined,
      successCount: 0, // 성공 횟수 0, 첫 라운드는 2장
    };
    this.rooms.set(name, room);
    this.clientRooms.get(client)?.add(name);

    console.log(
      `Room '${name}' (${gameType}) created by '${nickname}' (${playerId}). Total rooms: ${this.rooms.size}`,
    );

    this.sendToClient(client, 'roomCreated', {
      name,
      gameType,
      memberCount: 1,
      players: [{ playerId, nickname, order: 0 }],
      deck: room.state.deck,
      playerHands: this.getPlayerHands(room),
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

    // 재연결 체크: 같은 playerId로 disconnect 타이머가 돌고 있으면 재연결
    const disconnectTimer = room.disconnectTimers.get(playerId);

    // 게임이 시작된 방은 신규 입장 불가 (재연결은 가능)
    if (room.gameStarted && !disconnectTimer) {
      this.sendToClient(client, 'error', {
        message: '이미 게임이 시작된 방입니다',
      });
      return;
    }
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      room.disconnectTimers.delete(playerId);

      // 이전 소켓 찾아서 교체
      const oldClient = this.findClientByPlayerId(room, playerId);
      if (oldClient) {
        this.replaceClient(room, oldClient, client);
      }

      this.clientRooms.get(client)?.add(name);

      console.log(`'${nickname}' (${playerId}) reconnected to room '${name}'`);

      const players = this.getPlayersWithOrder(room);
      const order = players.find((p) => p.playerId === playerId)?.order ?? 0;

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
        hostPlayerId: room.hostPlayerId,
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
          playerId,
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
    room.playerIds.set(client, playerId);
    room.nicknames.set(client, nickname);
    room.state.hands.set(client, []);
    room.state.playerOrder.push(client);
    this.clientRooms.get(client)?.add(name);

    const players = this.getPlayersWithOrder(room);
    const order = players.find((p) => p.playerId === playerId)?.order ?? 0;

    console.log(
      `'${nickname}' (${playerId}) joined room '${name}' with order ${order}. Room size: ${room.clients.size}`,
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

    this.broadcastToRoom(
      name,
      'userJoined',
      {
        roomName: name,
        memberCount: room.clients.size,
        playerId,
        nickname,
        order,
        players,
      },
      client,
    );
  }

  @SubscribeMessage('verifyPassword')
  handleVerifyPassword(
    @MessageBody() data: { name: string; password: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { name, password } = data;
    const room = this.rooms.get(name);

    if (!room) {
      this.sendToClient(client, 'error', {
        message: `'${name}' 방이 존재하지 않습니다`,
      });
      return;
    }

    if (room.password && room.password !== password) {
      this.sendToClient(client, 'passwordVerified', {
        name,
        success: false,
      });
      return;
    }

    this.sendToClient(client, 'passwordVerified', {
      name,
      success: true,
    });
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
    @MessageBody() data: { roomName: string; targetPlayerId: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName, targetPlayerId } = data;
    const room = this.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    // 방장 확인
    const requestPlayerId = room.playerIds.get(client);

    if (requestPlayerId !== room.hostPlayerId) {
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
    if (targetPlayerId === room.hostPlayerId) {
      this.sendToClient(client, 'error', {
        message: '자기 자신은 강퇴할 수 없습니다',
      });
      return;
    }

    // 대상 플레이어 찾기
    const targetClient = this.findClientByPlayerId(room, targetPlayerId);

    if (!targetClient) {
      this.sendToClient(client, 'error', {
        message: '해당 플레이어를 찾을 수 없습니다',
      });
      return;
    }

    const targetNickname = room.nicknames.get(targetClient) ?? targetPlayerId;

    // 강퇴 대상에게 알림
    this.sendToClient(targetClient, 'kicked', {
      roomName,
      message: '방장에 의해 강퇴되었습니다',
    });

    // 강퇴 처리
    this.leaveRoom(targetClient, roomName);

    console.log(
      `'${targetNickname}' (${targetPlayerId}) kicked from room '${roomName}' by host`,
    );
  }

  @SubscribeMessage('drawCard')
  handleDrawCard(
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
    room.gameFinished = false;
    room.lastGameResults = undefined;
    room.gameOver = false;
    room.gameOverResult = null;

    // 게임 상태 초기화
    room.state.openCards = [];
    room.state.currentStep = 1;
    room.state.playerReady = new Set();
    room.state.nextRoundReady = new Set();
    room.state.previousChips = new Map();
    room.state.winLossRecord = new Map();

    // 모든 플레이어의 손패 초기화
    room.state.hands.clear();
    for (const playerClient of room.state.playerOrder) {
      room.state.hands.set(playerClient, []);
    }

    // 칩 생성 (플레이어 수만큼)
    room.state.chips = Array.from({ length: room.clients.size }, (_, i) => ({
      number: i + 1,
      state: 0, // 초기 상태는 흰색
      owner: null,
    }));

    // 스텝 1: 오픈카드 없이 핸드 배분
    // 성공 횟수가 2회 이상이면 3장, 아니면 2장
    const cardsPerPlayer = (room.successCount ?? 0) >= 2 ? 3 : 2;
    console.log(
      `Dealing ${cardsPerPlayer} cards per player (successCount: ${room.successCount ?? 0})`,
    );

    for (let round = 0; round < cardsPerPlayer; round++) {
      for (const playerClient of room.state.playerOrder) {
        if (room.state.deck.length > 0) {
          const card = room.state.deck.pop()!;
          const hand = room.state.hands.get(playerClient) ?? [];
          hand.push(card);
          room.state.hands.set(playerClient, hand);
        }
      }
    }

    console.log(
      `Game started in room '${roomName}' with ${room.clients.size} players`,
    );

    // 각 클라이언트에게 자신의 손패와 함께 gameStarted 전송
    room.clients.forEach((playerClient) => {
      this.sendToClient(playerClient, 'gameStarted', {
        roomName,
        deck: room.state.deck,
        myHand: room.state.hands.get(playerClient) ?? [],
        playerHands: this.getPlayerHands(room),
        openCards: room.state.openCards,
        chips: room.state.chips,
        winLossRecord: Object.fromEntries(room.state.winLossRecord),
        gameOver: room.gameOver,
        gameOverResult: room.gameOverResult,
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

    const playerId = room.playerIds.get(client);
    if (!playerId) return;
    const nickname = room.nicknames.get(client) ?? playerId;

    const chip = room.state.chips.find((c) => c.number === chipNumber);
    if (!chip) return;

    // 이전 소유자 확인 (빼앗기는 사람)
    const previousOwnerId = chip.owner;

    // 이미 칩을 가지고 있으면 기존 칩 반납
    const existingChip = room.state.chips.find((c) => c.owner === playerId);
    if (existingChip) {
      existingChip.owner = null;
    }

    // 새 칩 선택 (다른 사람이 가진 칩도 가져올 수 있음)
    chip.owner = playerId;

    // 칩 변경된 플레이어들의 준비 상태 해제
    const affectedPlayerIds = [playerId];
    if (previousOwnerId && previousOwnerId !== playerId) {
      affectedPlayerIds.push(previousOwnerId);
    }

    // 영향받은 플레이어들의 준비 완료 해제
    const unreadyPlayers: string[] = [];
    affectedPlayerIds.forEach((pid) => {
      if (room.state.playerReady.has(pid)) {
        room.state.playerReady.delete(pid);
        unreadyPlayers.push(pid);
      }
    });

    // 칩을 빼앗긴 경우 메시지 전송
    if (previousOwnerId && previousOwnerId !== playerId) {
      room.state.playerReady.delete(previousOwnerId);

      // 빼앗긴 플레이어의 닉네임 찾기
      const previousOwnerNickname = this.getNicknameByPlayerId(
        room,
        previousOwnerId,
      );

      this.broadcastToRoom(roomName, 'roomMessage', {
        roomName,
        message: `${nickname}님이 ${previousOwnerNickname}님의 ${chipNumber}번 칩을 가져갔습니다.`,
        isSystem: true,
      });
    }

    // 모든 클라이언트에게 업데이트 브로드캐스트
    const isStolen = previousOwnerId && previousOwnerId !== playerId;
    this.broadcastToRoom(roomName, 'chipSelected', {
      roomName,
      chips: room.state.chips,
      readyPlayers: Array.from(room.state.playerReady),
      stolenFrom: isStolen ? previousOwnerId : undefined,
      stolenBy: isStolen ? playerId : undefined,
      stolenFromName: isStolen
        ? this.getNicknameByPlayerId(room, previousOwnerId)
        : undefined,
      stolenByName: isStolen ? nickname : undefined,
      chipNumber: isStolen ? chipNumber : undefined,
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

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    // 플레이어가 칩을 선택했는지 확인
    const playerChip = room.state.chips.find((c) => c.owner === playerId);
    if (!playerChip) {
      this.sendToClient(client, 'error', {
        message: '칩을 먼저 선택해주세요',
      });
      return;
    }

    // 준비 완료 표시
    room.state.playerReady.add(playerId);

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

    // 현재 칩을 이전 칩으로 저장 (playerId 기준)
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
        const playerId = room.playerIds.get(client) ?? '';
        const nickname = room.nicknames.get(client) ?? '';
        const hand = room.state.hands.get(client) ?? [];
        const playerPrevChips = room.state.previousChips.get(playerId) ?? [];

        return {
          playerId,
          nickname,
          hand,
          chips: playerPrevChips,
        };
      });

      // 전체 플레이어의 승패를 판정 (최종 칩 번호 순서대로 족보가 오름차순인지)
      const isWinner = this.checkWinCondition(
        playerResults,
        room.state.openCards,
      );

      console.log(`[승패 판정] 전체 결과 -> ${isWinner ? '성공' : '실패'}`);
      for (const result of playerResults) {
        const lastChip = result.chips[result.chips.length - 1] || 0;
        console.log(
          `  - ${result.nickname}(${result.playerId}): 최종 칩 ${lastChip}, 전체 칩 ${JSON.stringify(result.chips)}`,
        );
      }

      // 모든 플레이어에게 동일한 승패 기록 (playerId 기준)
      for (const result of playerResults) {
        const record = room.state.winLossRecord.get(result.playerId) || [];
        // 최대 5개만 유지
        if (record.length >= 5) {
          record.shift(); // 가장 오래된 기록 제거
        }
        record.push(isWinner);
        room.state.winLossRecord.set(result.playerId, record);
      }

      // 준비 상태 초기화 (다음 라운드 준비에서 재사용하므로 반드시 초기화)
      room.state.playerReady.clear();

      // 게임 오버 체크: 승리 3개 또는 패배 3개 시 전체 게임 종료
      const samplePlayerId = playerResults[0]?.playerId;
      const sampleRecord = samplePlayerId
        ? room.state.winLossRecord.get(samplePlayerId) || []
        : [];
      const totalWins = sampleRecord.filter((r) => r === true).length;
      const totalLosses = sampleRecord.filter((r) => r === false).length;
      const gameOver = totalWins >= 3 || totalLosses >= 3;
      const gameOverResult = gameOver
        ? totalWins >= 3
          ? 'victory'
          : 'defeat'
        : null;

      if (gameOver) {
        console.log(
          `[게임 오버] ${roomName}: ${gameOverResult} (승${totalWins} 패${totalLosses})`,
        );
        room.gameStarted = false;
      }

      room.gameFinished = true;
      room.lastGameResults = playerResults;
      room.gameOver = gameOver;
      room.gameOverResult = gameOverResult;

      // 성공 시 성공 횟수 증가
      if (isWinner) {
        room.successCount = (room.successCount ?? 0) + 1;
        console.log(
          `[성공 기록] ${roomName}: 성공 횟수 ${room.successCount}${room.successCount >= 2 ? ' (다음 라운드부터 손패 3장)' : ''}`,
        );
      }

      this.broadcastToRoom(roomName, 'gameFinished', {
        roomName,
        finalChips: room.state.chips,
        previousChips: Object.fromEntries(room.state.previousChips),
        openCards: room.state.openCards,
        playerResults,
        winLossRecord: Object.fromEntries(room.state.winLossRecord),
        gameOver,
        gameOverResult,
      });
      return;
    }

    // 칩 상태 업데이트 (스텝에 따라 색상 변경)
    const chipState = room.state.currentStep - 1; // 1->0, 2->1, 3->2, 4->3
    for (const chip of room.state.chips) {
      chip.state = chipState;
      chip.owner = null; // 칩 초기화
    }

    // 오픈 카드 추가: 스텝2에서 3장, 스텝3에서 +1장(4장), 스텝4에서 +1장(5장)
    const cardsToAdd = room.state.currentStep === 2 ? 3 : 1;
    for (let i = 0; i < cardsToAdd; i++) {
      if (room.state.deck.length > 0) {
        const card = room.state.deck.pop()!;
        room.state.openCards.push(card);
      }
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

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    // 게임 오버 상태에서는 다음 라운드 진행 불가
    if (!room.gameStarted) return;

    // 다음 라운드 준비 플레이어 추가
    if (!room.state.nextRoundReady.has(playerId)) {
      room.state.nextRoundReady.add(playerId);
    }

    // 모든 플레이어가 준비되었는지 확인
    const allReady = room.clients.size === room.state.nextRoundReady.size;

    this.broadcastToRoom(roomName, 'nextRoundReadyUpdate', {
      roomName,
      readyPlayers: Array.from(room.state.nextRoundReady),
      allReady,
    });

    // 모두 준비되면 게임 시작
    if (allReady) {
      // 준비 상태 초기화
      room.state.nextRoundReady.clear();

      // winLossRecord 보존 (다음 라운드에서는 누적되어야 함)
      const savedWinLossRecord = new Map(room.state.winLossRecord);

      // 게임 시작
      this.handleStartGame({ roomName }, client);

      // winLossRecord 복원
      room.state.winLossRecord = savedWinLossRecord;

      // 복원된 winLossRecord를 클라이언트에 다시 전송
      room.clients.forEach((playerClient) => {
        this.sendToClient(playerClient, 'gameStarted', {
          roomName,
          deck: room.state.deck,
          myHand: room.state.hands.get(playerClient) ?? [],
          playerHands: this.getPlayerHands(room),
          openCards: room.state.openCards,
          chips: room.state.chips,
          winLossRecord: Object.fromEntries(room.state.winLossRecord),
          gameOver: room.gameOver,
          gameOverResult: room.gameOverResult,
        });
      });
    }
  }

  @SubscribeMessage('testSuccess')
  handleTestSuccess(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName } = data;
    const room = this.rooms.get(roomName);

    if (!room || !room.clients.has(client)) return;
    if (!room.gameStarted) return;

    const engine = this.engineFactory.get(room.gameType);

    // 칩이 없으면 생성
    if (room.state.chips.length === 0) {
      room.state.chips = Array.from({ length: room.clients.size }, (_, i) => ({
        number: i + 1,
        state: 0,
        owner: null,
      }));
    }

    // 각 플레이어에게 카드 2장씩 배분 (성공 족보용)
    const baseUrl = GameGateway.CARD_IMAGE_BASE_URL;
    const testCards = [
      // A, A - 원페어
      { type: 'spades' as const, value: 1, image: `${baseUrl}/spades_ace.svg`, name: 'spades_ace' },
      { type: 'hearts' as const, value: 1, image: `${baseUrl}/hearts_ace.svg`, name: 'hearts_ace' },
      // 2, 2 - 원페어
      { type: 'spades' as const, value: 2, image: `${baseUrl}/spades_2.svg`, name: 'spades_2' },
      { type: 'hearts' as const, value: 2, image: `${baseUrl}/hearts_2.svg`, name: 'hearts_2' },
      // 3, 3 - 원페어
      { type: 'spades' as const, value: 3, image: `${baseUrl}/spades_3.svg`, name: 'spades_3' },
      { type: 'hearts' as const, value: 3, image: `${baseUrl}/hearts_3.svg`, name: 'hearts_3' },
      // 4, 4 - 원페어
      { type: 'spades' as const, value: 4, image: `${baseUrl}/spades_4.svg`, name: 'spades_4' },
      { type: 'hearts' as const, value: 4, image: `${baseUrl}/hearts_4.svg`, name: 'hearts_4' },
      // 5, 5 - 원페어
      { type: 'spades' as const, value: 5, image: `${baseUrl}/spades_5.svg`, name: 'spades_5' },
      { type: 'hearts' as const, value: 5, image: `${baseUrl}/hearts_5.svg`, name: 'hearts_5' },
      // 6, 6 - 원페어
      { type: 'spades' as const, value: 6, image: `${baseUrl}/spades_6.svg`, name: 'spades_6' },
      { type: 'hearts' as const, value: 6, image: `${baseUrl}/hearts_6.svg`, name: 'hearts_6' },
    ];

    // 오픈 카드 6장 (스텝 4까지 완료)
    room.state.openCards = [
      { type: 'clubs' as const, value: 7, image: `${baseUrl}/clubs_7.svg`, name: 'clubs_7' },
      { type: 'diamonds' as const, value: 8, image: `${baseUrl}/diamonds_8.svg`, name: 'diamonds_8' },
      { type: 'clubs' as const, value: 9, image: `${baseUrl}/clubs_9.svg`, name: 'clubs_9' },
      { type: 'diamonds' as const, value: 10, image: `${baseUrl}/diamonds_10.svg`, name: 'diamonds_10' },
      { type: 'clubs' as const, value: 11, image: `${baseUrl}/clubs_jack.svg`, name: 'clubs_jack' },
      { type: 'diamonds' as const, value: 12, image: `${baseUrl}/diamonds_queen.svg`, name: 'diamonds_queen' },
    ];

    // 각 플레이어에게 카드 2장씩 배분
    let cardIndex = 0;
    for (const playerClient of room.state.playerOrder) {
      const hand = [testCards[cardIndex], testCards[cardIndex + 1]];
      room.state.hands.set(playerClient, hand);
      cardIndex += 2;
    }

    // 칩을 플레이어 순서대로 배분 (1 < 2 < 3 < ... 순서로 성공)
    for (let i = 0; i < room.state.chips.length; i++) {
      const playerClient = room.state.playerOrder[i];
      const playerId = room.playerIds.get(playerClient) ?? '';
      room.state.chips[i].owner = playerId;

      // previousChips에 모든 스텝의 칩 기록
      const chipNumber = room.state.chips[i].number;
      room.state.previousChips.set(playerId, [chipNumber, chipNumber, chipNumber, chipNumber]);
    }

    // 스텝 4로 설정
    room.state.currentStep = 4;

    // 칩 상태를 red로 (스텝 4)
    for (const chip of room.state.chips) {
      chip.state = 3;
    }

    // playerResults 생성
    const playerResults = room.state.playerOrder.map((playerClient) => {
      const playerId = room.playerIds.get(playerClient) ?? '';
      const nickname = room.nicknames.get(playerClient) ?? '';
      const hand = room.state.hands.get(playerClient) ?? [];
      const playerPrevChips = room.state.previousChips.get(playerId) ?? [];

      return {
        playerId,
        nickname,
        hand,
        chips: playerPrevChips,
      };
    });

    // 성공으로 기록
    const isWinner = true;
    for (const result of playerResults) {
      const record = room.state.winLossRecord.get(result.playerId) || [];
      if (record.length >= 5) {
        record.shift();
      }
      record.push(isWinner);
      room.state.winLossRecord.set(result.playerId, record);
    }

    // 준비 상태 초기화
    room.state.playerReady.clear();

    // 게임 오버 체크
    const samplePlayerId = playerResults[0]?.playerId;
    const sampleRecord = samplePlayerId
      ? room.state.winLossRecord.get(samplePlayerId) || []
      : [];
    const totalWins = sampleRecord.filter((r) => r === true).length;
    const totalLosses = sampleRecord.filter((r) => r === false).length;
    const gameOver = totalWins >= 3 || totalLosses >= 3;
    const gameOverResult = gameOver
      ? totalWins >= 3
        ? 'victory'
        : 'defeat'
      : null;

    if (gameOver) {
      room.gameStarted = false;
    }

    room.gameFinished = true;
    room.lastGameResults = playerResults;
    room.gameOver = gameOver;
    room.gameOverResult = gameOverResult;

    this.broadcastToRoom(roomName, 'gameFinished', {
      roomName,
      finalChips: room.state.chips,
      previousChips: Object.fromEntries(room.state.previousChips),
      openCards: room.state.openCards,
      playerResults,
      winLossRecord: Object.fromEntries(room.state.winLossRecord),
      gameOver,
      gameOverResult,
    });

    console.log(`[테스트] ${roomName}: 성공 라운드로 즉시 완료`);
  }

  @SubscribeMessage('testFail')
  handleTestFail(
    @MessageBody() data: { roomName: string },
    @ConnectedSocket() client: WebSocket,
  ): void {
    const { roomName } = data;
    const room = this.rooms.get(roomName);

    if (!room || !room.clients.has(client)) return;
    if (!room.gameStarted) return;

    const engine = this.engineFactory.get(room.gameType);

    // 칩이 없으면 생성
    if (room.state.chips.length === 0) {
      room.state.chips = Array.from({ length: room.clients.size }, (_, i) => ({
        number: i + 1,
        state: 0,
        owner: null,
      }));
    }

    // 각 플레이어에게 카드 2장씩 배분 (실패 족보용 - 역순)
    const baseUrl = GameGateway.CARD_IMAGE_BASE_URL;
    const testCards = [
      // K, K - 원페어 (높음)
      { type: 'spades' as const, value: 13, image: `${baseUrl}/spades_king.svg`, name: 'spades_king' },
      { type: 'hearts' as const, value: 13, image: `${baseUrl}/hearts_king.svg`, name: 'hearts_king' },
      // Q, Q - 원페어
      { type: 'spades' as const, value: 12, image: `${baseUrl}/spades_queen.svg`, name: 'spades_queen' },
      { type: 'hearts' as const, value: 12, image: `${baseUrl}/hearts_queen.svg`, name: 'hearts_queen' },
      // J, J - 원페어
      { type: 'spades' as const, value: 11, image: `${baseUrl}/spades_jack.svg`, name: 'spades_jack' },
      { type: 'hearts' as const, value: 11, image: `${baseUrl}/hearts_jack.svg`, name: 'hearts_jack' },
      // 10, 10 - 원페어
      { type: 'spades' as const, value: 10, image: `${baseUrl}/spades_10.svg`, name: 'spades_10' },
      { type: 'hearts' as const, value: 10, image: `${baseUrl}/hearts_10.svg`, name: 'hearts_10' },
      // 9, 9 - 원페어
      { type: 'spades' as const, value: 9, image: `${baseUrl}/spades_9.svg`, name: 'spades_9' },
      { type: 'hearts' as const, value: 9, image: `${baseUrl}/hearts_9.svg`, name: 'hearts_9' },
      // 8, 8 - 원페어 (낮음)
      { type: 'spades' as const, value: 8, image: `${baseUrl}/spades_8.svg`, name: 'spades_8' },
      { type: 'hearts' as const, value: 8, image: `${baseUrl}/hearts_8.svg`, name: 'hearts_8' },
    ];

    // 오픈 카드 6장
    room.state.openCards = [
      { type: 'clubs' as const, value: 2, image: `${baseUrl}/clubs_2.svg`, name: 'clubs_2' },
      { type: 'diamonds' as const, value: 3, image: `${baseUrl}/diamonds_3.svg`, name: 'diamonds_3' },
      { type: 'clubs' as const, value: 4, image: `${baseUrl}/clubs_4.svg`, name: 'clubs_4' },
      { type: 'diamonds' as const, value: 5, image: `${baseUrl}/diamonds_5.svg`, name: 'diamonds_5' },
      { type: 'clubs' as const, value: 6, image: `${baseUrl}/clubs_6.svg`, name: 'clubs_6' },
      { type: 'diamonds' as const, value: 7, image: `${baseUrl}/diamonds_7.svg`, name: 'diamonds_7' },
    ];

    // 각 플레이어에게 카드 2장씩 배분
    let cardIndex = 0;
    for (const playerClient of room.state.playerOrder) {
      const hand = [testCards[cardIndex], testCards[cardIndex + 1]];
      room.state.hands.set(playerClient, hand);
      cardIndex += 2;
    }

    // 칩을 플레이어 순서대로 배분 (K > Q > J... 역순이므로 실패)
    for (let i = 0; i < room.state.chips.length; i++) {
      const playerClient = room.state.playerOrder[i];
      const playerId = room.playerIds.get(playerClient) ?? '';
      room.state.chips[i].owner = playerId;

      // previousChips에 모든 스텝의 칩 기록
      const chipNumber = room.state.chips[i].number;
      room.state.previousChips.set(playerId, [chipNumber, chipNumber, chipNumber, chipNumber]);
    }

    // 스텝 4로 설정
    room.state.currentStep = 4;

    // 칩 상태를 red로 (스텝 4)
    for (const chip of room.state.chips) {
      chip.state = 3;
    }

    // playerResults 생성
    const playerResults = room.state.playerOrder.map((playerClient) => {
      const playerId = room.playerIds.get(playerClient) ?? '';
      const nickname = room.nicknames.get(playerClient) ?? '';
      const hand = room.state.hands.get(playerClient) ?? [];
      const playerPrevChips = room.state.previousChips.get(playerId) ?? [];

      return {
        playerId,
        nickname,
        hand,
        chips: playerPrevChips,
      };
    });

    // 실패로 기록
    const isWinner = false;
    for (const result of playerResults) {
      const record = room.state.winLossRecord.get(result.playerId) || [];
      if (record.length >= 5) {
        record.shift();
      }
      record.push(isWinner);
      room.state.winLossRecord.set(result.playerId, record);
    }

    // 준비 상태 초기화
    room.state.playerReady.clear();

    // 게임 오버 체크
    const samplePlayerId = playerResults[0]?.playerId;
    const sampleRecord = samplePlayerId
      ? room.state.winLossRecord.get(samplePlayerId) || []
      : [];
    const totalWins = sampleRecord.filter((r) => r === true).length;
    const totalLosses = sampleRecord.filter((r) => r === false).length;
    const gameOver = totalWins >= 3 || totalLosses >= 3;
    const gameOverResult = gameOver
      ? totalWins >= 3
        ? 'victory'
        : 'defeat'
      : null;

    if (gameOver) {
      room.gameStarted = false;
    }

    room.gameFinished = true;
    room.lastGameResults = playerResults;
    room.gameOver = gameOver;
    room.gameOverResult = gameOverResult;

    this.broadcastToRoom(roomName, 'gameFinished', {
      roomName,
      finalChips: room.state.chips,
      previousChips: Object.fromEntries(room.state.previousChips),
      openCards: room.state.openCards,
      playerResults,
      winLossRecord: Object.fromEntries(room.state.winLossRecord),
      gameOver,
      gameOverResult,
    });

    console.log(`[테스트] ${roomName}: 실패 라운드로 즉시 완료`);
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

    const playerId = room.playerIds.get(client);
    const nickname = room.nicknames.get(client);

    // disconnect 타이머가 있으면 정리
    if (playerId) {
      const timer = room.disconnectTimers.get(playerId);
      if (timer) {
        clearTimeout(timer);
        room.disconnectTimers.delete(playerId);
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
    room.playerIds.delete(client);
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
        playerId,
        nickname,
        players,
      });
    }
  }

  // playerId로 기존 소켓 찾기
  private findClientByPlayerId(
    room: Room,
    playerId: string,
  ): WebSocket | undefined {
    for (const [client, id] of room.playerIds) {
      if (id === playerId) return client;
    }
    return undefined;
  }

  // playerId로 닉네임 찾기
  private getNicknameByPlayerId(room: Room, playerId: string): string {
    for (const [client, id] of room.playerIds) {
      if (id === playerId) {
        return room.nicknames.get(client) ?? playerId;
      }
    }
    return playerId;
  }

  // 이전 소켓을 새 소켓으로 교체 (손패, 순서 등 유지)
  private replaceClient(
    room: Room,
    oldClient: WebSocket,
    newClient: WebSocket,
  ): void {
    const playerId = room.playerIds.get(oldClient);
    const nickname = room.nicknames.get(oldClient);
    const hand = room.state.hands.get(oldClient) ?? [];

    // clients 교체
    room.clients.delete(oldClient);
    room.clients.add(newClient);

    // playerIds 교체
    room.playerIds.delete(oldClient);
    if (playerId) room.playerIds.set(newClient, playerId);

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
  ): { playerId: string; nickname: string; order: number }[] {
    const result: { playerId: string; nickname: string; order: number }[] = [];
    let index = 0;
    for (const [client] of room.playerIds) {
      const playerId = room.playerIds.get(client) ?? '';
      const nickname = room.nicknames.get(client) ?? playerId;
      result.push({ playerId, nickname, order: index });
      index++;
    }
    return result;
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
    playerResults: Array<{
      playerId: string;
      nickname: string;
      hand: any[];
      chips: number[];
    }>,
    openCards: any[],
  ): boolean {
    // 모든 플레이어의 칩 번호와 족보를 계산
    const playerRanks = playerResults.map((result) => {
      const handResult = this.evaluateHand(result.hand, openCards);
      return {
        nickname: result.nickname,
        chips: result.chips,
        score: handResult.score,
        tiebreakers: handResult.tiebreakers,
        detailName: handResult.detailName,
      };
    });

    // 칩 번호 순서대로 정렬 (4개 스텝이므로 4개 칩)
    const sortedByChip = [...playerRanks].sort((a, b) => {
      const aLastChip = a.chips[a.chips.length - 1] || 0;
      const bLastChip = b.chips[b.chips.length - 1] || 0;
      return aLastChip - bLastChip;
    });

    console.log('[승패 판정] 칩 번호순 정렬:');
    sortedByChip.forEach((p) => {
      console.log(
        `  ${p.nickname}: 칩 ${p.chips[p.chips.length - 1]}, 족보점수 ${p.score}, 타이브레이커 ${JSON.stringify(p.tiebreakers)}`,
      );
    });

    // 칩 번호 순서대로 족보가 오름차순인지 확인
    // 같은 detailName이면 동일 취급 (같은 족보명이면 순서 상관없이 OK)
    for (let i = 0; i < sortedByChip.length - 1; i++) {
      const current = sortedByChip[i];
      const next = sortedByChip[i + 1];

      // 같은 족보명이면 동일 취급 -> 통과
      if (current.detailName === next.detailName) {
        continue;
      }

      // 점수 비교
      if (current.score > next.score) {
        console.log(
          `  ❌ ${current.nickname}(${current.score}) > ${next.nickname}(${next.score})`,
        );
        return false;
      }

      // 같은 족보면 타이브레이커 비교
      if (current.score === next.score) {
        for (
          let j = 0;
          j < Math.min(current.tiebreakers.length, next.tiebreakers.length);
          j++
        ) {
          if (current.tiebreakers[j] > next.tiebreakers[j]) {
            console.log(
              `  ❌ 타이브레이커: ${current.nickname}[${j}](${current.tiebreakers[j]}) > ${next.nickname}[${j}](${next.tiebreakers[j]})`,
            );
            return false;
          }
          if (current.tiebreakers[j] < next.tiebreakers[j]) {
            break; // 다음 플레이어가 더 강함
          }
        }
      }
    }

    console.log('  ✅ 모든 조건 만족 - 성공!');
    return true; // 모든 조건 만족 -> 성공
  }

  private checkPlayerWinCondition(
    playerResult: { nickname: string; hand: any[]; chips: number[] },
    openCards: any[],
  ): boolean {
    // 플레이어의 칩이 오름차순인지 확인
    const chips = playerResult.chips;
    if (chips.length < 2) return true; // 칩이 1개 이하면 자동 성공

    for (let i = 0; i < chips.length - 1; i++) {
      if (chips[i] >= chips[i + 1]) {
        return false; // 칩이 오름차순이 아님 -> 실패
      }
    }

    return true; // 칩이 오름차순 -> 성공
  }

  // 프론트엔드 poker.ts의 evaluateHand 로직 (서버용으로 간소화)
  private evaluateHand(
    myCards: any[],
    openCards: any[],
  ): { score: number; tiebreakers: number[]; detailName: string } {
    const allCards = [...myCards, ...openCards];

    const HAND_SCORES = {
      'high-card': 1,
      'one-pair': 2,
      'two-pair': 3,
      'three-of-a-kind': 4,
      straight: 5,
      flush: 6,
      'full-house': 7,
      'four-of-a-kind': 8,
      'straight-flush': 9,
      'royal-straight-flush': 10,
    };

    const getRankValue = (value: number) => (value === 1 ? 14 : value);

    const getValueDisplayName = (value: number): string => {
      if (value === 1) return 'A';
      if (value === 11) return 'J';
      if (value === 12) return 'Q';
      if (value === 13) return 'K';
      return value.toString();
    };

    const countRanks = (cards: any[]) => {
      const counts = new Map<number, any[]>();
      for (const card of cards) {
        const existing = counts.get(card.value) || [];
        existing.push(card);
        counts.set(card.value, existing);
      }
      return counts;
    };

    const countSuits = (cards: any[]) => {
      const counts = new Map<string, any[]>();
      for (const card of cards) {
        const existing = counts.get(card.type) || [];
        existing.push(card);
        counts.set(card.type, existing);
      }
      return counts;
    };

    const isStraight = (cards: any[]): boolean => {
      if (cards.length < 5) return false;
      const sortedCards = [...cards].sort(
        (a, b) => getRankValue(a.value) - getRankValue(b.value),
      );

      for (let i = 0; i <= sortedCards.length - 5; i++) {
        let isConsecutive = true;
        for (let j = 0; j < 4; j++) {
          if (
            getRankValue(sortedCards[i + j + 1].value) !==
            getRankValue(sortedCards[i + j].value) + 1
          ) {
            isConsecutive = false;
            break;
          }
        }
        if (isConsecutive) return true;
      }

      const hasAce = sortedCards.some((c) => c.value === 1);
      const has2 = sortedCards.some((c) => c.value === 2);
      const has3 = sortedCards.some((c) => c.value === 3);
      const has4 = sortedCards.some((c) => c.value === 4);
      const has5 = sortedCards.some((c) => c.value === 5);
      return hasAce && has2 && has3 && has4 && has5;
    };

    const isFlush = (cards: any[]): boolean => {
      const suitCounts = countSuits(cards);
      for (const count of suitCounts.values()) {
        if (count.length >= 5) return true;
      }
      return false;
    };

    const isStraightFlush = (cards: any[]): boolean => {
      const suitCounts = countSuits(cards);
      for (const suitCards of suitCounts.values()) {
        if (suitCards.length >= 5 && isStraight(suitCards)) return true;
      }
      return false;
    };

    // 로얄 스트레이트 플러시
    if (isStraightFlush(allCards)) {
      const suitCounts = countSuits(allCards);
      for (const suitCards of suitCounts.values()) {
        if (suitCards.length >= 5 && isStraight(suitCards)) {
          const values = suitCards.map((c) => c.value).sort((a, b) => a - b);
          if (values.join(',').includes('1,10,11,12,13')) {
            return {
              score: HAND_SCORES['royal-straight-flush'],
              tiebreakers: [14],
              detailName: '10-J-Q-K-A 로얄 스트레이트 플러시',
            };
          }
          const sfTop = Math.max(...suitCards.map((c) => getRankValue(c.value)));
          return {
            score: HAND_SCORES['straight-flush'],
            tiebreakers: [sfTop],
            detailName: `${getValueDisplayName(sfTop === 14 ? 1 : sfTop)} 탑 스트레이트 플러시`,
          };
        }
      }
    }

    const rankCounts = countRanks(allCards);
    const countArray = Array.from(rankCounts.entries()).sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return getRankValue(b[0]) - getRankValue(a[0]);
    });

    // 포카드
    if (countArray.length > 0 && countArray[0][1].length === 4) {
      const fkValue = countArray[0][0];
      return {
        score: HAND_SCORES['four-of-a-kind'],
        tiebreakers: [getRankValue(fkValue)],
        detailName: `${getValueDisplayName(fkValue)} 포카드`,
      };
    }

    // 풀하우스
    if (
      countArray.length >= 2 &&
      countArray[0][1].length === 3 &&
      countArray[1][1].length >= 2
    ) {
      const tripleValue = countArray[0][0];
      const pairValue = countArray[1][0];
      return {
        score: HAND_SCORES['full-house'],
        tiebreakers: [
          getRankValue(tripleValue),
          getRankValue(pairValue),
        ],
        detailName: `${getValueDisplayName(tripleValue)} 풀하우스 (${getValueDisplayName(pairValue)} 페어)`,
      };
    }

    // 플러시
    if (isFlush(allCards)) {
      const suitCounts = countSuits(allCards);
      for (const suitCards of suitCounts.values()) {
        if (suitCards.length >= 5) {
          const sorted = suitCards
            .map((c) => getRankValue(c.value))
            .sort((a, b) => b - a)
            .slice(0, 5);
          const topRank = sorted[0];
          return {
            score: HAND_SCORES['flush'],
            tiebreakers: sorted,
            detailName: `${getValueDisplayName(topRank === 14 ? 1 : topRank)} 탑 플러시`,
          };
        }
      }
    }

    // 스트레이트
    if (isStraight(allCards)) {
      const sortedCards = [...allCards].sort(
        (a, b) => getRankValue(a.value) - getRankValue(b.value),
      );
      const hasAce = sortedCards.some((c) => c.value === 1);
      const has5 = sortedCards.some((c) => c.value === 5);
      const isBackStraight = hasAce && has5;
      const topValue = isBackStraight
        ? 5
        : Math.max(...allCards.map((c) => getRankValue(c.value)));
      return {
        score: HAND_SCORES['straight'],
        tiebreakers: isBackStraight
          ? [5]
          : [topValue],
        detailName: `${getValueDisplayName(topValue === 14 ? 1 : topValue)} 탑 스트레이트`,
      };
    }

    // 트리플
    if (countArray.length > 0 && countArray[0][1].length === 3) {
      const value = countArray[0][0];
      const tripleCards = countArray[0][1];
      const myCardInTriple = tripleCards.some((c) =>
        myCards.some((mc) => mc.name === c.name),
      );

      if (!myCardInTriple) {
        const sortedMyCards = myCards.sort(
          (a, b) => getRankValue(b.value) - getRankValue(a.value),
        );
        const tiebreakers = sortedMyCards.map((c) => getRankValue(c.value));
        const myHighCard = sortedMyCards[0];
        return {
          score: HAND_SCORES['high-card'],
          tiebreakers,
          detailName: myHighCard ? `${getValueDisplayName(myHighCard.value)} 하이` : '하이카드',
        };
      }

      const kickers = allCards
        .filter((c) => !tripleCards.some((tc) => tc.name === c.name))
        .sort((a, b) => getRankValue(b.value) - getRankValue(a.value))
        .slice(0, 2)
        .map((c) => getRankValue(c.value));
      return {
        score: HAND_SCORES['three-of-a-kind'],
        tiebreakers: [getRankValue(value), ...kickers],
        detailName: `${getValueDisplayName(value)} 트리플`,
      };
    }

    // 투페어
    if (
      countArray.length >= 2 &&
      countArray[0][1].length === 2 &&
      countArray[1][1].length === 2
    ) {
      const highValue = countArray[0][0];
      const lowValue = countArray[1][0];
      const pairCards = [...countArray[0][1], ...countArray[1][1]];
      const myCardInPair = pairCards.some((c) =>
        myCards.some((mc) => mc.name === c.name),
      );

      if (!myCardInPair) {
        const sortedMyCards = myCards.sort(
          (a, b) => getRankValue(b.value) - getRankValue(a.value),
        );
        const tiebreakers = sortedMyCards.map((c) => getRankValue(c.value));
        const myHighCard = sortedMyCards[0];
        return {
          score: HAND_SCORES['high-card'],
          tiebreakers,
          detailName: myHighCard ? `${getValueDisplayName(myHighCard.value)} 하이` : '하이카드',
        };
      }

      const kicker = allCards
        .filter((c) => !pairCards.some((pc) => pc.name === c.name))
        .sort((a, b) => getRankValue(b.value) - getRankValue(a.value))[0];
      return {
        score: HAND_SCORES['two-pair'],
        tiebreakers: [
          getRankValue(highValue),
          getRankValue(lowValue),
          kicker ? getRankValue(kicker.value) : 0,
        ],
        detailName: `${getValueDisplayName(highValue)}-${getValueDisplayName(lowValue)} 투페어`,
      };
    }

    // 원페어
    if (countArray.length > 0 && countArray[0][1].length === 2) {
      const value = countArray[0][0];
      const pairCards = countArray[0][1];
      const myCardInPair = pairCards.some((c) =>
        myCards.some((mc) => mc.name === c.name),
      );

      if (!myCardInPair) {
        const sortedMyCards = myCards.sort(
          (a, b) => getRankValue(b.value) - getRankValue(a.value),
        );
        const tiebreakers = sortedMyCards.map((c) => getRankValue(c.value));
        const myHighCard = sortedMyCards[0];
        return {
          score: HAND_SCORES['high-card'],
          tiebreakers,
          detailName: myHighCard ? `${getValueDisplayName(myHighCard.value)} 하이` : '하이카드',
        };
      }

      const kickers = allCards
        .filter((c) => !pairCards.some((pc) => pc.name === c.name))
        .sort((a, b) => getRankValue(b.value) - getRankValue(a.value))
        .slice(0, 3)
        .map((c) => getRankValue(c.value));
      return {
        score: HAND_SCORES['one-pair'],
        tiebreakers: [getRankValue(value), ...kickers],
        detailName: `${getValueDisplayName(value)} 원페어`,
      };
    }

    // 하이카드
    const myCardsSorted = myCards.sort(
      (a, b) => getRankValue(b.value) - getRankValue(a.value),
    );
    const highCard = myCardsSorted.length > 0 ? myCardsSorted[0] : allCards.sort((a, b) => getRankValue(b.value) - getRankValue(a.value))[0];
    const allSorted = allCards
      .sort((a, b) => getRankValue(b.value) - getRankValue(a.value))
      .slice(0, 5);
    return {
      score: HAND_SCORES['high-card'],
      tiebreakers: allSorted.map((c) => getRankValue(c.value)),
      detailName: `${getValueDisplayName(highCard.value)} 하이카드`,
    };
  }
}
