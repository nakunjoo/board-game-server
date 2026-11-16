import { Card } from '../game.types';
import { GameContext } from '../game.context';
import { SpiceHandler } from '../games/spice/spice.handler';
import { BotSelf, BotBrain, botScheduler } from './bot.brain';

const SUITS = ['pepper', 'cinnamon', 'saffron'];
/** 낼 카드가 없을 때 거짓말을 할 확률 (아니면 패스) */
const BLUFF_RATE = 0.3;
/** 와일드를 쓸 확률 (와일드는 숫자·향신료 중 한쪽 도전에는 늘 진다) */
const WILD_RATE = 0.7;

export interface SpicePlay {
  cardIndex: number;
  declaredSuit: string;
  declaredNumber: number;
}

/**
 * 이번 차례에 낼 것. null이면 패스.
 * 참말로 낼 수 있으면 가장 작은 숫자로(큰 숫자는 아껴 둔다) → 없으면 와일드 → 그래도 없으면 가끔 거짓말
 */
export function spiceChoose(
  hand: Card[],
  currentSuit: string | null | undefined,
  currentNumber: number,
  rand: () => number = Math.random,
): SpicePlay | null {
  if (hand.length === 0) return null;
  const reset = !currentNumber || currentNumber >= 10;
  // 리셋이면 1~3, 아니면 지금보다 큰 숫자·같은 향신료
  const okNumber = (n: number) =>
    reset ? n >= 1 && n <= 3 : n > currentNumber && n <= 10;
  const okSuit = (s: string) => reset || s === currentSuit;

  const truthful = hand
    .map((c, i) => ({ c, i }))
    .filter(
      ({ c }) => SUITS.includes(c.type) && okSuit(c.type) && okNumber(c.value),
    )
    .sort((a, b) => a.c.value - b.c.value);
  if (truthful.length > 0) {
    const { c, i } = truthful[0];
    return { cardIndex: i, declaredSuit: c.type, declaredNumber: c.value };
  }

  // 리셋이면 손패에 가장 많은 향신료로, 아니면 지금 향신료로
  const suitFor = () => {
    if (!reset && currentSuit) return currentSuit;
    const counts = SUITS.map((s) => hand.filter((c) => c.type === s).length);
    return SUITS[counts.indexOf(Math.max(...counts))];
  };
  const nextNumber = reset ? 1 : currentNumber + 1;

  const wild = hand.findIndex(
    (c) => c.type === 'wild-number' || c.type === 'wild-suit',
  );
  if (wild !== -1 && rand() < WILD_RATE)
    return {
      cardIndex: wild,
      declaredSuit: suitFor(),
      declaredNumber: nextNumber,
    };

  if (rand() < BLUFF_RATE || hand.length === 1) {
    // 가장 쓸모없는 카드(가장 작은 숫자)를 내며 선언만 맞춘다
    const junk = hand
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (a.c.value || 99) - (b.c.value || 99))[0];
    return {
      cardIndex: junk.i,
      declaredSuit: suitFor(),
      declaredNumber: nextNumber,
    };
  }
  return null;
}

/**
 * 남이 낸 카드에 도전할지. 'number' | 'suit' | null.
 * 선언한 카드를 내가 이미 여러 장 들고 있으면(같은 카드는 3장뿐) 거짓말일 가능성이 높다.
 * 숫자가 클수록, 그 사람이 마지막 한 장을 냈을수록(트로피를 막아야 함) 더 도전한다
 */
export function spiceChallenge(
  hand: Card[],
  declaredSuit: string,
  declaredNumber: number,
  playerLeftCards: number,
  rand: () => number = Math.random,
): 'number' | 'suit' | null {
  const same = hand.filter(
    (c) => c.type === declaredSuit && c.value === declaredNumber,
  ).length;
  // 봇 여러 명이 각자 굴리므로 한 명당 확률은 낮게 (처음엔 0.1이었는데 낸 카드의 37%가 도전받아
  // 모두 손패가 불어나 아무도 트로피를 못 땄다)
  let p = 0.03;
  if (declaredNumber >= 8) p += 0.04;
  if (same >= 2) p += 0.45;
  else if (same === 1) p += 0.06;
  if (playerLeftCards === 0) p += 0.35;
  if (rand() >= p) return null;
  // 그 숫자를 내가 들고 있으면 숫자를, 아니면 반반
  if (same > 0) return 'number';
  return rand() < 0.5 ? 'number' : 'suit';
}

/**
 * 향신료 봇. 선뽑기는 바로, 차례면 spiceChoose대로 내거나 패스, 남이 내면 spiceChallenge대로 도전.
 * 도전 결과 직후 차례는 서버 시계가 3초 늦게 시작하므로 그만큼 기다렸다 낸다
 */
export function createSpiceBot(
  ctx: GameContext,
  spice: SpiceHandler,
  self: BotSelf,
): BotBrain {
  const { later, room } = botScheduler(ctx, self);
  const sock = self.sock;
  const roomName = self.roomName;

  const takeTurn = () => {
    const r = room();
    if (
      !r ||
      !r.gameStarted ||
      r.state.currentTurnPlayerId !== self.id ||
      r.state.challengePhase
    )
      return;
    const hand = r.state.hands.get(sock) ?? [];
    const play = spiceChoose(
      hand,
      r.state.currentSuit,
      r.state.currentNumber ?? 0,
    );
    if (play) spice.handlePlayCard({ roomName, ...play }, sock);
    else spice.handlePass({ roomName }, sock);
  };

  const maybeChallenge = () => {
    const r = room();
    const cp = r?.state.challengePhase;
    if (!r || !cp || cp.playerId === self.id) return;
    const playerSock = ctx.findClientByPlayerId(r, cp.playerId);
    const left = playerSock ? (r.state.hands.get(playerSock)?.length ?? 0) : 0;
    const type = spiceChallenge(
      r.state.hands.get(sock) ?? [],
      cp.declaredSuit,
      cp.declaredNumber,
      left,
    );
    if (type) spice.handleChallenge({ roomName, challengeType: type }, sock);
  };

  return (event: string, data: unknown) => {
    const d = (data ?? {}) as Record<string, unknown>;
    switch (event) {
      case 'firstDrawStarted':
        later(
          'draw',
          () => spice.handleDrawFirstCard({ roomName }, sock),
          600 + Math.random() * 1200,
        );
        break;
      case 'gameStarted':
      case 'cardPassed':
      case 'challengeExpired':
        if (d.currentTurnPlayerId === self.id)
          later('turn', takeTurn, 1200 + Math.random() * 1800, true);
        break;
      case 'challengeResult':
        if (d.currentTurnPlayerId === self.id)
          later('turn', takeTurn, 3600 + Math.random() * 1500, true);
        break;
      case 'challengePhase':
        if (d.playerId !== self.id)
          later('challenge', maybeChallenge, 900 + Math.random() * 2500, true);
        break;
    }
  };
}
