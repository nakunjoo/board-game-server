import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { GameEngineFactory } from '../../game-engine.factory';

/**
 * '더 갱' 게임 전용 이벤트 핸들러
 * startGame, drawCard, selectChip, playerReady, readyNextRound, testSuccess, testFail
 */
@Injectable()
export class GangHandler {
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

    if (room.clients.size < 3) {
      this.ctx.sendToClient(client, 'error', {
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

  // ── drawCard ──────────────────────────────────────────────

  handleDrawCard(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    const engine = this.engineFactory.get(room.gameType);

    try {
      const targetClient = room.state.playerOrder[room.state.currentTurn];
      const targetNickname = room.nicknames.get(targetClient) ?? '';
      const result = engine.drawCard(room.state);

      this.ctx.broadcastToRoom(roomName, 'cardDrawn', {
        roomName,
        card: result.card,
        deck: room.state.deck,
        playerNickname: targetNickname,
        playerHands: this.ctx.getPlayerHands(room),
      });
    } catch (e) {
      this.ctx.sendToClient(client, 'error', {
        message: (e as Error).message,
      });
    }
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
      const previousOwnerNickname = this.ctx.getNicknameByPlayerId(
        room,
        previousOwnerId,
      );
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
      this.ctx.sendToClient(client, 'error', {
        message: '칩을 먼저 선택해주세요',
      });
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

  // ── testSuccess ───────────────────────────────────────────

  handleTestSuccess(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) return;
    if (!room.gameStarted) return;

    const baseUrl = GameContext.CARD_IMAGE_BASE_URL;

    if (room.state.chips.length === 0) {
      room.state.chips = Array.from({ length: room.clients.size }, (_, i) => ({
        number: i + 1,
        state: 0,
        owner: null,
      }));
    }

    const testCards = [
      {
        type: 'spades' as const,
        value: 1,
        image: `${baseUrl}/spades_ace.svg`,
        name: 'spades_ace',
      },
      {
        type: 'hearts' as const,
        value: 1,
        image: `${baseUrl}/hearts_ace.svg`,
        name: 'hearts_ace',
      },
      {
        type: 'spades' as const,
        value: 2,
        image: `${baseUrl}/spades_2.svg`,
        name: 'spades_2',
      },
      {
        type: 'hearts' as const,
        value: 2,
        image: `${baseUrl}/hearts_2.svg`,
        name: 'hearts_2',
      },
      {
        type: 'spades' as const,
        value: 3,
        image: `${baseUrl}/spades_3.svg`,
        name: 'spades_3',
      },
      {
        type: 'hearts' as const,
        value: 3,
        image: `${baseUrl}/hearts_3.svg`,
        name: 'hearts_3',
      },
      {
        type: 'spades' as const,
        value: 4,
        image: `${baseUrl}/spades_4.svg`,
        name: 'spades_4',
      },
      {
        type: 'hearts' as const,
        value: 4,
        image: `${baseUrl}/hearts_4.svg`,
        name: 'hearts_4',
      },
      {
        type: 'spades' as const,
        value: 5,
        image: `${baseUrl}/spades_5.svg`,
        name: 'spades_5',
      },
      {
        type: 'hearts' as const,
        value: 5,
        image: `${baseUrl}/hearts_5.svg`,
        name: 'hearts_5',
      },
      {
        type: 'spades' as const,
        value: 6,
        image: `${baseUrl}/spades_6.svg`,
        name: 'spades_6',
      },
      {
        type: 'hearts' as const,
        value: 6,
        image: `${baseUrl}/hearts_6.svg`,
        name: 'hearts_6',
      },
    ];

    room.state.openCards = [
      {
        type: 'clubs' as const,
        value: 7,
        image: `${baseUrl}/clubs_7.svg`,
        name: 'clubs_7',
      },
      {
        type: 'diamonds' as const,
        value: 8,
        image: `${baseUrl}/diamonds_8.svg`,
        name: 'diamonds_8',
      },
      {
        type: 'clubs' as const,
        value: 9,
        image: `${baseUrl}/clubs_9.svg`,
        name: 'clubs_9',
      },
      {
        type: 'diamonds' as const,
        value: 10,
        image: `${baseUrl}/diamonds_10.svg`,
        name: 'diamonds_10',
      },
      {
        type: 'clubs' as const,
        value: 11,
        image: `${baseUrl}/clubs_jack.svg`,
        name: 'clubs_jack',
      },
      {
        type: 'diamonds' as const,
        value: 12,
        image: `${baseUrl}/diamonds_queen.svg`,
        name: 'diamonds_queen',
      },
    ];

    let cardIndex = 0;
    for (const playerClient of room.state.playerOrder) {
      room.state.hands.set(playerClient, [
        testCards[cardIndex],
        testCards[cardIndex + 1],
      ]);
      cardIndex += 2;
    }

    for (let i = 0; i < room.state.chips.length; i++) {
      const playerClient = room.state.playerOrder[i];
      const playerId = room.playerIds.get(playerClient) ?? '';
      room.state.chips[i].owner = playerId;
      const chipNumber = room.state.chips[i].number;
      room.state.previousChips.set(playerId, [
        chipNumber,
        chipNumber,
        chipNumber,
        chipNumber,
      ]);
    }

    room.state.currentStep = 4;
    for (const chip of room.state.chips) chip.state = 3;

    this.finishGame(roomName, true);
    console.log(`[테스트] ${roomName}: 성공 라운드로 즉시 완료`);
  }

  // ── testFail ──────────────────────────────────────────────

  handleTestFail(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) return;
    if (!room.gameStarted) return;

    const baseUrl = GameContext.CARD_IMAGE_BASE_URL;

    if (room.state.chips.length === 0) {
      room.state.chips = Array.from({ length: room.clients.size }, (_, i) => ({
        number: i + 1,
        state: 0,
        owner: null,
      }));
    }

    const testCards = [
      {
        type: 'spades' as const,
        value: 13,
        image: `${baseUrl}/spades_king.svg`,
        name: 'spades_king',
      },
      {
        type: 'hearts' as const,
        value: 13,
        image: `${baseUrl}/hearts_king.svg`,
        name: 'hearts_king',
      },
      {
        type: 'spades' as const,
        value: 12,
        image: `${baseUrl}/spades_queen.svg`,
        name: 'spades_queen',
      },
      {
        type: 'hearts' as const,
        value: 12,
        image: `${baseUrl}/hearts_queen.svg`,
        name: 'hearts_queen',
      },
      {
        type: 'spades' as const,
        value: 11,
        image: `${baseUrl}/spades_jack.svg`,
        name: 'spades_jack',
      },
      {
        type: 'hearts' as const,
        value: 11,
        image: `${baseUrl}/hearts_jack.svg`,
        name: 'hearts_jack',
      },
      {
        type: 'spades' as const,
        value: 10,
        image: `${baseUrl}/spades_10.svg`,
        name: 'spades_10',
      },
      {
        type: 'hearts' as const,
        value: 10,
        image: `${baseUrl}/hearts_10.svg`,
        name: 'hearts_10',
      },
      {
        type: 'spades' as const,
        value: 9,
        image: `${baseUrl}/spades_9.svg`,
        name: 'spades_9',
      },
      {
        type: 'hearts' as const,
        value: 9,
        image: `${baseUrl}/hearts_9.svg`,
        name: 'hearts_9',
      },
      {
        type: 'spades' as const,
        value: 8,
        image: `${baseUrl}/spades_8.svg`,
        name: 'spades_8',
      },
      {
        type: 'hearts' as const,
        value: 8,
        image: `${baseUrl}/hearts_8.svg`,
        name: 'hearts_8',
      },
    ];

    room.state.openCards = [
      {
        type: 'clubs' as const,
        value: 2,
        image: `${baseUrl}/clubs_2.svg`,
        name: 'clubs_2',
      },
      {
        type: 'diamonds' as const,
        value: 3,
        image: `${baseUrl}/diamonds_3.svg`,
        name: 'diamonds_3',
      },
      {
        type: 'clubs' as const,
        value: 4,
        image: `${baseUrl}/clubs_4.svg`,
        name: 'clubs_4',
      },
      {
        type: 'diamonds' as const,
        value: 5,
        image: `${baseUrl}/diamonds_5.svg`,
        name: 'diamonds_5',
      },
      {
        type: 'clubs' as const,
        value: 6,
        image: `${baseUrl}/clubs_6.svg`,
        name: 'clubs_6',
      },
      {
        type: 'diamonds' as const,
        value: 7,
        image: `${baseUrl}/diamonds_7.svg`,
        name: 'diamonds_7',
      },
    ];

    let cardIndex = 0;
    for (const playerClient of room.state.playerOrder) {
      room.state.hands.set(playerClient, [
        testCards[cardIndex],
        testCards[cardIndex + 1],
      ]);
      cardIndex += 2;
    }

    for (let i = 0; i < room.state.chips.length; i++) {
      const playerClient = room.state.playerOrder[i];
      const playerId = room.playerIds.get(playerClient) ?? '';
      room.state.chips[i].owner = playerId;
      const chipNumber = room.state.chips[i].number;
      room.state.previousChips.set(playerId, [
        chipNumber,
        chipNumber,
        chipNumber,
        chipNumber,
      ]);
    }

    room.state.currentStep = 4;
    for (const chip of room.state.chips) chip.state = 3;

    this.finishGame(roomName, false);
    console.log(`[테스트] ${roomName}: 실패 라운드로 즉시 완료`);
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

      const isWinner = this.checkWinCondition(
        playerResults,
        room.state.openCards,
      );
      console.log(`[승패 판정] 전체 결과 -> ${isWinner ? '성공' : '실패'}`);

      this.finishGame(roomName, isWinner);
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

  private finishGame(roomName: string, isWinner: boolean): void {
    const room = this.ctx.rooms.get(roomName);
    if (!room) return;

    const playerResults = room.state.playerOrder.map((c) => ({
      playerId: room.playerIds.get(c) ?? '',
      nickname: room.nicknames.get(c) ?? '',
      hand: room.state.hands.get(c) ?? [],
      chips: room.state.previousChips.get(room.playerIds.get(c) ?? '') ?? [],
    }));

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

    if (isWinner) {
      room.successCount = (room.successCount ?? 0) + 1;
      console.log(
        `[성공 기록] ${roomName}: 성공 횟수 ${room.successCount}${room.successCount >= 2 ? ' (다음 라운드부터 손패 3장)' : ''}`,
      );
    }

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

  private checkWinCondition(
    playerResults: Array<{
      playerId: string;
      nickname: string;
      hand: any[];
      chips: number[];
    }>,
    openCards: any[],
  ): boolean {
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

    for (let i = 0; i < sortedByChip.length - 1; i++) {
      const current = sortedByChip[i];
      const next = sortedByChip[i + 1];

      if (current.detailName === next.detailName) continue;

      if (current.score > next.score) {
        console.log(
          `  ❌ ${current.nickname}(${current.score}) > ${next.nickname}(${next.score})`,
        );
        return false;
      }

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
          if (current.tiebreakers[j] < next.tiebreakers[j]) break;
        }
      }
    }

    console.log('  ✅ 모든 조건 만족 - 성공!');
    return true;
  }

  private evaluateHand(
    myCards: any[],
    openCards: any[],
  ): { score: number; tiebreakers: number[]; detailName: string } {
    const allCards = [...myCards, ...openCards];

    const HAND_SCORES: Record<string, number> = {
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
      const sorted = [...cards].sort(
        (a, b) => getRankValue(a.value) - getRankValue(b.value),
      );
      for (let i = 0; i <= sorted.length - 5; i++) {
        let ok = true;
        for (let j = 0; j < 4; j++) {
          if (
            getRankValue(sorted[i + j + 1].value) !==
            getRankValue(sorted[i + j].value) + 1
          ) {
            ok = false;
            break;
          }
        }
        if (ok) return true;
      }
      return (
        sorted.some((c) => c.value === 1) &&
        sorted.some((c) => c.value === 2) &&
        sorted.some((c) => c.value === 3) &&
        sorted.some((c) => c.value === 4) &&
        sorted.some((c) => c.value === 5)
      );
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

    if (isStraightFlush(allCards)) {
      const suitCounts = countSuits(allCards);
      for (const suitCards of suitCounts.values()) {
        if (suitCards.length >= 5 && isStraight(suitCards)) {
          const values = suitCards
            .map((c) => c.value)
            .sort((a: number, b: number) => a - b);
          if (values.join(',').includes('1,10,11,12,13')) {
            return {
              score: HAND_SCORES['royal-straight-flush'],
              tiebreakers: [14],
              detailName: '10-J-Q-K-A 로얄 스트레이트 플러시',
            };
          }
          const sfTop = Math.max(
            ...suitCards.map((c) => getRankValue(c.value)),
          );
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

    if (countArray.length > 0 && countArray[0][1].length === 4) {
      const fkValue = countArray[0][0];
      return {
        score: HAND_SCORES['four-of-a-kind'],
        tiebreakers: [getRankValue(fkValue)],
        detailName: `${getValueDisplayName(fkValue)} 포카드`,
      };
    }

    if (
      countArray.length >= 2 &&
      countArray[0][1].length === 3 &&
      countArray[1][1].length >= 2
    ) {
      const tripleValue = countArray[0][0];
      const pairValue = countArray[1][0];
      return {
        score: HAND_SCORES['full-house'],
        tiebreakers: [getRankValue(tripleValue), getRankValue(pairValue)],
        detailName: `${getValueDisplayName(tripleValue)} 풀하우스 (${getValueDisplayName(pairValue)} 페어)`,
      };
    }

    if (isFlush(allCards)) {
      const suitCounts = countSuits(allCards);
      for (const suitCards of suitCounts.values()) {
        if (suitCards.length >= 5) {
          const sorted = suitCards
            .map((c) => getRankValue(c.value))
            .sort((a: number, b: number) => b - a)
            .slice(0, 5);
          return {
            score: HAND_SCORES['flush'],
            tiebreakers: sorted,
            detailName: `${getValueDisplayName(sorted[0] === 14 ? 1 : sorted[0])} 탑 플러시`,
          };
        }
      }
    }

    if (isStraight(allCards)) {
      const hasAce = allCards.some((c) => c.value === 1);
      const has5 = allCards.some((c) => c.value === 5);
      const isBackStraight = hasAce && has5;
      const topValue = isBackStraight
        ? 5
        : Math.max(...allCards.map((c) => getRankValue(c.value)));
      return {
        score: HAND_SCORES['straight'],
        tiebreakers: [topValue],
        detailName: `${getValueDisplayName(topValue === 14 ? 1 : topValue)} 탑 스트레이트`,
      };
    }

    if (countArray.length > 0 && countArray[0][1].length === 3) {
      const value = countArray[0][0];
      const tripleCards = countArray[0][1];
      const myCardInTriple = tripleCards.some((c) =>
        myCards.some((mc) => mc.name === c.name),
      );
      if (!myCardInTriple) {
        const sortedMy = [...myCards].sort(
          (a, b) => getRankValue(b.value) - getRankValue(a.value),
        );
        return {
          score: HAND_SCORES['high-card'],
          tiebreakers: sortedMy.map((c) => getRankValue(c.value)),
          detailName: sortedMy[0]
            ? `${getValueDisplayName(sortedMy[0].value)} 하이`
            : '하이카드',
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
        const sortedMy = [...myCards].sort(
          (a, b) => getRankValue(b.value) - getRankValue(a.value),
        );
        return {
          score: HAND_SCORES['high-card'],
          tiebreakers: sortedMy.map((c) => getRankValue(c.value)),
          detailName: sortedMy[0]
            ? `${getValueDisplayName(sortedMy[0].value)} 하이`
            : '하이카드',
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

    if (countArray.length > 0 && countArray[0][1].length === 2) {
      const value = countArray[0][0];
      const pairCards = countArray[0][1];
      const myCardInPair = pairCards.some((c) =>
        myCards.some((mc) => mc.name === c.name),
      );
      if (!myCardInPair) {
        const sortedMy = [...myCards].sort(
          (a, b) => getRankValue(b.value) - getRankValue(a.value),
        );
        return {
          score: HAND_SCORES['high-card'],
          tiebreakers: sortedMy.map((c) => getRankValue(c.value)),
          detailName: sortedMy[0]
            ? `${getValueDisplayName(sortedMy[0].value)} 하이`
            : '하이카드',
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

    const myCardsSorted = [...myCards].sort(
      (a, b) => getRankValue(b.value) - getRankValue(a.value),
    );
    const highCard =
      myCardsSorted[0] ??
      [...allCards].sort(
        (a, b) => getRankValue(b.value) - getRankValue(a.value),
      )[0];
    const allSorted = [...allCards]
      .sort((a, b) => getRankValue(b.value) - getRankValue(a.value))
      .slice(0, 5);
    return {
      score: HAND_SCORES['high-card'],
      tiebreakers: allSorted.map((c) => getRankValue(c.value)),
      detailName: `${getValueDisplayName(highCard.value)} 하이카드`,
    };
  }
}
