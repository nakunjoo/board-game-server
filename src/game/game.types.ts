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
  // 선뽑기 (Spice 게임)
  firstDraw?: Map<string, number>; // playerId → 뽑은 숫자
  firstDrawDone?: Set<string>; // 뽑기 완료한 playerId
  firstDrawPool?: number[]; // 남은 숫자 풀 (1~10 셔플)
  // 턴 관리 (Spice 게임)
  currentTurnPlayerId?: string; // 현재 턴인 playerId
  currentSuit?: string | null; // 현재 선언된 향신료 (null = 첫 턴 or 리셋 후)
  currentNumber?: number; // 현재 선언된 숫자 (0 = 첫 턴)
  tableStack?: Card[]; // 현재 쌓인 카드 더미 (실제 카드)
  // 도전 페이즈 (Spice 게임)
  challengePhase?: {
    playerId: string;         // 카드를 낸 플레이어
    playedCard: Card;         // 실제로 낸 카드 (뒷면)
    declaredSuit: string;     // 선언한 향신료
    declaredNumber: number;   // 선언한 숫자
    nextPlayerId: string;     // 도전 없을 시 다음 턴 플레이어
    timer: ReturnType<typeof setTimeout>; // 5초 자동 진행 타이머
    handEmptyPlayerId?: string; // 이 카드를 내면 손패가 비는 플레이어 (트로피 대상)
  } | null;
  // 트로피 (Spice 게임) - 손패를 모두 비운 플레이어에게 지급
  trophies?: Map<string, number>; // playerId → 트로피 수 (최대 3)
  // 따낸 카드 (Spice 게임) - 도전/도전만료로 더미를 획득한 카드들
  wonCards?: Map<string, Card[]>; // playerId → 획득한 카드 목록
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
