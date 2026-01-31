import { Card, GameState } from './game.types';

export interface DrawResult {
  card: Card;
  nextTurn: number;
}

export interface GameEngine {
  readonly gameType: string;

  createDeck(): Card[];

  drawCard(state: GameState): DrawResult;
}
