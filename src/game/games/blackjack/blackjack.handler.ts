import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { BlackjackEngine } from '../../engines/blackjack.engine';
import { BjHand, Card, Room } from '../../game.types';

const ACTION_TIME_MS = 30000; // 액션 페이즈 30초

@Injectable()
export class BlackjackHandler {
  constructor(
    private readonly ctx: GameContext,
    private readonly engine: BlackjackEngine,
  ) {}

  // ── startGame ─────────────────────────────────────────────

  handleStartGame(
    data: { roomName: string; initialChips?: number; totalRounds?: number },
    client: WebSocket,
  ): void {
    const { roomName, initialChips = 100, totalRounds = 5 } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    if (room.playerIds.get(client) !== room.hostPlayerId) {
      this.ctx.sendToClient(client, 'error', { message: '방장만 게임을 시작할 수 있습니다' });
      return;
    }

    if (room.clients.size < 2) {
      this.ctx.sendToClient(client, 'error', {
        message: '게임을 시작하려면 최소 2명이 필요합니다',
      });
      return;
    }

    // 설정 검증
    const chips = Math.min(Math.max(initialChips, 10), 500);
    const rounds = Math.min(Math.max(totalRounds, 1), 10);

    room.bjInitialChips = chips;
    room.bjTotalRounds = rounds;
    room.gameStarted = true;
    room.gameFinished = false;

    // 칩 초기화
    const bjChips = new Map<string, number>();
    for (const [, playerId] of room.playerIds) {
      bjChips.set(playerId, chips);
    }
    room.state.bjChips = bjChips;
    room.state.bjCurrentRound = 0;

    this.startBettingPhase(room);
  }

  // ── 베팅 페이즈 ──────────────────────────────────────────

  private startBettingPhase(room: Room): void {
    room.state.bjPhase = 'betting';
    room.state.bjBets = new Map();
    room.state.bjBettingDone = new Set();
    room.state.bjPlayerHands = new Map();
    room.state.bjDealerHand = [];
    room.state.bjDealerHoleCard = null;
    room.state.bjActionDone = new Set();
    room.state.bjNextRoundReady = new Set();
    room.state.bjCurrentRound = (room.state.bjCurrentRound ?? 0) + 1;

    const players = this.ctx.getPlayersWithOrder(room);
    const chips = room.state.bjChips ?? new Map();

    this.ctx.broadcastToRoom(room.name, 'bjBettingStarted', {
      roomName: room.name,
      round: room.state.bjCurrentRound,
      totalRounds: room.bjTotalRounds,
      initialChips: room.bjInitialChips,
      players: players.map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        order: p.order,
        chips: chips.get(p.playerId) ?? 0,
      })),
    });

    // 봇 자동 베팅
    this.autoBotBet(room);
  }

  handlePlaceBet(data: { roomName: string; amount: number }, client: WebSocket): void {
    const { roomName, amount } = data;
    const room = this.ctx.rooms.get(roomName);
    const playerId = room?.playerIds.get(client);

    if (!room || !playerId) return;
    if (room.state.bjPhase !== 'betting') {
      this.ctx.sendToClient(client, 'error', { message: '베팅 단계가 아닙니다' });
      return;
    }
    if (room.state.bjBettingDone?.has(playerId)) {
      this.ctx.sendToClient(client, 'error', { message: '이미 베팅하셨습니다' });
      return;
    }

    const maxBet = Math.floor((room.bjInitialChips ?? 100) / 2);

    if (amount < 1 || amount > maxBet) {
      this.ctx.sendToClient(client, 'error', {
        message: `베팅액은 1 이상 ${maxBet} 이하여야 합니다`,
      });
      return;
    }

    room.state.bjBets!.set(playerId, amount);
    room.state.bjBettingDone!.add(playerId);

    this.ctx.broadcastToRoom(room.name, 'bjBetPlaced', {
      roomName: room.name,
      playerId,
      bettingDoneCount: room.state.bjBettingDone!.size,
      totalPlayers: room.clients.size,
    });

    if (room.state.bjBettingDone!.size === room.clients.size) {
      this.startActionPhase(room);
    }
  }

  // ── 액션 페이즈 ──────────────────────────────────────────

  private startActionPhase(room: Room): void {
    room.state.bjPhase = 'action';

    // 덱 생성 (매 라운드 리셔플)
    room.state.deck = this.engine.createDeck();

    // 초기 카드 배분: 플레이어 2장, 딜러 2장 (1장 공개 + 1장 홀카드)
    const bjPlayerHands = new Map<string, BjHand[]>();

    for (const [, playerId] of room.playerIds) {
      const bet = room.state.bjBets?.get(playerId) ?? 0;
      const card1 = room.state.deck.pop()!;
      const card2 = room.state.deck.pop()!;
      const hand: BjHand = {
        cards: [card1, card2],
        bet,
        status: this.isBlackjack([card1, card2]) ? 'blackjack' : 'active',
      };
      bjPlayerHands.set(playerId, [hand]);

      // 블랙잭이면 즉시 완료 처리
      if (hand.status === 'blackjack') {
        room.state.bjActionDone!.add(playerId);
      }
    }
    room.state.bjPlayerHands = bjPlayerHands;

    // 딜러 초기 카드
    const dealerCard = room.state.deck.pop()!;
    const dealerHole = room.state.deck.pop()!;
    room.state.bjDealerHand = [dealerCard];
    room.state.bjDealerHoleCard = dealerHole;

    // 타이머 시작
    this.startActionTimer(room);

    // 각 플레이어에게 개인 손패 전송 (봇은 제외)
    for (const [playerClient, playerId] of room.playerIds) {
      if (room.bjBotSockets?.has(playerClient)) continue;
      const myHands = bjPlayerHands.get(playerId) ?? [];
      this.ctx.sendToClient(playerClient, 'bjActionPhase', {
        roomName: room.name,
        myHands,
        dealerVisibleCard: dealerCard,
        actionTimeLimit: ACTION_TIME_MS / 1000,
        // 다른 플레이어들의 카드 수 (첫 카드 공개 없음, 카드 수만)
        playerHandsInfo: this.buildPlayerHandsInfo(room),
      });
    }

    // 봇 자동 액션
    this.autoBotAction(room);
  }

  handleAction(
    data: {
      roomName: string;
      action: 'hit' | 'stand' | 'double' | 'split';
      handIndex?: number;
    },
    client: WebSocket,
  ): void {
    const { roomName, action, handIndex = 0 } = data;
    const room = this.ctx.rooms.get(roomName);
    const playerId = room?.playerIds.get(client);

    if (!room || !playerId) return;
    if (room.state.bjPhase !== 'action') {
      this.ctx.sendToClient(client, 'error', { message: '액션 단계가 아닙니다' });
      return;
    }
    if (room.state.bjActionDone?.has(playerId)) {
      this.ctx.sendToClient(client, 'error', { message: '이미 액션을 완료하셨습니다' });
      return;
    }

    const hands = room.state.bjPlayerHands?.get(playerId);
    if (!hands || handIndex >= hands.length) {
      this.ctx.sendToClient(client, 'error', { message: '유효하지 않은 핸드입니다' });
      return;
    }

    const hand = hands[handIndex];
    if (hand.status !== 'active') {
      this.ctx.sendToClient(client, 'error', { message: '이미 완료된 핸드입니다' });
      return;
    }

    switch (action) {
      case 'hit':
        this.doHit(room, client, playerId, hands, handIndex);
        break;
      case 'stand':
        this.doStand(room, client, playerId, hands, handIndex);
        break;
      case 'double':
        this.doDouble(room, client, playerId, hands, handIndex);
        break;
      case 'split':
        this.doSplit(room, client, playerId, hands, handIndex);
        break;
    }
  }

  private doHit(
    room: Room,
    client: WebSocket,
    playerId: string,
    hands: BjHand[],
    handIndex: number,
  ): void {
    if (room.state.deck.length === 0) {
      this.handleDeckEmpty(room);
      return;
    }

    const hand = hands[handIndex];
    const card = room.state.deck.pop()!;
    hand.cards.push(card);

    const value = this.calculateHandValue(hand.cards);
    if (value > 21) {
      hand.status = 'bust';
    }

    // 내 손패 개인 전송
    this.ctx.sendToClient(client, 'myBjHandUpdate', {
      myHands: hands,
      currentHandIndex: this.getCurrentHandIndex(hands),
    });

    // 전체 브로드캐스트 (카드 수 + 상태)
    this.ctx.broadcastToRoom(room.name, 'bjActionUpdate', {
      roomName: room.name,
      playerId,
      action: 'hit',
      handIndex,
      handValue: value,
      status: hand.status,
      playerHandsInfo: this.buildPlayerHandsInfo(room),
    }, client);

    if (hand.status === 'bust') {
      this.checkHandCompletion(room, client, playerId, hands, handIndex);
    }
  }

  private doStand(
    room: Room,
    client: WebSocket,
    playerId: string,
    hands: BjHand[],
    handIndex: number,
  ): void {
    hands[handIndex].status = 'stand';

    this.ctx.sendToClient(client, 'myBjHandUpdate', {
      myHands: hands,
      currentHandIndex: this.getCurrentHandIndex(hands),
    });

    this.ctx.broadcastToRoom(room.name, 'bjActionUpdate', {
      roomName: room.name,
      playerId,
      action: 'stand',
      handIndex,
      playerHandsInfo: this.buildPlayerHandsInfo(room),
    }, client);

    this.checkHandCompletion(room, client, playerId, hands, handIndex);
  }

  private doDouble(
    room: Room,
    client: WebSocket,
    playerId: string,
    hands: BjHand[],
    handIndex: number,
  ): void {
    const hand = hands[handIndex];
    if (hand.cards.length !== 2) {
      this.ctx.sendToClient(client, 'error', { message: '더블다운은 첫 두 장에서만 가능합니다' });
      return;
    }

    if (room.state.deck.length === 0) {
      this.handleDeckEmpty(room);
      return;
    }

    hand.bet *= 2;
    const card = room.state.deck.pop()!;
    hand.cards.push(card);

    const value = this.calculateHandValue(hand.cards);
    hand.status = value > 21 ? 'bust' : 'doubled';

    this.ctx.sendToClient(client, 'myBjHandUpdate', {
      myHands: hands,
      currentHandIndex: this.getCurrentHandIndex(hands),
    });

    this.ctx.broadcastToRoom(room.name, 'bjActionUpdate', {
      roomName: room.name,
      playerId,
      action: 'double',
      handIndex,
      handValue: value,
      status: hand.status,
      playerHandsInfo: this.buildPlayerHandsInfo(room),
    }, client);

    this.checkHandCompletion(room, client, playerId, hands, handIndex);
  }

  private doSplit(
    room: Room,
    client: WebSocket,
    playerId: string,
    hands: BjHand[],
    handIndex: number,
  ): void {
    const hand = hands[handIndex];
    if (hand.cards.length !== 2) {
      this.ctx.sendToClient(client, 'error', { message: '스플릿은 첫 두 장에서만 가능합니다' });
      return;
    }
    if (this.getBjValue(hand.cards[0]) !== this.getBjValue(hand.cards[1])) {
      this.ctx.sendToClient(client, 'error', { message: '같은 값의 카드만 스플릿 가능합니다' });
      return;
    }
    if (hands.length >= 2) {
      this.ctx.sendToClient(client, 'error', { message: '한 번만 스플릿 가능합니다' });
      return;
    }
    const myChips = room.state.bjChips?.get(playerId) ?? 0;
    if (myChips < hand.bet) {
      this.ctx.sendToClient(client, 'error', { message: '스플릿을 위한 칩이 부족합니다' });
      return;
    }
    if (room.state.deck.length < 2) {
      this.handleDeckEmpty(room);
      return;
    }

    // 핸드 분리
    const [card1, card2] = hand.cards;
    const newCard1 = room.state.deck.pop()!;
    const newCard2 = room.state.deck.pop()!;

    hands[handIndex] = { cards: [card1, newCard1], bet: hand.bet, status: 'active' };
    hands.push({ cards: [card2, newCard2], bet: hand.bet, status: 'active' });

    this.ctx.sendToClient(client, 'myBjHandUpdate', {
      myHands: hands,
      currentHandIndex: 0,
    });

    this.ctx.broadcastToRoom(room.name, 'bjActionUpdate', {
      roomName: room.name,
      playerId,
      action: 'split',
      handIndex,
      playerHandsInfo: this.buildPlayerHandsInfo(room),
    }, client);
  }

  private checkHandCompletion(
    room: Room,
    client: WebSocket,
    playerId: string,
    hands: BjHand[],
    handIndex: number,
  ): void {
    const nextActiveIndex = hands.findIndex((h, i) => i > handIndex && h.status === 'active');

    if (nextActiveIndex !== -1) {
      // 스플릿 다음 핸드로 전환
      this.ctx.sendToClient(client, 'myBjHandUpdate', {
        myHands: hands,
        currentHandIndex: nextActiveIndex,
      });
      return;
    }

    // 모든 핸드 완료
    room.state.bjActionDone!.add(playerId);

    this.ctx.broadcastToRoom(room.name, 'bjPlayerDone', {
      roomName: room.name,
      playerId,
      doneCount: room.state.bjActionDone!.size,
      totalPlayers: room.clients.size,
    });

    if (room.state.bjActionDone!.size === room.clients.size) {
      this.clearActionTimer(room);
      this.startDealerPhase(room);
    }
  }

  // ── 액션 타이머 ──────────────────────────────────────────

  private startActionTimer(room: Room): void {
    this.clearActionTimer(room);
    room.state.bjActionTimerStartedAt = Date.now();
    room.state.bjActionTimer = setTimeout(() => {
      // 미완료 플레이어 자동 stand 처리
      for (const [, playerId] of room.playerIds) {
        if (room.state.bjActionDone?.has(playerId)) continue;
        const hands = room.state.bjPlayerHands?.get(playerId);
        if (!hands) continue;
        for (const hand of hands) {
          if (hand.status === 'active') hand.status = 'stand';
        }
        room.state.bjActionDone!.add(playerId);
      }
      this.ctx.broadcastToRoom(room.name, 'bjActionTimeout', { roomName: room.name });
      this.startDealerPhase(room);
    }, ACTION_TIME_MS);
  }

  private clearActionTimer(room: Room): void {
    if (room.state.bjActionTimer) {
      clearTimeout(room.state.bjActionTimer);
      room.state.bjActionTimer = undefined;
      room.state.bjActionTimerStartedAt = null;
    }
  }

  // ── 딜러 페이즈 ──────────────────────────────────────────

  private startDealerPhase(room: Room): void {
    room.state.bjPhase = 'dealer';

    const holeCard = room.state.bjDealerHoleCard!;
    room.state.bjDealerHand!.push(holeCard);
    room.state.bjDealerHoleCard = null;

    // 딜러 히트 (17 이상까지)
    while (this.calculateHandValue(room.state.bjDealerHand!) < 17) {
      if (room.state.deck.length === 0) break;
      room.state.bjDealerHand!.push(room.state.deck.pop()!);
    }

    const finalHand = [...room.state.bjDealerHand!];
    const dealerValue = this.calculateHandValue(finalHand);
    const dealerBust = dealerValue > 21;
    const dealerBj = this.isBlackjack(finalHand);

    // 딜러 카드를 한 장씩 700ms 간격으로 전송
    let delay = 0;
    for (let i = 0; i < finalHand.length; i++) {
      const revealedSoFar = finalHand.slice(0, i + 1);
      const isLast = i === finalHand.length - 1;
      const currentValue = this.calculateHandValue(revealedSoFar);
      setTimeout(() => {
        this.ctx.broadcastToRoom(room.name, 'bjDealerPhase', {
          roomName: room.name,
          dealerHand: revealedSoFar,
          dealerValue: currentValue,
          dealerBust: isLast && dealerBust,
          dealerBlackjack: isLast && dealerBj,
          isFinal: isLast,
        });
        if (isLast) {
          setTimeout(() => {
            this.calculateResults(room, dealerValue, dealerBust, dealerBj);
          }, 800);
        }
      }, delay);
      delay += 700;
    }
  }

  // ── 결산 ──────────────────────────────────────────────

  private calculateResults(
    room: Room,
    dealerValue: number,
    dealerBust: boolean,
    dealerBj: boolean,
  ): void {
    room.state.bjPhase = 'result';

    const chips = room.state.bjChips!;
    const playerResults: Array<{
      playerId: string;
      nickname: string;
      hands: Array<{
        cards: Card[];
        value: number;
        result: 'win' | 'lose' | 'push';
        bet: number;
        payout: number;
        isBlackjack: boolean;
      }>;
      chipsAfter: number;
    }> = [];

    for (const [, playerId] of room.playerIds) {
      const nickname = this.ctx.getNicknameByPlayerId(room, playerId);
      const hands = room.state.bjPlayerHands?.get(playerId) ?? [];
      let chipDelta = 0;

      const handResults = hands.map((hand) => {
        const value = this.calculateHandValue(hand.cards);
        const isBj = hand.status === 'blackjack';
        let result: 'win' | 'lose' | 'push';
        let payout = 0;

        if (hand.status === 'bust') {
          result = 'lose';
          payout = 0;
          chipDelta -= hand.bet;
        } else if (dealerBj && isBj) {
          result = 'push';
          payout = hand.bet;
          // 베팅액 반환 (칩 변동 없음)
        } else if (dealerBj) {
          result = 'lose';
          payout = 0;
          chipDelta -= hand.bet;
        } else if (isBj) {
          result = 'win';
          payout = hand.bet + Math.floor(hand.bet * 1.5);
          chipDelta += Math.floor(hand.bet * 1.5);
        } else if (dealerBust) {
          result = 'win';
          payout = hand.bet * 2;
          chipDelta += hand.bet;
        } else if (value > dealerValue) {
          result = 'win';
          payout = hand.bet * 2;
          chipDelta += hand.bet;
        } else if (value < dealerValue) {
          result = 'lose';
          payout = 0;
          chipDelta -= hand.bet;
        } else {
          result = 'push';
          payout = hand.bet;
          // 베팅액 반환 (칩 변동 없음)
        }

        hand.result = result;
        hand.payout = payout;

        return { cards: hand.cards, value, result, bet: hand.bet, payout, isBlackjack: isBj };
      });

      const currentChips = chips.get(playerId) ?? 0;
      const chipsAfter = currentChips + chipDelta;
      chips.set(playerId, chipsAfter);

      playerResults.push({ playerId, nickname, hands: handResults, chipsAfter });
    }

    this.ctx.broadcastToRoom(room.name, 'bjRoundResult', {
      roomName: room.name,
      round: room.state.bjCurrentRound,
      totalRounds: room.bjTotalRounds,
      dealerHand: room.state.bjDealerHand,
      dealerValue,
      dealerBust,
      dealerBlackjack: dealerBj,
      playerResults,
      chips: Object.fromEntries(chips),
    });

    // 봇은 자동으로 다음 라운드 준비
    if (room.bjBotSockets) {
      for (const botWs of room.bjBotSockets) {
        const botId = room.playerIds.get(botWs);
        if (botId) room.state.bjNextRoundReady!.add(botId);
      }
    }
  }

  // ── 다음 라운드 / 게임 종료 ──────────────────────────────

  handleNextRound(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);
    const playerId = room?.playerIds.get(client);

    if (!room || !playerId) return;
    if (room.state.bjPhase !== 'result') {
      this.ctx.sendToClient(client, 'error', { message: '결과 확인 단계가 아닙니다' });
      return;
    }

    room.state.bjNextRoundReady!.add(playerId);

    this.ctx.broadcastToRoom(room.name, 'bjNextRoundReady', {
      roomName: room.name,
      readyCount: room.state.bjNextRoundReady!.size,
      totalPlayers: room.clients.size,
    });

    if (room.state.bjNextRoundReady!.size < room.clients.size) return;

    if ((room.state.bjCurrentRound ?? 0) >= (room.bjTotalRounds ?? 5)) {
      this.endGame(room);
      return;
    }

    this.startBettingPhase(room);
  }

  private endGame(room: Room): void {
    room.gameFinished = true;
    const chips = room.state.bjChips!;

    const ranking = this.ctx
      .getPlayersWithOrder(room)
      .map((p) => ({ playerId: p.playerId, nickname: p.nickname, chips: chips.get(p.playerId) ?? 0 }))
      .sort((a, b) => b.chips - a.chips)
      .map((p, i) => ({ ...p, rank: i + 1 }));

    this.ctx.broadcastToRoom(room.name, 'bjGameOver', {
      roomName: room.name,
      finalChips: Object.fromEntries(chips),
      ranking,
    });
  }

  private handleDeckEmpty(room: Room): void {
    // 덱이 바닥나면 남은 액션 플레이어 모두 stand 처리 후 딜러 페이즈 진행
    for (const [, playerId] of room.playerIds) {
      if (room.state.bjActionDone?.has(playerId)) continue;
      const hands = room.state.bjPlayerHands?.get(playerId);
      if (!hands) continue;
      for (const hand of hands) {
        if (hand.status === 'active') hand.status = 'stand';
      }
      room.state.bjActionDone!.add(playerId);
    }
    this.clearActionTimer(room);
    this.ctx.broadcastToRoom(room.name, 'bjDeckEmpty', { roomName: room.name });
    this.startDealerPhase(room);
  }

  // ── 재연결 상태 계산 ────────────────────────────────────

  buildBlackjackState(room: Room, playerId: string): Record<string, unknown> {
    if (room.gameType !== 'blackjack' || !room.gameStarted) return {};

    const state = room.state;
    const chips = state.bjChips ?? new Map<string, number>();
    const now = Date.now();
    const bjActionTimerTimeLeft =
      state.bjPhase === 'action' && state.bjActionTimerStartedAt != null
        ? Math.max(0, Math.round((ACTION_TIME_MS - (now - state.bjActionTimerStartedAt)) / 1000))
        : null;

    return {
      bjPhase: state.bjPhase ?? null,
      bjCurrentRound: state.bjCurrentRound ?? 0,
      bjTotalRounds: room.bjTotalRounds ?? 5,
      bjInitialChips: room.bjInitialChips ?? 100,
      bjMyHands: state.bjPlayerHands?.get(playerId) ?? [],
      bjChips: Object.fromEntries(chips),
      bjBets: Object.fromEntries(state.bjBets ?? new Map()),
      bjBettingDone: Array.from(state.bjBettingDone ?? new Set()),
      bjActionDone: Array.from(state.bjActionDone ?? new Set()),
      bjDealerVisibleCards: state.bjPhase === 'dealer' || state.bjPhase === 'result'
        ? state.bjDealerHand ?? []
        : state.bjDealerHand?.slice(0, 1) ?? [],
      bjPlayerHandsInfo: this.buildPlayerHandsInfo(room),
      bjActionTimerTimeLeft,
    };
  }

  // ── 유틸 ────────────────────────────────────────────────

  private calculateHandValue(cards: Card[]): number {
    let sum = 0;
    let aces = 0;
    for (const card of cards) {
      const v = this.getBjValue(card);
      sum += v;
      if (card.value === 1) aces++;
    }
    // A를 11로 계산하되 21 초과 시 1로 전환
    while (sum <= 11 && aces > 0) {
      sum += 10;
      aces--;
    }
    return sum;
  }

  private getBjValue(card: Card): number {
    if (card.value >= 10) return 10; // 10, J, Q, K → 10
    return card.value; // 1~9 그대로
  }

  private isBlackjack(cards: Card[]): boolean {
    if (cards.length !== 2) return false;
    return this.calculateHandValue(cards) === 21;
  }

  private getCurrentHandIndex(hands: BjHand[]): number {
    const idx = hands.findIndex((h) => h.status === 'active');
    return idx === -1 ? hands.length - 1 : idx;
  }

  // ── 봇 관련 ──────────────────────────────────────────────

  handleAddBot(data: { roomName: string }, client: WebSocket): void {
    const room = this.ctx.rooms.get(data.roomName);
    if (!room) return;
    if (room.playerIds.get(client) !== room.hostPlayerId) {
      this.ctx.sendToClient(client, 'error', { message: '방장만 봇을 추가할 수 있습니다' });
      return;
    }
    if (room.gameStarted) {
      this.ctx.sendToClient(client, 'error', { message: '게임 시작 전에만 봇을 추가할 수 있습니다' });
      return;
    }
    if (room.clients.size >= 5) {
      this.ctx.sendToClient(client, 'error', { message: '최대 5명입니다' });
      return;
    }

    // 봇 번호 결정
    const botNum = (room.bjBotSockets?.size ?? 0) + 1;
    const botId = `bot-${room.name}-${botNum}`;
    const botNickname = `봇 ${botNum}`;

    // 가짜 WS 스텁 생성 (모든 메시지 무시)
    const botWs = { readyState: 1, send: () => {} } as unknown as WebSocket;

    if (!room.bjBotSockets) room.bjBotSockets = new Set();
    room.bjBotSockets.add(botWs);
    room.clients.add(botWs);
    room.playerIds.set(botWs, botId);
    room.nicknames.set(botWs, botNickname);

    this.ctx.broadcastToRoom(room.name, 'userJoined', {
      roomName: room.name,
      playerId: botId,
      nickname: botNickname,
      memberCount: room.clients.size,
      players: this.ctx.getPlayersWithOrder(room),
    });
  }

  private autoBotBet(room: Room): void {
    const botSockets = room.bjBotSockets;
    if (!botSockets || botSockets.size === 0) return;

    const maxBet = Math.floor((room.bjInitialChips ?? 100) / 2);

    for (const [botWs, botId] of room.playerIds) {
      if (!botSockets.has(botWs)) continue;

      // 100~800ms 랜덤 딜레이로 자동 베팅
      const delay = 100 + Math.floor(Math.random() * 700);
      setTimeout(() => {
        if (room.state.bjPhase !== 'betting') return;
        if (room.state.bjBettingDone?.has(botId)) return;

        const myChips = room.state.bjChips?.get(botId) ?? 0;
        const amount = Math.min(maxBet, myChips, Math.max(1, Math.floor(maxBet * (0.4 + Math.random() * 0.6))));

        room.state.bjBets!.set(botId, amount);
        room.state.bjBettingDone!.add(botId);

        this.ctx.broadcastToRoom(room.name, 'bjBetPlaced', {
          roomName: room.name,
          playerId: botId,
          bettingDoneCount: room.state.bjBettingDone!.size,
          totalPlayers: room.clients.size,
        });

        if (room.state.bjBettingDone!.size === room.clients.size) {
          this.startActionPhase(room);
        }
      }, delay);
    }
  }

  private autoBotAction(room: Room): void {
    const botSockets = room.bjBotSockets;
    if (!botSockets || botSockets.size === 0) return;

    for (const [botWs, botId] of room.playerIds) {
      if (!botSockets.has(botWs)) continue;
      // 각 봇을 500~1200ms 오프셋으로 순차 처리
      const startDelay = 500 + Math.floor(Math.random() * 700);
      this.processBotTurn(room, botId, startDelay);
    }
  }

  private processBotTurn(room: Room, botId: string, delay: number): void {
    setTimeout(() => {
      if (room.state.bjPhase !== 'action') return;
      if (room.state.bjActionDone?.has(botId)) return;

      const hands = room.state.bjPlayerHands?.get(botId);
      if (!hands) return;

      const activeIdx = hands.findIndex((h) => h.status === 'active');
      if (activeIdx === -1) {
        // 모든 핸드 완료
        room.state.bjActionDone!.add(botId);
        this.ctx.broadcastToRoom(room.name, 'bjPlayerDone', {
          roomName: room.name,
          playerId: botId,
          doneCount: room.state.bjActionDone!.size,
          totalPlayers: room.clients.size,
        });
        if (room.state.bjActionDone!.size === room.clients.size) {
          this.clearActionTimer(room);
          this.startDealerPhase(room);
        }
        return;
      }

      const hand = hands[activeIdx];
      const value = this.calculateHandValue(hand.cards);

      if (value >= 17) {
        hand.status = 'stand';
      } else {
        const card = room.state.deck.pop();
        if (!card) {
          hand.status = 'stand';
        } else {
          hand.cards.push(card);
          if (this.calculateHandValue(hand.cards) > 21) {
            hand.status = 'bust';
          }
        }
      }

      this.ctx.broadcastToRoom(room.name, 'bjActionUpdate', {
        roomName: room.name,
        playerId: botId,
        playerHandsInfo: this.buildPlayerHandsInfo(room),
      });

      // 이 봇의 다음 액션 (active 핸드가 남아있으면 계속)
      this.processBotTurn(room, botId, 500 + Math.floor(Math.random() * 500));
    }, delay);
  }

  private buildPlayerHandsInfo(room: Room): Array<{
    playerId: string;
    hands: Array<{ cardCount: number; status: string; bet: number; value: number }>;
  }> {
    return Array.from(room.playerIds.values()).map((pid) => ({
      playerId: pid,
      hands: (room.state.bjPlayerHands?.get(pid) ?? []).map((h) => ({
        cardCount: h.cards.length,
        status: h.status,
        bet: h.bet,
        value: this.calculateHandValue(h.cards),
      })),
    }));
  }
}
