import { Injectable } from '@nestjs/common';
import { GameEngine, DrawResult } from '../game-engine.interface';
import { Card, CardType, GameState } from '../game.types';

/**
 * 스컬킹 게임 덱 (66장)
 *  - 숫자 수트 4종 × 1~13 = 52장
 *    sk-black(Jolly Roger), sk-yellow(Treasure Chest), sk-purple(Jolly Roger), sk-green(Mermaid's Crown)
 *  - Escape(도망): 5장 (항상 짐)
 *  - Pirate(해적): 5장 (Escape 제외 모두 이김, Skull King/Mermaid 제외)
 *  - Mermaid(인어): 2장 (Pirate 이김, Skull King에게 짐)
 *  - Skull King: 1장 (모든 카드 이김, Mermaid 제외)
 *  - Tigress: 1장 (Escape 또는 Pirate로 선언 가능)
 *  합계 = 52 + 5 + 5 + 2 + 1 + 1 = 66장
 */
@Injectable()
export class SkulkingEngine implements GameEngine {
  readonly gameType = 'skulking';

  createDeck(): Card[] {
    const suits: CardType[] = [
      'sk-black',
      'sk-yellow',
      'sk-purple',
      'sk-green',
    ];
    const suitNames: Record<string, string> = {
      'sk-black': 'Jolly Roger',
      'sk-yellow': 'Treasure Chest',
      'sk-purple': 'Jolly Roger',
      'sk-green': "Mermaid's Crown",
    };
    const deck: Card[] = [];

    // 숫자 수트 4종 × 1~13 = 52장
    for (const suit of suits) {
      for (let value = 1; value <= 13; value++) {
        deck.push({
          type: suit,
          value,
          image: '',
          name: `${suit}_${value}`,
        });
      }
    }

    // Escape: 5장
    for (let i = 1; i <= 5; i++) {
      deck.push({
        type: 'sk-escape',
        value: 0,
        image: '',
        name: `escape_${i}`,
      });
    }

    // Pirate: 5장
    for (let i = 1; i <= 5; i++) {
      deck.push({
        type: 'sk-pirate',
        value: 0,
        image: '',
        name: `pirate_${i}`,
      });
    }

    // Mermaid: 2장
    for (let i = 1; i <= 2; i++) {
      deck.push({
        type: 'sk-mermaid',
        value: 0,
        image: '',
        name: `mermaid_${i}`,
      });
    }

    // Skull King: 1장
    deck.push({
      type: 'sk-skulking',
      value: 0,
      image: '',
      name: 'skull_king',
    });

    // Tigress: 1장
    deck.push({
      type: 'sk-tigress',
      value: 0,
      image: '',
      name: 'tigress',
    });

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
