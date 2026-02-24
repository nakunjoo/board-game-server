import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { GameContext } from '../../game.context';
import { GameEngineFactory } from '../../game-engine.factory';
import { Card } from '../../game.types';

const TOTAL_ROUNDS = 10;
const SPECIAL_TYPES = ['sk-escape', 'sk-pirate', 'sk-mermaid', 'sk-skulking', 'sk-tigress'];

@Injectable()
export class SkulkingHandler {
  constructor(
    private readonly ctx: GameContext,
    private readonly engineFactory: GameEngineFactory,
  ) {}

  // ── 게임 시작 ──────────────────────────────────────────────

  handleStartGame(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }

    if (room.playerIds.get(client) !== room.hostPlayerId) {
      this.ctx.sendToClient(client, 'error', { message: '방장만 게임을 시작할 수 있습니다' });
      return;
    }

    if (room.clients.size < 2) {
      this.ctx.sendToClient(client, 'error', { message: '스컬킹은 최소 2명이 필요합니다' });
      return;
    }

    if (room.gameStarted) {
      this.ctx.sendToClient(client, 'error', { message: '이미 게임이 진행 중입니다' });
      return;
    }

    // 선뽑기 시작: 1~10 중 랜덤 숫자 배정
    const numbers = Array.from({ length: 10 }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    room.state.skulkingFirstDraw = new Map();
    room.state.skulkingFirstDrawDone = new Set();
    room.state.skulkingFirstDrawPool = numbers;

    room.gameStarted = true;

    this.ctx.broadcastToRoom(roomName, 'skulkingFirstDrawStarted', {
      roomName,
      players: this.ctx.getPlayersWithOrder(room),
    });
  }

  // ── 선뽑기 카드 뽑기 ────────────────────────────────────────

  handleFirstDraw(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) return;

    const playerId = room.playerIds.get(client)!;
    if (!room.state.skulkingFirstDrawPool || !room.state.skulkingFirstDraw || !room.state.skulkingFirstDrawDone) return;
    if (room.state.skulkingFirstDrawDone.has(playerId)) return;

    const drawnNumber = room.state.skulkingFirstDrawPool.pop()!;
    room.state.skulkingFirstDraw.set(playerId, drawnNumber);
    room.state.skulkingFirstDrawDone.add(playerId);

    const drawnCount = room.state.skulkingFirstDrawDone.size;
    const totalCount = room.clients.size;

    // 본인에게만 결과 전송
    this.ctx.sendToClient(client, 'skulkingFirstDrawResult', {
      roomName,
      playerId,
      drawnNumber,
      drawnCount,
      totalCount,
    });

    // 전체에게 진행 상황 브로드캐스트
    this.ctx.broadcastToRoom(roomName, 'skulkingFirstDrawProgress', {
      roomName,
      drawnCount,
      totalCount,
    });

    // 모두 뽑았으면 결과 발표 후 게임 시작
    if (drawnCount === totalCount) {
      let maxNumber = -1;
      let firstPlayerId = '';
      room.state.skulkingFirstDraw.forEach((num, pid) => {
        if (num > maxNumber) {
          maxNumber = num;
          firstPlayerId = pid;
        }
      });

      const firstDrawResults: Record<string, number> = {};
      room.state.skulkingFirstDraw.forEach((num, pid) => {
        firstDrawResults[pid] = num;
      });

      this.ctx.broadcastToRoom(roomName, 'skulkingFirstDrawFinished', {
        roomName,
        results: firstDrawResults,
        firstPlayerId,
        firstNickname: this.ctx.getNicknameByPlayerId(room, firstPlayerId),
      });

      setTimeout(() => {
        this.startMainGame(roomName, firstPlayerId);
      }, 2000);
    }
  }

  // ── 본 게임 시작 ────────────────────────────────────────────

  private startMainGame(roomName: string, firstPlayerId: string): void {
    const room = this.ctx.rooms.get(roomName);
    if (!room) return;

    // 선뽑기 상태 정리
    room.state.skulkingFirstDraw = undefined;
    room.state.skulkingFirstDrawDone = undefined;
    room.state.skulkingFirstDrawPool = undefined;

    // 스컬킹 초기 상태 설정
    const engine = this.engineFactory.get('skulking');
    room.state.deck = engine.createDeck();

    room.state.skulkingRound = 1;
    room.state.skulkingPhase = 'bid';
    room.state.bids = new Map();
    room.state.tricks = new Map();
    room.state.scores = new Map();
    room.state.roundScores = new Map();
    room.state.currentTrick = [];
    room.state.skulkingTrickCount = 0;
    room.state.skulkingNextRoundReady = new Set();

    // 비드 순서: 선 플레이어부터 시작
    const playerIds = this.getPlayerIds(room);
    const firstIdx = playerIds.indexOf(firstPlayerId);
    const bidOrder = firstIdx >= 0
      ? [...playerIds.slice(firstIdx), ...playerIds.slice(0, firstIdx)]
      : playerIds;

    playerIds.forEach((pid) => {
      room.state.scores!.set(pid, 0);
      room.state.roundScores!.set(pid, []);
    });

    room.state.skulkingBidOrder = bidOrder;
    room.state.skulkingCurrentBidIndex = 0;

    this.dealCards(room, 1);

    // 각 플레이어에게 게임 시작 이벤트
    room.clients.forEach((c) => {
      const myHand = room.state.hands.get(c) ?? [];
      this.ctx.sendToClient(c, 'skulkingRoundStarted', {
        round: 1,
        myHand,
        playerHands: this.ctx.getPlayerHands(room),
        scores: Object.fromEntries(room.state.scores!),
        roundScores: Object.fromEntries(
          Array.from(room.state.roundScores!.entries()).map(([k, v]) => [k, v])
        ),
      });
    });

    // 첫 비드 차례 알림
    const firstBidPlayerId = bidOrder[0];
    this.ctx.broadcastToRoom(roomName, 'skulkingBidPhase', {
      round: 1,
      currentBidPlayerId: firstBidPlayerId,
      currentBidNickname: this.ctx.getNicknameByPlayerId(room, firstBidPlayerId),
      bids: {},
      bidCount: 0,
      totalPlayers: room.clients.size,
    });
  }

  // ── 비드 제출 ─────────────────────────────────────────────

  handleBid(data: { roomName: string; bid: number }, client: WebSocket): void {
    const { roomName, bid } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }

    if (room.state.skulkingPhase !== 'bid') {
      this.ctx.sendToClient(client, 'error', { message: '현재 비드 단계가 아닙니다' });
      return;
    }

    const playerId = room.playerIds.get(client)!;
    const bidOrder = room.state.skulkingBidOrder!;
    const currentBidIndex = room.state.skulkingCurrentBidIndex!;
    const expectedPlayerId = bidOrder[currentBidIndex];

    if (playerId !== expectedPlayerId) {
      this.ctx.sendToClient(client, 'error', { message: '지금 비드 차례가 아닙니다' });
      return;
    }

    const round = room.state.skulkingRound!;
    if (bid < 0 || bid > round) {
      this.ctx.sendToClient(client, 'error', { message: `비드는 0~${round} 사이여야 합니다` });
      return;
    }

    room.state.bids!.set(playerId, bid);
    room.state.skulkingCurrentBidIndex = currentBidIndex + 1;

    const nextBidIndex = currentBidIndex + 1;
    const allBidsDone = nextBidIndex >= bidOrder.length;

    // 비드 공개 (순차)
    this.ctx.broadcastToRoom(roomName, 'skulkingBidUpdate', {
      playerId,
      nickname: this.ctx.getNicknameByPlayerId(room, playerId),
      bid,
      bids: Object.fromEntries(room.state.bids!),
      bidCount: room.state.bids!.size,
      totalPlayers: room.clients.size,
      nextBidPlayerId: allBidsDone ? null : bidOrder[nextBidIndex],
      nextBidNickname: allBidsDone ? null : this.ctx.getNicknameByPlayerId(room, bidOrder[nextBidIndex]),
    });

    if (allBidsDone) {
      // 모든 비드 완료 → 트릭 플레이 시작
      this.startPlayPhase(roomName);
    }
  }

  // ── 카드 내기 ─────────────────────────────────────────────

  handlePlayCard(
    data: { roomName: string; cardIndex: number; tigressDeclared?: 'escape' | 'pirate' },
    client: WebSocket,
  ): void {
    const { roomName, cardIndex, tigressDeclared } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }

    if (room.state.skulkingPhase !== 'play') {
      this.ctx.sendToClient(client, 'error', { message: '현재 플레이 단계가 아닙니다' });
      return;
    }

    const playerId = room.playerIds.get(client)!;
    if (playerId !== room.state.skulkingCurrentPlayerId) {
      this.ctx.sendToClient(client, 'error', { message: '지금 카드 낼 차례가 아닙니다' });
      return;
    }

    const hand = room.state.hands.get(client) ?? [];
    if (cardIndex < 0 || cardIndex >= hand.length) {
      this.ctx.sendToClient(client, 'error', { message: '유효하지 않은 카드 인덱스입니다' });
      return;
    }

    // Tigress는 선언 필수
    if (hand[cardIndex].type === 'sk-tigress' && !tigressDeclared) {
      this.ctx.sendToClient(client, 'error', { message: 'Tigress 카드는 escape 또는 pirate로 선언해야 합니다' });
      return;
    }

    // 리드 수트 팔로우 검증
    const currentTrick = room.state.currentTrick!;
    if (currentTrick.length > 0) {
      // 트릭에서 첫 번째로 나온 숫자 수트 카드가 리드 (특수카드는 리드 수트 결정 안 함)
      const leadEntry = currentTrick.find((e) => this.isNumberSuit(this.getEffectiveType(e)));
      const playedType = hand[cardIndex].type;

      if (leadEntry) {
        const leadType = this.getEffectiveType(leadEntry);
        // 리드 수트가 있는 경우: 특수카드가 아니고 리드 수트도 아닌 카드를 내려면
        // 손패에 리드 수트가 없어야 함
        if (!SPECIAL_TYPES.includes(playedType) && playedType !== leadType) {
          const hasLeadSuit = hand.some((c) => c.type === leadType);
          if (hasLeadSuit) {
            this.ctx.sendToClient(client, 'error', { message: `${leadType} 수트를 따라가야 합니다` });
            return;
          }
        }
      }
    }

    // 카드 제거
    const card = hand.splice(cardIndex, 1)[0];
    room.state.hands.set(client, hand);

    const trickEntry = { playerId, card, tigressDeclared: tigressDeclared as 'escape' | 'pirate' | undefined };
    currentTrick.push(trickEntry);

    // 카드 낸 것 브로드캐스트 (카드 내용 공개 - 스컬킹은 앞면으로 냄)
    this.ctx.broadcastToRoom(roomName, 'skulkingCardPlayed', {
      playerId,
      nickname: this.ctx.getNicknameByPlayerId(room, playerId),
      card,
      tigressDeclared,
      currentTrick: currentTrick.map((e) => ({
        playerId: e.playerId,
        nickname: this.ctx.getNicknameByPlayerId(room, e.playerId),
        card: e.card,
        tigressDeclared: e.tigressDeclared,
      })),
      playerHands: this.ctx.getPlayerHands(room),
    });

    const trickOrder = room.state.skulkingTrickOrder!;
    const nextIndex = (room.state.skulkingTrickIndex! + 1);

    if (nextIndex >= trickOrder.length) {
      // 트릭 완료
      this.resolveTrick(roomName);
    } else {
      room.state.skulkingTrickIndex = nextIndex;
      room.state.skulkingCurrentPlayerId = trickOrder[nextIndex];

      this.ctx.broadcastToRoom(roomName, 'skulkingTurnUpdate', {
        currentPlayerId: trickOrder[nextIndex],
        currentNickname: this.ctx.getNicknameByPlayerId(room, trickOrder[nextIndex]),
      });
    }
  }

  // ── 다음 라운드 준비 ──────────────────────────────────────

  handleNextRound(data: { roomName: string }, client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', { message: `'${roomName}' 방에 참여하고 있지 않습니다` });
      return;
    }

    const playerId = room.playerIds.get(client)!;

    // 방장이 요청하면 즉시 진행
    if (playerId !== room.hostPlayerId) return;

    const nextRound = (room.state.skulkingRound ?? 0) + 1;

    if (nextRound > TOTAL_ROUNDS) {
      this.endGame(roomName);
    } else {
      this.startNewRound(roomName, nextRound);
    }
  }

  // ── 내부 헬퍼 ────────────────────────────────────────────

  private getPlayerIds(room: ReturnType<typeof this.ctx.rooms.get> & object): string[] {
    const ids: string[] = [];
    room.playerIds.forEach((pid: string) => ids.push(pid));
    return ids;
  }

  private dealCards(room: ReturnType<typeof this.ctx.rooms.get> & object, count: number): void {
    // 손패 초기화
    room.clients.forEach((c: WebSocket) => room.state.hands.set(c, []));

    // count장씩 배분 (playerOrder 순서대로 순환)
    const clients = Array.from(room.state.playerOrder);
    for (let i = 0; i < count; i++) {
      for (const c of clients) {
        if (room.state.deck.length === 0) break;
        const card = room.state.deck.pop()!;
        const hand = room.state.hands.get(c) ?? [];
        hand.push(card);
        room.state.hands.set(c, hand);
      }
    }
  }

  private startPlayPhase(roomName: string): void {
    const room = this.ctx.rooms.get(roomName)!;
    room.state.skulkingPhase = 'play';
    room.state.currentTrick = [];
    room.state.skulkingTrickCount = 0;
    room.state.tricks = new Map();
    this.getPlayerIds(room).forEach((pid) => room.state.tricks!.set(pid, 0));

    // 첫 라운드 첫 트릭: playerOrder[0]이 리드
    const playerIds = this.getPlayerIds(room);
    const leadPlayerId = room.state.skulkingLeadPlayerId ?? playerIds[0];
    this.startTrick(room, leadPlayerId);

    this.ctx.broadcastToRoom(roomName, 'skulkingPlayPhase', {
      leadPlayerId,
      leadNickname: this.ctx.getNicknameByPlayerId(room, leadPlayerId),
      bids: Object.fromEntries(room.state.bids!),
    });
  }

  private startTrick(room: ReturnType<typeof this.ctx.rooms.get> & object, leadPlayerId: string): void {
    room.state.currentTrick = [];
    // 리드 플레이어부터 시작하는 트릭 순서
    const playerIds = this.getPlayerIds(room);
    const leadIndex = playerIds.indexOf(leadPlayerId);
    const trickOrder = [
      ...playerIds.slice(leadIndex),
      ...playerIds.slice(0, leadIndex),
    ];
    room.state.skulkingLeadPlayerId = leadPlayerId;
    room.state.skulkingTrickOrder = trickOrder;
    room.state.skulkingTrickIndex = 0;
    room.state.skulkingCurrentPlayerId = trickOrder[0];
  }

  private resolveTrick(roomName: string): void {
    const room = this.ctx.rooms.get(roomName)!;
    const currentTrick = room.state.currentTrick!;

    const winnerId = this.determineTrickWinner(currentTrick);
    const winnerNickname = this.ctx.getNicknameByPlayerId(room, winnerId);

    // 트릭 수 누적
    const curTricks = room.state.tricks!.get(winnerId) ?? 0;
    room.state.tricks!.set(winnerId, curTricks + 1);

    // 보너스 계산
    const bonus = this.calculateTrickBonus(currentTrick, winnerId);

    // 누적 점수에 즉시 보너스 반영
    if (bonus > 0) {
      const curScore = room.state.scores!.get(winnerId) ?? 0;
      room.state.scores!.set(winnerId, curScore + bonus);
    }

    room.state.skulkingTrickCount = (room.state.skulkingTrickCount ?? 0) + 1;
    const round = room.state.skulkingRound!;

    this.ctx.broadcastToRoom(roomName, 'skulkingTrickResult', {
      winnerId,
      winnerNickname,
      trick: currentTrick.map((e) => ({
        playerId: e.playerId,
        nickname: this.ctx.getNicknameByPlayerId(room, e.playerId),
        card: e.card,
        tigressDeclared: e.tigressDeclared,
      })),
      tricks: Object.fromEntries(room.state.tricks!),
      bonus,
      trickCount: room.state.skulkingTrickCount,
      totalTricks: round,
    });

    if (room.state.skulkingTrickCount >= round) {
      // 라운드 종료
      this.endRound(roomName);
    } else {
      // 다음 트릭: 이긴 플레이어가 리드
      setTimeout(() => {
        this.startTrick(room, winnerId);
        this.ctx.broadcastToRoom(roomName, 'skulkingTurnUpdate', {
          currentPlayerId: winnerId,
          currentNickname: winnerNickname,
        });
      }, 1500);
    }
  }

  private endRound(roomName: string): void {
    const room = this.ctx.rooms.get(roomName)!;
    const round = room.state.skulkingRound!;
    const roundScoreMap: Record<string, number> = {};

    room.state.bids!.forEach((bid, playerId) => {
      const won = room.state.tricks!.get(playerId) ?? 0;
      let roundScore: number;

      if (bid === 0) {
        roundScore = bid === won ? round * 10 : -(round * 10);
      } else {
        roundScore = bid === won ? bid * 20 : Math.abs(bid - won) * -10;
      }

      roundScoreMap[playerId] = roundScore;

      const cur = room.state.scores!.get(playerId) ?? 0;
      room.state.scores!.set(playerId, cur + roundScore);

      const history = room.state.roundScores!.get(playerId) ?? [];
      history.push(roundScore);
      room.state.roundScores!.set(playerId, history);
    });

    room.state.skulkingNextRoundReady = new Set();
    room.state.skulkingPhase = undefined as unknown as 'bid';

    this.ctx.broadcastToRoom(roomName, 'skulkingRoundResult', {
      round,
      bids: Object.fromEntries(room.state.bids!),
      tricks: Object.fromEntries(room.state.tricks!),
      roundScores: roundScoreMap,
      totalScores: Object.fromEntries(room.state.scores!),
      roundScoreHistory: Object.fromEntries(room.state.roundScores!),
      isLastRound: round >= TOTAL_ROUNDS,
    });
  }

  private startNewRound(roomName: string, round: number): void {
    const room = this.ctx.rooms.get(roomName)!;

    // 덱 리셋 및 재배분
    const engine = this.engineFactory.get('skulking');
    room.state.deck = engine.createDeck();

    room.state.skulkingRound = round;
    room.state.skulkingPhase = 'bid';
    room.state.bids = new Map();
    room.state.currentTrick = [];
    room.state.skulkingTrickCount = 0;
    room.state.skulkingNextRoundReady = new Set();

    const playerIds = this.getPlayerIds(room);

    // 이전 라운드 마지막 트릭 승자가 새 라운드 선 (없으면 첫 번째 플레이어)
    const leadPlayerId = room.state.skulkingLeadPlayerId ?? playerIds[0];
    const leadIdx = playerIds.indexOf(leadPlayerId);
    const bidOrder = leadIdx >= 0
      ? [...playerIds.slice(leadIdx), ...playerIds.slice(0, leadIdx)]
      : playerIds;

    room.state.skulkingBidOrder = bidOrder;
    room.state.skulkingCurrentBidIndex = 0;

    this.dealCards(room, round);

    room.clients.forEach((c) => {
      const myHand = room.state.hands.get(c) ?? [];
      this.ctx.sendToClient(c, 'skulkingRoundStarted', {
        round,
        myHand,
        playerHands: this.ctx.getPlayerHands(room),
        scores: Object.fromEntries(room.state.scores!),
        roundScores: Object.fromEntries(room.state.roundScores!),
      });
    });

    const firstBidPlayerId = bidOrder[0];
    this.ctx.broadcastToRoom(roomName, 'skulkingBidPhase', {
      round,
      currentBidPlayerId: firstBidPlayerId,
      currentBidNickname: this.ctx.getNicknameByPlayerId(room, firstBidPlayerId),
      bids: {},
      bidCount: 0,
      totalPlayers: room.clients.size,
    });
  }

  private endGame(roomName: string): void {
    const room = this.ctx.rooms.get(roomName)!;
    room.gameFinished = true;
    room.gameOver = true;

    const scores = room.state.scores!;
    const playerIds = this.getPlayerIds(room);

    const ranking = playerIds
      .map((pid) => ({
        playerId: pid,
        nickname: this.ctx.getNicknameByPlayerId(room, pid),
        score: scores.get(pid) ?? 0,
      }))
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ ...p, rank: i + 1 }));

    this.ctx.broadcastToRoom(roomName, 'skulkingGameOver', {
      finalScores: Object.fromEntries(scores),
      ranking,
      roundScoreHistory: Object.fromEntries(room.state.roundScores!),
    });
  }

  // ── 트릭 승자 판정 ────────────────────────────────────────

  private determineTrickWinner(
    trick: Array<{ playerId: string; card: Card; tigressDeclared?: 'escape' | 'pirate' }>,
  ): string {
    // Skull King 찾기
    const skulkingEntry = trick.find((e) => e.card.type === 'sk-skulking');

    // Mermaid 찾기
    const mermaidEntries = trick.filter((e) => e.card.type === 'sk-mermaid');

    // Pirate / Tigress(pirate) 찾기
    const pirateEntries = trick.filter(
      (e) =>
        e.card.type === 'sk-pirate' ||
        (e.card.type === 'sk-tigress' && e.tigressDeclared === 'pirate'),
    );

    // Skull King이 있으면 → Mermaid 없으면 Skull King 승
    if (skulkingEntry) {
      if (mermaidEntries.length > 0) {
        // Mermaid가 Skull King을 이김
        return mermaidEntries[0].playerId;
      }
      return skulkingEntry.playerId;
    }

    // Pirate가 있으면 → Pirate 승 (첫 번째)
    if (pirateEntries.length > 0) {
      return pirateEntries[0].playerId;
    }

    // Mermaid만 있으면 → Mermaid 승
    if (mermaidEntries.length > 0) {
      return mermaidEntries[0].playerId;
    }

    // sk-black은 항상 trump (리드 여부 무관)
    const blackEntries = trick.filter((e) => e.card.type === 'sk-black');
    if (blackEntries.length > 0) {
      return blackEntries.reduce((best, e) =>
        e.card.value > best.card.value ? e : best,
      ).playerId;
    }

    // 리드 수트 결정 (탈출 카드가 리드인 경우 리드 수트 없음으로 처리)
    const leadEntry = trick[0];
    const leadEffectiveType = this.getEffectiveType(leadEntry);

    if (this.isNumberSuit(leadEffectiveType)) {
      // 리드 수트 중 가장 높은 숫자
      const leadSuitEntries = trick.filter((e) => e.card.type === leadEffectiveType);
      if (leadSuitEntries.length > 0) {
        return leadSuitEntries.reduce((best, e) =>
          e.card.value > best.card.value ? e : best,
        ).playerId;
      }
    }

    // 모두 Escape(탈출)이거나 리드 수트 없으면 → 첫 번째로 낸 사람
    return trick[0].playerId;
  }

  private getEffectiveType(
    entry: { card: Card; tigressDeclared?: 'escape' | 'pirate' },
  ): string {
    if (entry.card.type === 'sk-tigress') {
      return entry.tigressDeclared === 'pirate' ? 'sk-pirate' : 'sk-escape';
    }
    return entry.card.type;
  }

  private isNumberSuit(type: string): boolean {
    return ['sk-black', 'sk-yellow', 'sk-purple', 'sk-green'].includes(type);
  }

  private calculateTrickBonus(
    trick: Array<{ playerId: string; card: Card; tigressDeclared?: 'escape' | 'pirate' }>,
    winnerId: string,
  ): number {
    const winnerEntry = trick.find((e) => e.playerId === winnerId)!;
    const winnerCardType = this.getEffectiveType(winnerEntry);

    let bonus = 0;

    if (winnerCardType === 'sk-skulking') {
      // Skull King으로 Pirate 잡으면 +30점/마리
      const pirateCount = trick.filter(
        (e) =>
          e.card.type === 'sk-pirate' ||
          (e.card.type === 'sk-tigress' && e.tigressDeclared === 'pirate'),
      ).length;
      bonus += pirateCount * 30;

      // Skull King 트릭에 Mermaid 있으면 → Mermaid가 이겼을 경우는 위에서 처리됨
      // (Skull King이 이겼다는 것은 Mermaid가 없음)
    }

    if (winnerCardType === 'sk-mermaid') {
      // Mermaid가 Skull King을 이기면 +20점 (Skull King이 트릭에 있음)
      const hasSkullKing = trick.some((e) => e.card.type === 'sk-skulking');
      if (hasSkullKing) {
        bonus += 20;
      }
    }

    return bonus;
  }

  // ── 재연결 상태 빌드 ─────────────────────────────────────

  buildSkulkingState(room: ReturnType<typeof this.ctx.rooms.get> & object) {
    // 선뽑기 단계 재연결
    if (room.state.skulkingFirstDraw !== undefined || room.state.skulkingFirstDrawDone !== undefined) {
      return {
        skulkingIsFirstDraw: true,
        skulkingDrawnCount: room.state.skulkingFirstDrawDone?.size ?? 0,
        skulkingTotalCount: room.clients?.size ?? 0,
      };
    }

    if (!room.state.skulkingRound) return {};

    return {
      skulkingRound: room.state.skulkingRound,
      skulkingPhase: room.state.skulkingPhase,
      skulkingCurrentBidPlayerId:
        room.state.skulkingBidOrder && room.state.skulkingCurrentBidIndex !== undefined
          ? room.state.skulkingBidOrder[room.state.skulkingCurrentBidIndex] ?? null
          : null,
      bids: room.state.bids ? Object.fromEntries(room.state.bids) : {},
      tricks: room.state.tricks ? Object.fromEntries(room.state.tricks) : {},
      scores: room.state.scores ? Object.fromEntries(room.state.scores) : {},
      roundScores: room.state.roundScores ? Object.fromEntries(room.state.roundScores) : {},
      skulkingCurrentPlayerId: room.state.skulkingCurrentPlayerId ?? null,
      skulkingLeadPlayerId: room.state.skulkingLeadPlayerId ?? null,
      currentTrick: (room.state.currentTrick ?? []).map((e) => ({
        playerId: e.playerId,
        card: e.card,
        tigressDeclared: e.tigressDeclared,
      })),
    };
  }
}
