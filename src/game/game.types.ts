import { WebSocket } from 'ws';

export type CardType = 'clubs' | 'diamonds' | 'hearts' | 'spades'
  | 'pepper' | 'cinnamon' | 'saffron'   // 향신료 3종
  | 'wild-number' | 'wild-suit';          // 향신료 와일드카드

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
  owner: string | null; // playerId of owner, null if not selected
}

export interface GameState {
  deck: Card[];
  hands: Map<WebSocket, Card[]>;
  currentTurn: number;
  playerOrder: WebSocket[];
  openCards: Card[];
  chips: Chip[];
  currentStep: number; // 1, 2, 3, 4 (오픈카드 3, 4, 5, 6장)
  playerReady: Set<string>; // 준비 완료한 플레이어 playerId
  nextRoundReady: Set<string>; // 다음 라운드 준비 완료한 플레이어 playerId
  previousChips: Map<string, number[]>; // playerId → [chip numbers]
  winLossRecord: Map<string, boolean[]>; // playerId → [win/loss history] (최대 5개)
}

export interface PlayerResult {
  nickname: string;
  chips: number[];
  hand: Card[];
}

export interface Room {
  name: string;
  gameType: string;
  clients: Set<WebSocket>;
  playerIds: Map<WebSocket, string>; // socket → playerId (고유 식별자)
  nicknames: Map<WebSocket, string>; // socket → nickname (표시용)
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>; // playerId → timer
  state: GameState;
  createdAt: Date;
  gameStarted: boolean;
  gameFinished: boolean; // 게임 종료 여부 (재연결 시 필요)
  lastGameResults?: PlayerResult[]; // 마지막 게임 결과 (재연결 시 필요)
  gameOver?: boolean; // 최종 게임 오버 여부
  gameOverResult?: 'victory' | 'defeat' | null; // 최종 결과
  hostPlayerId: string;
  hostNickname: string;
  password?: string; // 비밀방인 경우 비밀번호
  successCount?: number; // 성공 횟수 (손패 수 결정용: 2회 이상이면 3장)
}
