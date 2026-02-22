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

    const playerId = room.playerIds.get(client);
    if (playerId !== room.hostPlayerId) {
      this.ctx.sendToClient(client, 'error', { message: '방장만 게임을 시작할 수 있습니다' });
      return;
    }

    // 선뽑기 시작: 1~10 중 랜덤 카드 배정
    room.state.firstDraw = new Map(); // playerId → 뽑은 숫자
    room.state.firstDrawDone = new Set(); // 뽑기 완료한 playerId

    // 1~10 숫자 섞어서 플레이어 수만큼 준비
    const numbers = Array.from({ length: 10 }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    room.state.firstDrawPool = numbers;

    console.log(
      `[Spice] First draw started in room '${roomName}' with ${room.clients.size} players`,
    );

    this.ctx.broadcastToRoom(roomName, 'firstDrawStarted', {
      roomName,
      players: this.ctx.getPlayersWithOrder(room),
    });
  }

  // ── drawFirstCard ──────────────────────────────────────────

  handleDrawFirstCard(data: { roomName: string }, client: WebSocket): void {
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

    if (!room.state.firstDraw || !room.state.firstDrawPool) return;
    if (room.state.firstDrawDone?.has(playerId)) {
      this.ctx.sendToClient(client, 'error', { message: '이미 카드를 뽑았습니다' });
      return;
    }

    // 풀에서 카드 하나 뽑기
    const drawnNumber = room.state.firstDrawPool.pop()!;
    room.state.firstDraw.set(playerId, drawnNumber);
    room.state.firstDrawDone!.add(playerId);

    // 뽑은 결과를 본인에게만 전송
    this.ctx.sendToClient(client, 'firstDrawResult', {
      roomName,
      playerId,
      drawnNumber,
      drawnCount: room.state.firstDrawDone!.size,
      totalCount: room.clients.size,
    });

    // 전체에게 진행 상황 브로드캐스트
    this.ctx.broadcastToRoom(roomName, 'firstDrawProgress', {
      roomName,
      drawnCount: room.state.firstDrawDone!.size,
      totalCount: room.clients.size,
    });

    // 모두 뽑았으면 결과 발표 후 게임 시작
    if (room.state.firstDrawDone!.size === room.clients.size) {
      // 가장 높은 숫자를 뽑은 플레이어가 선
      let maxNumber = -1;
      let firstPlayerId = '';
      room.state.firstDraw.forEach((num, pid) => {
        if (num > maxNumber) {
          maxNumber = num;
          firstPlayerId = pid;
        }
      });

      const firstDrawResults: Record<string, number> = {};
      room.state.firstDraw.forEach((num, pid) => {
        firstDrawResults[pid] = num;
      });

      const firstNickname = this.ctx.getNicknameByPlayerId(room, firstPlayerId);

      console.log(
        `[Spice] First draw result in room '${roomName}': ${firstNickname} (${firstPlayerId}) goes first with ${maxNumber}`,
      );

      this.ctx.broadcastToRoom(roomName, 'firstDrawFinished', {
        roomName,
        results: firstDrawResults,
        firstPlayerId,
        firstNickname,
      });

      // 잠시 후 본 게임 시작
      setTimeout(() => {
        this.startMainGame(roomName, firstPlayerId);
      }, 2000);
    }
  }

  // ── 선뽑기 후 본 게임 시작 ─────────────────────────────────

  private startMainGame(roomName: string, firstPlayerId: string): void {
    const room = this.ctx.rooms.get(roomName);
    if (!room) return;

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
    room.state.firstDraw = undefined;
    room.state.firstDrawDone = undefined;
    room.state.firstDrawPool = undefined;
    room.state.currentTurnPlayerId = firstPlayerId;
    room.state.turnStartedAt = Date.now();
    room.state.currentSuit = null;
    room.state.currentNumber = 0;
    room.state.tableStack = [];
    room.state.trophies = new Map();
    room.state.wonCards = new Map();

    // 선 플레이어부터 playerOrder 재정렬
    const firstClient = this.ctx.findClientByPlayerId(room, firstPlayerId);
    if (firstClient) {
      const idx = room.state.playerOrder.indexOf(firstClient);
      if (idx > 0) {
        room.state.playerOrder = [
          ...room.state.playerOrder.slice(idx),
          ...room.state.playerOrder.slice(0, idx),
        ];
      }
    }

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
      `[Spice] Main game started in room '${roomName}' with ${room.clients.size} players. First: ${firstPlayerId}`,
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
        firstPlayerId,
        currentTurnPlayerId: firstPlayerId,
        currentSuit: null,
        currentNumber: 0,
        trophies: {},
      });
    });
  }

  // ── playCard ───────────────────────────────────────────────

  handlePlayCard(
    data: { roomName: string; cardIndex: number; declaredSuit: string; declaredNumber: number },
    client: WebSocket,
  ): void {
    const { roomName, cardIndex, declaredSuit, declaredNumber } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    // 내 턴인지 확인
    if (room.state.currentTurnPlayerId !== playerId) {
      this.ctx.sendToClient(client, 'error', { message: '지금은 당신의 차례가 아닙니다' });
      return;
    }

    // 도전 페이즈 중에는 카드를 낼 수 없음
    if (room.state.challengePhase) {
      this.ctx.sendToClient(client, 'error', { message: '도전 페이즈 중입니다' });
      return;
    }

    const hand = room.state.hands.get(client);
    if (!hand || cardIndex < 0 || cardIndex >= hand.length) {
      this.ctx.sendToClient(client, 'error', { message: '유효하지 않은 카드입니다' });
      return;
    }

    // 숫자 유효성 검사: 현재 숫자보다 높아야 함 (리셋 후 첫 턴은 1~3)
    const isReset = room.state.currentNumber === 0 || (room.state.currentNumber ?? 0) >= 10;
    if (isReset) {
      if (declaredNumber < 1 || declaredNumber > 3) {
        this.ctx.sendToClient(client, 'error', { message: '리셋 후 첫 숫자는 1~3 사이여야 합니다' });
        return;
      }
    } else {
      if (declaredNumber <= (room.state.currentNumber ?? 0)) {
        this.ctx.sendToClient(client, 'error', { message: '현재 숫자보다 높은 숫자를 선언해야 합니다' });
        return;
      }
    }

    // 카드를 손패에서 제거 (아직 더미에 추가 안 함 - 도전 페이즈 후 처리)
    const [playedCard] = hand.splice(cardIndex, 1);
    room.state.hands.set(client, hand);

    // 이 카드를 내면 손패가 비는지 확인 (트로피 대상 여부)
    const handEmptyPlayerId = hand.length === 0 ? playerId : undefined;

    // 다음 플레이어 계산
    const orderIndex = room.state.playerOrder.indexOf(client);
    const nextIndex = (orderIndex + 1) % room.state.playerOrder.length;
    const nextClient = room.state.playerOrder[nextIndex];
    const nextPlayerId = room.playerIds.get(nextClient) ?? '';

    const nickname = room.nicknames.get(client) ?? playerId;

    console.log(
      `[Spice] '${nickname}' played: declared=${declaredSuit} ${declaredNumber}, actual=${playedCard.type} ${playedCard.value}. Challenge phase starts.${handEmptyPlayerId ? ' [HAND EMPTY - trophy pending]' : ''}`,
    );

    // 5초 후 도전 없으면 자동 진행
    const challengeTimer = setTimeout(() => {
      this.resolveChallengeExpired(roomName);
    }, 5000);

    // 도전 페이즈 상태 저장
    room.state.turnStartedAt = null; // 도전 페이즈 중 턴 타이머 일시 중단
    room.state.challengePhase = {
      playerId,
      playedCard,
      declaredSuit,
      declaredNumber,
      nextPlayerId,
      timer: challengeTimer,
      startedAt: Date.now(),
      handEmptyPlayerId,
    };

    // 전체에게 도전 페이즈 브로드캐스트
    // 실제 낸 카드는 서버에서만 알고 있음 (뒷면 처리)
    this.ctx.broadcastToRoom(roomName, 'challengePhase', {
      roomName,
      playerId,
      nickname,
      declaredSuit,
      declaredNumber,
      playerHands: this.ctx.getPlayerHands(room),
      deck: room.state.deck,
    });

    // 본인에게 업데이트된 손패 전송
    this.ctx.sendToClient(client, 'myHandUpdate', {
      roomName,
      myHand: hand,
    });
  }

  // ── 도전 페이즈 만료 (5초 후 도전 없음) ───────────────────

  private resolveChallengeExpired(roomName: string): void {
    const room = this.ctx.rooms.get(roomName);
    if (!room || !room.state.challengePhase) return;

    const { playedCard, declaredSuit, declaredNumber, nextPlayerId, handEmptyPlayerId } =
      room.state.challengePhase;

    // 더미에 카드 추가
    if (!room.state.tableStack) room.state.tableStack = [];
    room.state.tableStack.push(playedCard);

    // 트로피 지급: 도전 없이 통과 → 손패가 비었으면 트로피 획득
    let trophyEvent: { playerId: string; nickname: string; trophyCount: number } | null = null;
    if (handEmptyPlayerId) {
      if (!room.state.trophies) room.state.trophies = new Map();
      const current = room.state.trophies.get(handEmptyPlayerId) ?? 0;
      const newCount = Math.min(current + 1, 2);
      room.state.trophies.set(handEmptyPlayerId, newCount);
      const nickname = this.ctx.getNicknameByPlayerId(room, handEmptyPlayerId);
      trophyEvent = { playerId: handEmptyPlayerId, nickname, trophyCount: newCount };

      // 게임이 계속되는 경우에만 손패 6장 지급 (게임 종료 시 채우면 결과창에서 -점 불이익)
      const totalTrophiesExp = Object.values(Object.fromEntries(room.state.trophies)).reduce((s, n) => s + n, 0);
      const gameWillEndExp = newCount >= 2 || totalTrophiesExp >= 3;
      if (!gameWillEndExp) {
        const emptyClient = this.ctx.findClientByPlayerId(room, handEmptyPlayerId);
        if (emptyClient) {
          const newHand: import('../../game.types').Card[] = [];
          for (let i = 0; i < 6; i++) {
            if (room.state.deck.length > 0) newHand.push(room.state.deck.pop()!);
          }
          room.state.hands.set(emptyClient, newHand);
          this.ctx.sendToClient(emptyClient, 'myHandUpdate', { roomName, myHand: newHand });
        }
      }

      console.log(
        `[Spice] '${nickname}' emptied hand! Trophy awarded (${newCount}/3). New hand dealt.`,
      );
    }

    // 턴 상태 업데이트
    room.state.currentSuit = declaredSuit;
    room.state.currentNumber = declaredNumber;
    room.state.currentTurnPlayerId = nextPlayerId;
    room.state.turnStartedAt = Date.now();
    room.state.challengePhase = null;

    const trophiesObj = room.state.trophies ? Object.fromEntries(room.state.trophies) : {};

    console.log(
      `[Spice] Challenge expired in '${roomName}'. Next turn: ${nextPlayerId}`,
    );

    const wonCardsMapExp = room.state.wonCards ?? new Map();
    const wonCardCountsExp: Record<string, number> = {};
    for (const [pid, cards] of wonCardsMapExp.entries()) {
      wonCardCountsExp[pid] = cards.length;
    }

    this.ctx.broadcastToRoom(roomName, 'challengeExpired', {
      roomName,
      currentTurnPlayerId: nextPlayerId,
      currentSuit: declaredSuit,
      currentNumber: declaredNumber,
      tableStackSize: room.state.tableStack.length,
      playerHands: this.ctx.getPlayerHands(room),
      deck: room.state.deck,
      trophyAwarded: trophyEvent ?? undefined,
      trophies: trophiesObj,
      wonCardCounts: wonCardCountsExp,
    });

    // 트로피 종료: 1초 후 / 덱 소진 종료: 3초 후
    if (trophyEvent) {
      setTimeout(() => {
        const trophiesNow = room.state.trophies ? Object.fromEntries(room.state.trophies) : {};
        if (this.checkTrophyGameOver(roomName, trophiesNow)) return;
        this.checkDeckEmpty(roomName);
      }, 1000);
    } else {
      setTimeout(() => {
        this.checkDeckEmpty(roomName);
      }, 3000);
    }
  }

  // ── pass ──────────────────────────────────────────────────

  handlePass(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    // 내 턴인지 확인
    if (room.state.currentTurnPlayerId !== playerId) {
      this.ctx.sendToClient(client, 'error', { message: '지금은 당신의 차례가 아닙니다' });
      return;
    }

    const nickname = room.nicknames.get(client) ?? playerId;

    // 패스 시 덱에서 카드 1장 드로우
    const hand = room.state.hands.get(client) ?? [];
    if (room.state.deck.length > 0) {
      const drawnCard = room.state.deck.pop()!;
      hand.push(drawnCard);
      room.state.hands.set(client, hand);
    }

    // 다음 플레이어로 턴 넘기기
    const orderIndex = room.state.playerOrder.indexOf(client);
    const nextIndex = (orderIndex + 1) % room.state.playerOrder.length;
    const nextClient = room.state.playerOrder[nextIndex];
    const nextPlayerId = room.playerIds.get(nextClient) ?? '';
    room.state.currentTurnPlayerId = nextPlayerId;
    room.state.turnStartedAt = Date.now();

    console.log(
      `[Spice] '${nickname}' passed. Drew 1 card. Next: ${nextPlayerId}`,
    );

    // 덱 소진 체크
    if (this.checkDeckEmpty(roomName)) return;

    this.ctx.broadcastToRoom(roomName, 'cardPassed', {
      roomName,
      playerId,
      nickname,
      playerHands: this.ctx.getPlayerHands(room),
      currentTurnPlayerId: nextPlayerId,
      currentSuit: room.state.currentSuit,
      currentNumber: room.state.currentNumber,
      tableStackSize: room.state.tableStack?.length ?? 0,
      deck: room.state.deck,
    });

    // 본인에게 업데이트된 손패 전송
    this.ctx.sendToClient(client, 'myHandUpdate', {
      roomName,
      myHand: hand,
    });
  }

  // ── challenge ─────────────────────────────────────────────

  handleChallenge(
    data: { roomName: string; challengeType: 'number' | 'suit' },
    client: WebSocket,
  ): void {
    const { roomName, challengeType } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }

    if (!room.state.challengePhase) {
      this.ctx.sendToClient(client, 'error', { message: '도전 페이즈가 아닙니다' });
      return;
    }

    const challengerId = room.playerIds.get(client);
    if (!challengerId) return;

    // 카드를 낸 본인은 도전 불가
    if (challengerId === room.state.challengePhase.playerId) {
      this.ctx.sendToClient(client, 'error', { message: '자신이 낸 카드에는 도전할 수 없습니다' });
      return;
    }

    // 타이머 취소
    clearTimeout(room.state.challengePhase.timer);

    const { playerId: targetPlayerId, playedCard, declaredSuit, declaredNumber, nextPlayerId, handEmptyPlayerId } =
      room.state.challengePhase;
    room.state.challengePhase = null;

    const challengerNickname = room.nicknames.get(client) ?? challengerId;
    const targetClient = this.ctx.findClientByPlayerId(room, targetPlayerId);
    const targetNickname = this.ctx.getNicknameByPlayerId(room, targetPlayerId);

    // 도전 판정
    // 숫자 와일드(wild-number): 숫자는 항상 참, 향신료는 항상 거짓(wild-number는 향신료가 없음)
    //   → 숫자 도전 항상 실패, 향신료 도전 항상 성공
    // 문양 와일드(wild-suit): 향신료는 항상 참, 숫자는 항상 거짓(wild-suit는 숫자가 없음)
    //   → 향신료 도전 항상 실패, 숫자 도전 항상 성공
    // 일반 카드: 선언값과 실제값 비교
    let challengeSuccess: boolean;
    if (challengeType === 'number') {
      if (playedCard.type === 'wild-number') {
        // 숫자 와일드 → 숫자는 항상 참 → 숫자 도전 항상 실패
        challengeSuccess = false;
      } else if (playedCard.type === 'wild-suit') {
        // 문양 와일드 → 숫자가 없음 → 숫자 도전 항상 성공
        challengeSuccess = true;
      } else {
        challengeSuccess = playedCard.value !== declaredNumber;
      }
    } else {
      // suit 도전
      if (playedCard.type === 'wild-suit') {
        // 문양 와일드 → 향신료는 항상 참 → 향신료 도전 항상 실패
        challengeSuccess = false;
      } else if (playedCard.type === 'wild-number') {
        // 숫자 와일드 → 향신료가 없음 → 향신료 도전 항상 성공
        challengeSuccess = true;
      } else {
        challengeSuccess = playedCard.type !== declaredSuit;
      }
    }

    // 더미를 쌓기 (실제 카드 포함)
    if (!room.state.tableStack) room.state.tableStack = [];
    room.state.tableStack.push(playedCard);
    const tableStackCards = [...room.state.tableStack];

    // 결과 처리
    if (challengeSuccess) {
      // 도전 성공: 더미는 획득카드(wonCards)에만 기록 + 카드를 낸 사람은 덱에서 2장 드로우(패널티)
      if (targetClient) {
        const targetHand = room.state.hands.get(targetClient) ?? [];
        for (let i = 0; i < 2; i++) {
          if (room.state.deck.length > 0) targetHand.push(room.state.deck.pop()!);
        }
        room.state.hands.set(targetClient, targetHand);
        this.ctx.sendToClient(targetClient, 'myHandUpdate', { roomName, myHand: targetHand });
      }
    } else {
      // 도전 실패: 도전자가 덱에서 2장 드로우(패널티) + 더미는 획득카드(wonCards)에만 기록
      const challengerHand = room.state.hands.get(client) ?? [];
      for (let i = 0; i < 2; i++) {
        if (room.state.deck.length > 0) challengerHand.push(room.state.deck.pop()!);
      }
      room.state.hands.set(client, challengerHand);
      this.ctx.sendToClient(client, 'myHandUpdate', { roomName, myHand: challengerHand });
    }

    // wonCards 기록: 더미를 가져간 플레이어에게 획득 카드 누적
    if (!room.state.wonCards) room.state.wonCards = new Map();
    const winnerId_won = challengeSuccess ? challengerId : targetPlayerId;
    const prevWon = room.state.wonCards.get(winnerId_won) ?? [];
    room.state.wonCards.set(winnerId_won, [...prevWon, ...tableStackCards]);

    // 더미 초기화 (획득했으므로)
    room.state.tableStack = [];
    // 턴 상태 업데이트 - 도전 후 선언 리셋
    room.state.currentSuit = null;
    room.state.currentNumber = 0;

    // 도전 후 패배자부터 턴 시작
    // 도전 성공: 카드 낸 사람(targetPlayerId)이 패배자
    // 도전 실패: 도전자(challengerId)가 패배자
    const winnerId = challengeSuccess ? challengerId : targetPlayerId;
    const loserId = challengeSuccess ? targetPlayerId : challengerId;
    room.state.currentTurnPlayerId = loserId;
    room.state.turnStartedAt = Date.now();

    // 트로피 지급: 도전 실패(카드 낸 사람이 진실) + 손패가 비었던 경우
    // 도전이 왔지만 상대가 진실이었음 → 카드 낸 사람의 손패가 이미 비어있으면 트로피 지급
    let trophyEvent: { playerId: string; nickname: string; trophyCount: number } | null = null;
    if (!challengeSuccess && handEmptyPlayerId) {
      // 도전 실패 = 카드 낸 사람(targetPlayerId)이 승자. 하지만 더미를 가져갔으므로 손패가 다시 채워짐.
      // 트로피는 "카드를 냈을 때 손패가 비었고, 도전도 이겨낸" 경우에 지급
      if (!room.state.trophies) room.state.trophies = new Map();
      const current = room.state.trophies.get(handEmptyPlayerId) ?? 0;
      const newCount = Math.min(current + 1, 2);
      room.state.trophies.set(handEmptyPlayerId, newCount);
      const trophyNickname = this.ctx.getNicknameByPlayerId(room, handEmptyPlayerId);
      trophyEvent = { playerId: handEmptyPlayerId, nickname: trophyNickname, trophyCount: newCount };

      // 게임이 계속되는 경우에만 손패 6장 지급 (게임 종료 시 채우면 결과창에서 -점 불이익)
      const totalTrophiesChal = Object.values(Object.fromEntries(room.state.trophies)).reduce((s, n) => s + n, 0);
      const gameWillEndChal = newCount >= 2 || totalTrophiesChal >= 3;
      if (!gameWillEndChal && targetClient) {
        const newHand: import('../../game.types').Card[] = [];
        for (let i = 0; i < 6; i++) {
          if (room.state.deck.length > 0) newHand.push(room.state.deck.pop()!);
        }
        room.state.hands.set(targetClient, newHand);
        this.ctx.sendToClient(targetClient, 'myHandUpdate', { roomName, myHand: newHand });
      }

      console.log(
        `[Spice] '${trophyNickname}' survived challenge with empty hand! Trophy awarded (${newCount}/3).`,
      );
    }

    console.log(
      `[Spice] Challenge by '${challengerNickname}' (${challengeType}) against '${targetNickname}': ${challengeSuccess ? 'SUCCESS' : 'FAIL'}. Actual: ${playedCard.type} ${playedCard.value}, Declared: ${declaredSuit} ${declaredNumber}. Next turn: ${loserId}`,
    );

    const trophiesObj = room.state.trophies ? Object.fromEntries(room.state.trophies) : {};

    // 플레이어별 획득 카드 수 집계
    const wonCardsMap = room.state.wonCards ?? new Map();
    const wonCardCounts: Record<string, number> = {};
    for (const [pid, cards] of wonCardsMap.entries()) {
      wonCardCounts[pid] = cards.length;
    }

    this.ctx.broadcastToRoom(roomName, 'challengeResult', {
      roomName,
      challengerId,
      challengerNickname,
      targetPlayerId,
      targetNickname,
      challengeType,
      challengeSuccess,
      winnerId,
      loserId,
      playedCard,
      declaredSuit,
      declaredNumber,
      playerHands: this.ctx.getPlayerHands(room),
      currentTurnPlayerId: loserId,
      currentSuit: null,
      currentNumber: 0,
      tableStackSize: 0,
      deck: room.state.deck,
      trophyAwarded: trophyEvent ?? undefined,
      trophies: trophiesObj,
      wonCardCounts,
    });

    // 트로피 종료: 1초 후 / 덱 소진 종료: 3초 후
    if (trophyEvent) {
      setTimeout(() => {
        const trophiesNow = room.state.trophies ? Object.fromEntries(room.state.trophies) : {};
        if (this.checkTrophyGameOver(roomName, trophiesNow)) return;
        this.checkDeckEmpty(roomName);
      }, 1000);
    } else {
      setTimeout(() => {
        this.checkDeckEmpty(roomName);
      }, 3000);
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

  // ── 향신료 게임 종료 판정 ──────────────────────────────────

  /**
   * 트로피 조건으로 게임이 끝났는지 체크한다.
   * - 한 플레이어가 트로피 2개 이상 보유
   * - 트로피 3개가 모두 분배됨 (합계 = 3)
   * @returns true이면 종료 처리를 했으므로 caller는 이후 로직 중단
   */
  private checkTrophyGameOver(
    roomName: string,
    trophiesObj: Record<string, number>,
  ): boolean {
    const entries = Object.entries(trophiesObj);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    const maxOwned = entries.reduce((m, [, n]) => Math.max(m, n), 0);

    const isOver = maxOwned >= 2 || total >= 3;
    if (isOver) {
      this.finishSpiceGame(roomName, trophiesObj, 'trophy');
    }
    return isOver;
  }

  /**
   * 덱이 소진됐을 때 게임 종료 조건을 체크한다.
   * @returns true이면 종료 처리를 했으므로 caller는 이후 로직 중단
   */
  private checkDeckEmpty(roomName: string): boolean {
    const room = this.ctx.rooms.get(roomName);
    if (!room || room.state.deck.length > 0) return false;
    const trophiesObj = room.state.trophies ? Object.fromEntries(room.state.trophies) : {};
    this.finishSpiceGame(roomName, trophiesObj, 'deck');
    return true;
  }

  /**
   * Spice 게임 종료 처리 (트로피 조건 / 덱 소진 공통)
   *
   * 점수 계산:
   *   +1점  따낸 카드 1장당
   *   +10점 트로피 1개당
   *   -1점  손에 남은 카드 1장당
   */
  private finishSpiceGame(
    roomName: string,
    trophiesObj: Record<string, number>,
    reason: 'trophy' | 'deck',
  ): void {
    const room = this.ctx.rooms.get(roomName);
    if (!room) return;

    const wonCardsMap = room.state.wonCards ?? new Map();

    const playerResults = room.state.playerOrder.map((c) => {
      const pid = room.playerIds.get(c) ?? '';
      const hand = room.state.hands.get(c) ?? [];
      const won = wonCardsMap.get(pid) ?? [];
      const trophyCount = trophiesObj[pid] ?? 0;

      const score =
        won.length          // +1 per won card
        + trophyCount * 10  // +10 per trophy
        - hand.length;      // -1 per card still in hand

      return {
        playerId: pid,
        nickname: room.nicknames.get(c) ?? '',
        hand,
        chips: room.state.previousChips.get(pid) ?? [],
        trophyCount,
        wonCardCount: won.length,
        score,
      };
    });

    const maxScore = Math.max(...playerResults.map((r) => r.score));
    const winners = playerResults.filter((r) => r.score === maxScore);

    room.gameStarted = false;
    room.gameFinished = true;
    room.gameOver = true;
    room.gameOverResult = 'victory';
    room.state.playerReady.clear();

    console.log(
      `[Spice] Game over in '${roomName}' (reason: ${reason}). ` +
      playerResults.map((r) => `${r.nickname}: ${r.score}pts (won:${r.wonCardCount} trophy:${r.trophyCount} hand:-${r.hand.length})`).join(' | ') +
      ` → Winner(s): ${winners.map((w) => w.nickname).join(', ')}`,
    );

    this.ctx.broadcastToRoom(roomName, 'spiceGameOver', {
      roomName,
      reason,
      trophies: trophiesObj,
      playerResults,
      winnerIds: winners.map((w) => w.playerId),
      winnerNicknames: winners.map((w) => w.nickname),
      maxScore,
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
