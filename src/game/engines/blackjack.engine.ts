import { Injectable } from '@nestjs/common';
import { GameEngine, DrawResult } from '../game-engine.interface';
import { Card, CardType, GameState } from '../game.types';

@Injectable()
export class BlackjackEngine implements GameEngine {
  readonly gameType = 'blackjack';
  readonly DECK_COUNT = 4; // 52 × 4 = 208장

  private readonly CARD_IMAGE_BASE_URL =
    process.env.CARD_IMAGE_BASE_URL ||
    'https://storage.googleapis.com/teak-banner-431004-n3.appspot.com/images/cards';

  createDeck(): Card[] {
    const types: CardType[] = ['clubs', 'diamonds', 'hearts', 'spades'];
    const singleDeck: Card[] = types.flatMap((type) =>
      Array.from({ length: 13 }, (_, i) => {
        const value = i + 1;
        const valueName = this.getValueName(value);
        return {
          type,
          value,
          image: `${this.CARD_IMAGE_BASE_URL}/${type}_${valueName}.svg`,
          name: `${type}_${valueName}`,
        };
      }),
    );

    const multiDeck: Card[] = [];
    for (let i = 0; i < this.DECK_COUNT; i++) {
      multiDeck.push(...singleDeck);
    }

    return this.shuffle(multiDeck);
  }

  // 블랙잭은 핸들러에서 덱을 직접 조작하므로 미사용
  drawCard(_state: GameState): DrawResult {
    throw new Error('블랙잭은 핸들러에서 직접 카드를 드로우합니다');
  }

  private getValueName(value: number): string {
    switch (value) {
      case 1:
        return 'ace';
      case 11:
        return 'jack';
      case 12:
        return 'queen';
      case 13:
        return 'king';
      default:
        return String(value);
    }
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
