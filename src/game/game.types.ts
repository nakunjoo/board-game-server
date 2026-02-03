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

export interface Chip {
  number: number;
  state: number; // 0: white, 1: yellow, 2: orange, 3: red
  owner: string | null; // nickname of owner, null if not selected
}

export interface GameState {
  deck: Card[];
  hands: Map<WebSocket, Card[]>;
  currentTurn: number;
  playerOrder: WebSocket[];
  openCards: Card[];
  chips: Chip[];
  currentStep: number; // 1, 2, 3, 4 (오픈카드 3, 4, 5, 6장)
  playerReady: Set<string>; // 준비 완료한 플레이어 닉네임
  previousChips: Map<string, number[]>; // nickname → [chip numbers]
  winLossRecord: Map<string, boolean[]>; // nickname → [win/loss history] (최대 5개)
}

export interface Room {
  name: string;
  gameType: string;
  clients: Set<WebSocket>;
  nicknames: Map<WebSocket, string>;
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>; // nickname → timer
  state: GameState;
  createdAt: Date;
  gameStarted: boolean;
  hostNickname: string;
  password?: string; // 비밀방인 경우 비밀번호
}
