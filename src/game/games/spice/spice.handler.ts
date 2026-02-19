import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { GameEngineFactory } from '../../game-engine.factory';

/**
 * '향신료' 게임 전용 이벤트 핸들러
 * startGame, selectChip, playerReady, readyNextRound
 */
@Injectable()
export class SpiceHandler {
  constructor(
    private readonly ctx: GameContext,
    private readonly engineFactory: GameEngineFactory,
  ) {}

  // ── startGame ─────────────────────────────────────────────

  handleStartGame(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    // 향신료는 1명부터 시작 가능
    const engine = this.engineFactory.get('spice');
    room.state.deck = engine.createDeck();
    room.gameStarted = true;
    room.gameFinished = false;
    room.lastGameResults = undefined;
    room.gameOver = false;
    room.gameOverResult = null;

    room.state.openCards = [];
    room.state.currentStep = 1;
    room.state.playerReady = new Set();
    room.state.nextRoundReady = new Set();
    room.state.previousChips = new Map();
    room.state.winLossRecord = new Map();

    room.state.hands.clear();
    for (const playerClient of room.state.playerOrder) {
      room.state.hands.set(playerClient, []);
    }

    room.state.chips = Array.from({ length: room.clients.size }, (_, i) => ({
      number: i + 1,
      state: 0,
      owner: null,
    }));

    // 초기 손패 6장 배분
    for (let round = 0; round < 6; round++) {
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
      `[Spice] Game started in room '${roomName}' with ${room.clients.size} players`,
    );

    room.clients.forEach((playerClient) => {
      this.ctx.sendToClient(playerClient, 'gameStarted', {
        roomName,
        deck: room.state.deck,
        myHand: room.state.hands.get(playerClient) ?? [],
        playerHands: this.ctx.getPlayerHands(room),
        openCards: room.state.openCards,
        chips: room.state.chips,
        winLossRecord: Object.fromEntries(room.state.winLossRecord),
        gameOver: room.gameOver,
        gameOverResult: room.gameOverResult,
      });
    });
  }

  // ── selectChip ────────────────────────────────────────────

  handleSelectChip(
    data: { roomName: string; chipNumber: number },
    client: WebSocket,
  ): void {
    const { roomName, chipNumber } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;
    const nickname = room.nicknames.get(client) ?? playerId;

    const chip = room.state.chips.find((c) => c.number === chipNumber);
    if (!chip) return;

    const previousOwnerId = chip.owner;
    const existingChip = room.state.chips.find((c) => c.owner === playerId);
    if (existingChip) existingChip.owner = null;

    chip.owner = playerId;

    const affectedPlayerIds = [playerId];
    if (previousOwnerId && previousOwnerId !== playerId) {
      affectedPlayerIds.push(previousOwnerId);
    }

    const unreadyPlayers: string[] = [];
    affectedPlayerIds.forEach((pid) => {
      if (room.state.playerReady.has(pid)) {
        room.state.playerReady.delete(pid);
        unreadyPlayers.push(pid);
      }
    });

    if (previousOwnerId && previousOwnerId !== playerId) {
      const previousOwnerNickname = this.ctx.getNicknameByPlayerId(room, previousOwnerId);
      this.ctx.broadcastToRoom(roomName, 'roomMessage', {
        roomName,
        message: `${nickname}님이 ${previousOwnerNickname}님의 ${chipNumber}번 칩을 가져갔습니다.`,
        isSystem: true,
      });
    }

    const isStolen = previousOwnerId && previousOwnerId !== playerId;
    this.ctx.broadcastToRoom(roomName, 'chipSelected', {
      roomName,
      chips: room.state.chips,
      readyPlayers: Array.from(room.state.playerReady),
      stolenFrom: isStolen ? previousOwnerId : undefined,
      stolenBy: isStolen ? playerId : undefined,
      stolenFromName: isStolen
        ? this.ctx.getNicknameByPlayerId(room, previousOwnerId)
        : undefined,
      stolenByName: isStolen ? nickname : undefined,
      chipNumber: isStolen ? chipNumber : undefined,
    });

    if (unreadyPlayers.length > 0) {
      this.ctx.broadcastToRoom(roomName, 'playerReadyUpdate', {
        roomName,
        readyPlayers: Array.from(room.state.playerReady),
        allReady: false,
      });
    }
  }

  // ── playerReady ───────────────────────────────────────────

  handlePlayerReady(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    const playerChip = room.state.chips.find((c) => c.owner === playerId);
    if (!playerChip) {
      this.ctx.sendToClient(client, 'error', { message: '칩을 먼저 선택해주세요' });
      return;
    }

    room.state.playerReady.add(playerId);
    const allReady = room.clients.size === room.state.playerReady.size;

    this.ctx.broadcastToRoom(roomName, 'playerReadyUpdate', {
      roomName,
      readyPlayers: Array.from(room.state.playerReady),
      allReady,
    });

    if (allReady) {
      this.proceedToNextStep(roomName);
    }
  }

  // ── readyNextRound ────────────────────────────────────────

  handleReadyNextRound(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;
    if (!room.gameStarted) return;

    if (!room.state.nextRoundReady.has(playerId)) {
      room.state.nextRoundReady.add(playerId);
    }

    const allReady = room.clients.size === room.state.nextRoundReady.size;

    this.ctx.broadcastToRoom(roomName, 'nextRoundReadyUpdate', {
      roomName,
      readyPlayers: Array.from(room.state.nextRoundReady),
      allReady,
    });

    if (allReady) {
      room.state.nextRoundReady.clear();
      const savedWinLossRecord = new Map(room.state.winLossRecord);
      this.handleStartGame({ roomName }, client);
      room.state.winLossRecord = savedWinLossRecord;

      room.clients.forEach((playerClient) => {
        this.ctx.sendToClient(playerClient, 'gameStarted', {
          roomName,
          deck: room.state.deck,
          myHand: room.state.hands.get(playerClient) ?? [],
          playerHands: this.ctx.getPlayerHands(room),
          openCards: room.state.openCards,
          chips: room.state.chips,
          winLossRecord: Object.fromEntries(room.state.winLossRecord),
          gameOver: room.gameOver,
          gameOverResult: room.gameOverResult,
        });
      });
    }
  }

  // ── 내부 로직 ─────────────────────────────────────────────

  private proceedToNextStep(roomName: string): void {
    const room = this.ctx.rooms.get(roomName);
    if (!room) return;

    for (const chip of room.state.chips) {
      if (chip.owner) {
        const prev = room.state.previousChips.get(chip.owner) || [];
        prev.push(chip.number);
        room.state.previousChips.set(chip.owner, prev);
      }
    }

    room.state.currentStep++;

    if (room.state.currentStep > 4) {
      const playerResults = room.state.playerOrder.map((c) => ({
        playerId: room.playerIds.get(c) ?? '',
        nickname: room.nicknames.get(c) ?? '',
        hand: room.state.hands.get(c) ?? [],
        chips: room.state.previousChips.get(room.playerIds.get(c) ?? '') ?? [],
      }));

      this.finishGame(roomName);
      return;
    }

    const chipState = room.state.currentStep - 1;
    for (const chip of room.state.chips) {
      chip.state = chipState;
      chip.owner = null;
    }

    const cardsToAdd = room.state.currentStep === 2 ? 3 : 1;
    for (let i = 0; i < cardsToAdd; i++) {
      if (room.state.deck.length > 0) {
        room.state.openCards.push(room.state.deck.pop()!);
      }
    }

    room.state.playerReady.clear();

    this.ctx.broadcastToRoom(roomName, 'nextStep', {
      roomName,
      currentStep: room.state.currentStep,
      openCards: room.state.openCards,
      chips: room.state.chips,
      deck: room.state.deck,
      previousChips: Object.fromEntries(room.state.previousChips),
    });
  }

  private finishGame(roomName: string): void {
    const room = this.ctx.rooms.get(roomName);
    if (!room) return;

    const playerResults = room.state.playerOrder.map((c) => ({
      playerId: room.playerIds.get(c) ?? '',
      nickname: room.nicknames.get(c) ?? '',
      hand: room.state.hands.get(c) ?? [],
      chips: room.state.previousChips.get(room.playerIds.get(c) ?? '') ?? [],
    }));

    // 향신료 게임의 승패 판정은 추후 구현
    const isWinner = false;

    for (const result of playerResults) {
      const record = room.state.winLossRecord.get(result.playerId) || [];
      if (record.length >= 5) record.shift();
      record.push(isWinner);
      room.state.winLossRecord.set(result.playerId, record);
    }

    room.state.playerReady.clear();

    const sampleRecord =
      room.state.winLossRecord.get(playerResults[0]?.playerId) || [];
    const totalWins = sampleRecord.filter((r) => r === true).length;
    const totalLosses = sampleRecord.filter((r) => r === false).length;
    const gameOver = totalWins >= 3 || totalLosses >= 3;
    const gameOverResult: 'victory' | 'defeat' | null = gameOver
      ? totalWins >= 3 ? 'victory' : 'defeat'
      : null;

    if (gameOver) {
      room.gameStarted = false;
    }

    room.gameFinished = true;
    room.lastGameResults = playerResults;
    room.gameOver = gameOver;
    room.gameOverResult = gameOverResult;

    this.ctx.broadcastToRoom(roomName, 'gameFinished', {
      roomName,
      finalChips: room.state.chips,
      previousChips: Object.fromEntries(room.state.previousChips),
      openCards: room.state.openCards,
      playerResults,
      winLossRecord: Object.fromEntries(room.state.winLossRecord),
      gameOver,
      gameOverResult,
    });
  }
}
