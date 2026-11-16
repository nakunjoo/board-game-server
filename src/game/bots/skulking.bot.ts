import { Card } from '../game.types';
import { GameContext } from '../game.context';
import { SkulkingHandler } from '../games/skulking/skulking.handler';
import { BotSelf, BotBrain, botScheduler } from './bot.brain';

const SPECIAL = [
  'sk-escape',
  'sk-pirate',
  'sk-mermaid',
  'sk-skulking',
  'sk-tigress',
];
type Decl = 'escape' | 'pirate' | undefined;

/** 이 카드 한 장이 트릭을 딸 것 같은 정도 (비드 어림용) */
function winChance(c: Card): number {
  switch (c.type) {
    case 'sk-skulking':
      return 0.95;
    case 'sk-pirate':
      return 0.8;
    case 'sk-tigress':
      return 0.7;
    case 'sk-mermaid':
      return 0.55;
    case 'sk-escape':
      return 0;
    case 'sk-black':
      return c.value >= 11
        ? 0.7
        : c.value >= 8
          ? 0.45
          : c.value >= 5
            ? 0.2
            : 0.05;
    default:
      return c.value >= 12 ? 0.45 : c.value >= 10 ? 0.25 : 0.05;
  }
}

/** 낼 때 아까운 정도 (같은 조건이면 덜 아까운 카드부터) */
function power(c: Card, decl: Decl): number {
  if (c.type === 'sk-tigress') return decl === 'pirate' ? 40 : 0;
  if (c.type === 'sk-escape') return 0;
  if (c.type === 'sk-skulking') return 45;
  if (c.type === 'sk-pirate') return 40;
  if (c.type === 'sk-mermaid') return 35;
  return c.value + (c.type === 'sk-black' ? 20 : 0);
}

/** 비드: 손패의 트릭 딸 가능성을 더하고, 사람이 많을수록 조금 줄인다 */
export function skulkingBid(
  hand: Card[],
  round: number,
  players: number,
): number {
  const sum = hand.reduce((s, c) => s + winChance(c), 0);
  const factor = players <= 3 ? 1 : players <= 5 ? 0.85 : 0.75;
  return Math.max(0, Math.min(round, Math.round(sum * factor)));
}

/**
 * 스컬킹 봇.
 * - 선뽑기: 바로 뽑는다
 * - 비드: 센 카드 수로 어림
 * - 카드: 낼 수 있는 카드(리드 수트 따르기) 중에서, 아직 비드만큼 못 땄으면 지금 이길 수 있는 가장 약한 카드,
 *   이미 채웠으면 이기지 않는 카드 중 가장 센 카드(위험한 카드를 안전할 때 버린다). Tigress는 이기고 싶으면 해적, 아니면 탈출
 */
export function createSkulkingBot(
  ctx: GameContext,
  sk: SkulkingHandler,
  self: BotSelf,
): BotBrain {
  const { later, room } = botScheduler(ctx, self);
  const sock = self.sock;
  const roomName = self.roomName;

  const bid = () => {
    const r = room();
    if (!r || r.state.skulkingPhase !== 'bid' || r.state.bids?.has(self.id))
      return;
    const hand = r.state.hands.get(sock) ?? [];
    sk.handleBid(
      {
        roomName,
        bid: skulkingBid(
          hand,
          r.state.skulkingRound ?? hand.length,
          r.clients.size,
        ),
      },
      sock,
    );
  };

  const play = () => {
    const r = room();
    if (
      !r ||
      r.state.skulkingPhase !== 'play' ||
      r.state.skulkingCurrentPlayerId !== self.id
    )
      return;
    const hand = r.state.hands.get(sock) ?? [];
    if (hand.length === 0) return;
    const trick = r.state.currentTrick ?? [];
    const lead = trick.find((e) => sk.isNumberSuit(sk.getEffectiveType(e)));
    const leadType = lead ? sk.getEffectiveType(lead) : null;
    const follow = leadType !== null && hand.some((c) => c.type === leadType);
    const playable = hand
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) => !follow || c.type === leadType || SPECIAL.includes(c.type),
      );

    const options = playable.flatMap(({ c, i }) =>
      (c.type === 'sk-tigress'
        ? (['pirate', 'escape'] as Decl[])
        : [undefined]
      ).map((d) => ({
        i,
        d,
        p: power(c, d),
        wins:
          sk.determineTrickWinner([
            ...trick,
            { playerId: self.id, card: c, tigressDeclared: d },
          ]) === self.id,
      })),
    );
    const won = r.state.tricks?.get(self.id) ?? 0;
    const target = r.state.bids?.get(self.id) ?? 0;
    const byPower = (a: { p: number }, b: { p: number }) => a.p - b.p;

    let pick;
    if (won < target) {
      // 따야 한다: 이기는 카드 중 가장 약한 것, 없으면 가장 약한 카드 버리기
      pick =
        options.filter((o) => o.wins).sort(byPower)[0] ??
        [...options].sort(byPower)[0];
    } else {
      // 더 따면 안 된다: 지는 카드 중 가장 센 것, 다 이기면 가장 약한 것
      pick =
        options
          .filter((o) => !o.wins)
          .sort(byPower)
          .at(-1) ?? [...options].sort(byPower)[0];
    }
    sk.handlePlayCard(
      { roomName, cardIndex: pick.i, tigressDeclared: pick.d },
      sock,
    );
  };

  return (event: string, data: unknown) => {
    const d = (data ?? {}) as Record<string, unknown>;
    switch (event) {
      case 'skulkingFirstDrawStarted':
        later(
          'draw',
          () => sk.handleFirstDraw({ roomName }, sock),
          600 + Math.random() * 1200,
        );
        break;
      case 'skulkingBidPhase':
        later('bid', bid, 1500 + Math.random() * 2500);
        break;
      case 'skulkingPlayPhase':
        if (d.leadPlayerId === self.id) later('play', play);
        break;
      case 'skulkingTurnUpdate':
        if (d.currentPlayerId === self.id) later('play', play);
        break;
    }
  };
}
