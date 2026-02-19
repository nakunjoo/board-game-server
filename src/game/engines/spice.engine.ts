import { Injectable } from '@nestjs/common';
import { GameEngine, DrawResult } from '../game-engine.interface';
import { Card, CardType, GameState } from '../game.types';

/**
 * 향신료 게임 덱 (100장)
 *  - 문양 3종(pepper / cinnamon / saffron) × 숫자 1~10 × 각 3장 = 90장
 *  - 와일드-숫자 카드: 5장  (어떤 숫자로도 사용 가능, value = 0)
 *  - 와일드-문양 카드: 5장  (어떤 문양으로도 사용 가능, value = 0)
 *  합계 = 90 + 5 + 5 = 100장
 */
@Injectable()
export class SpiceEngine implements GameEngine {
  readonly gameType = 'spice';

  createDeck(): Card[] {
    const suits: CardType[] = ['pepper', 'cinnamon', 'saffron'];
    const deck: Card[] = [];

    // 문양 3종 × 1~10 × 3장씩 = 90장
    for (const suit of suits) {
      for (let value = 1; value <= 10; value++) {
        for (let copy = 1; copy <= 3; copy++) {
          deck.push({
            type: suit,
            value,
            image: '',
            name: `${suit}_${value}_${copy}`,
          });
        }
      }
    }

    // 와일드-숫자: 5장 (어떤 숫자로도 사용 가능)
    for (let i = 1; i <= 5; i++) {
      deck.push({
        type: 'wild-number',
        value: 0,
        image: '',
        name: `wild_number_${i}`,
      });
    }

    // 와일드-문양: 5장 (어떤 문양으로도 사용 가능)
    for (let i = 1; i <= 5; i++) {
      deck.push({
        type: 'wild-suit',
        value: 0,
        image: '',
        name: `wild_suit_${i}`,
      });
    }

    return this.shuffle(deck);
  }

  drawCard(state: GameState): DrawResult {
    if (state.deck.length === 0) {
      throw new Error('덱에 카드가 없습니다');
    }

    const targetClient = state.playerOrder[state.currentTurn];
    if (!targetClient) {
      throw new Error('유효하지 않은 턴입니다');
    }

    const card = state.deck.pop()!;
    const hand = state.hands.get(targetClient) ?? [];
    hand.push(card);
    state.hands.set(targetClient, hand);

    const nextTurn = (state.currentTurn + 1) % state.playerOrder.length;
    state.currentTurn = nextTurn;

    return { card, nextTurn };
  }

  private shuffle(deck: Card[]): Card[] {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
}
