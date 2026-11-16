import { Card } from '../game.types';
import { GameContext } from '../game.context';
import { GangHandler } from '../games/gang/gang.handler';
import { BotSelf, BotBrain, botScheduler } from './bot.brain';

type Eval = { score: number; tiebreakers: number[]; detailName: string };

/** 족보 비교: 양수면 a가 높다 */
function compare(a: Eval, b: Eval): number {
  if (a.detailName === b.detailName) return 0;
  if (a.score !== b.score) return a.score - b.score;
  for (let i = 0; i < Math.min(a.tiebreakers.length, b.tiebreakers.length); i++)
    if (a.tiebreakers[i] !== b.tiebreakers[i])
      return a.tiebreakers[i] - b.tiebreakers[i];
  return 0;
}

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const key = (c: Card) => `${c.type}-${c.value}`;

/**
 * 내 패가 다른 사람들 사이에서 몇 번째쯤일지(0 = 가장 약함, 1 = 가장 강함) 몇백 번 가상으로 나눠 보고 어림한다.
 * 남의 손패는 보지 않는다 — 사람과 같은 정보(내 패 + 공개 카드)만 쓴다
 */
export function estimateStrength(
  gang: GangHandler,
  myHand: Card[],
  openCards: Card[],
  players: number,
  samples = 160,
): number {
  if (players < 2) return 0.5;
  const known = new Set([...myHand, ...openCards].map(key));
  const rest: Card[] = [];
  for (const type of SUITS)
    for (let value = 1; value <= 13; value++)
      if (!known.has(`${type}-${value}`))
        rest.push({ type, value, image: '', name: '' } as Card);
  const needBoard = Math.max(0, 5 - openCards.length);
  const opponents = players - 1;
  let total = 0;
  for (let s = 0; s < samples; s++) {
    // 앞에서부터 필요한 만큼만 섞는다
    const need = needBoard + opponents * myHand.length;
    for (let i = 0; i < need && i < rest.length; i++) {
      const j = i + Math.floor(Math.random() * (rest.length - i));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const board = [...openCards, ...rest.slice(0, needBoard)];
    const mine = gang.evaluateHand(myHand, board);
    let beaten = 0;
    for (let o = 0; o < opponents; o++) {
      const start = needBoard + o * myHand.length;
      const theirs = gang.evaluateHand(
        rest.slice(start, start + myHand.length),
        board,
      );
      const c = compare(mine, theirs);
      beaten += c > 0 ? 1 : c === 0 ? 0.5 : 0;
    }
    total += beaten / opponents;
  }
  return total / samples;
}

/**
 * 갱스터 봇: 단계마다 내 패 세기에 맞는 번호의 빈 칩을 고르고 OK.
 * 봇은 남의 칩을 빼앗지 않는다(봇끼리 서로 빼앗다 끝나지 않는 일을 막으려고). 사람이 빼앗아 가면 남은 칩에서 다시 고른다.
 * 라운드가 끝나면 다음 라운드 준비를 누른다.
 */
export function createGangBot(
  ctx: GameContext,
  gang: GangHandler,
  self: BotSelf,
): BotBrain {
  const { later, room } = botScheduler(ctx, self);
  const sock = self.sock;
  const roomName = self.roomName;

  const chooseChip = (): number | null => {
    const r = room();
    if (!r) return null;
    const free = r.state.chips.filter((c) => !c.owner).map((c) => c.number);
    if (free.length === 0) return null;
    const hand = r.state.hands.get(sock) ?? [];
    const n = r.state.chips.length;
    const p = estimateStrength(gang, hand, r.state.openCards, n);
    const target = 1 + Math.round(p * (n - 1));
    return free.reduce((best, x) =>
      Math.abs(x - target) < Math.abs(best - target) ? x : best,
    );
  };

  const act = () => {
    const r = room();
    if (!r || !r.gameStarted) return;
    if (r.gameFinished) {
      if (!r.gameOver && !r.state.nextRoundReady.has(self.id))
        gang.handleReadyNextRound({ roomName }, sock);
      return;
    }
    const mine = r.state.chips.find((c) => c.owner === self.id);
    if (!mine) {
      const chip = chooseChip();
      if (chip !== null)
        gang.handleSelectChip({ roomName, chipNumber: chip }, sock);
      return;
    }
    if (!r.state.playerReady.has(self.id))
      gang.handlePlayerReady({ roomName }, sock);
  };

  return (event: string) => {
    if (
      event === 'gameStarted' ||
      event === 'nextStep' ||
      event === 'chipSelected' ||
      event === 'playerReadyUpdate' ||
      event === 'gameFinished'
    )
      later('act', act);
  };
}
