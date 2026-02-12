import { Injectable } from '@nestjs/common';
import { GameEngine, DrawResult } from '../game-engine.interface';
import { Card, CardType, GameState } from '../game.types';

@Injectable()
export class StandardCardEngine implements GameEngine {
  readonly gameType = 'gang';
  private readonly CARD_IMAGE_BASE_URL =
    process.env.CARD_IMAGE_BASE_URL ||
    'https://storage.googleapis.com/teak-banner-431004-n3.appspot.com/images/cards';

  createDeck(): Card[] {
    const types: CardType[] = ['clubs', 'diamonds', 'hearts', 'spades'];
    const deck: Card[] = types.flatMap((type) =>
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
