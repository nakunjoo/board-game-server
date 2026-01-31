import { WebSocket } from 'ws';

export type CardType = 'clubs' | 'diamonds' | 'hearts' | 'spades';

export interface Card {
  type: CardType;
  value: number;
  image: string;
  name: string;
}

export interface PlayerHand {
  nickname: string;
  cardCount: number;
}

export interface GameState {
  deck: Card[];
  hands: Map<WebSocket, Card[]>;
  currentTurn: number;
  playerOrder: WebSocket[];
}

export interface Room {
  name: string;
  gameType: string;
  clients: Set<WebSocket>;
  nicknames: Map<WebSocket, string>;
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>; // nickname → timer
  state: GameState;
  createdAt: Date;
}
