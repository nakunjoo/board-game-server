import { WebSocket } from 'ws';

export type CardType =
  | 'clubs'
  | 'diamonds'
  | 'hearts'
  | 'spades'
  | 'pepper'
  | 'cinnamon'
  | 'saffron' // 향신료 3종
  | 'wild-number'
  | 'wild-suit' // 향신료 와일드카드
  | 'sk-black'
  | 'sk-yellow'
  | 'sk-purple'
  | 'sk-green' // 스컬킹 숫자 수트
  | 'sk-escape'
  | 'sk-pirate'
  | 'sk-mermaid'
  | 'sk-skulking'
  | 'sk-tigress'; // 스컬킹 특수 카드

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
  // 라운드별 카드 스냅샷 (Gang 게임) - 마이페이지 기록 상세용
  gangRoundHistory?: {
    round: number;
    openCards: Card[];
    hands: Record<string, Card[]>; // playerId → 그 라운드의 손패
    nicknames: Record<string, string>; // playerId → 닉네임
    isWinner: boolean;
  }[];
  // 선뽑기 (Spice 게임)
  firstDraw?: Map<string, number>; // playerId → 뽑은 숫자
  firstDrawDone?: Set<string>; // 뽑기 완료한 playerId
  firstDrawPool?: number[]; // 남은 숫자 풀 (1~10 셔플)
  firstDrawTimer?: ReturnType<typeof setTimeout>; // 안 뽑은 사람 자동 뽑기
  // 턴 관리 (Spice 게임)
  currentTurnPlayerId?: string; // 현재 턴인 playerId
  turnStartedAt?: number | null; // 현재 턴 시작 시각 (ms, 재연결 시 남은 시간 계산용)
  spiceTurnTimer?: ReturnType<typeof setTimeout>; // 턴 시간 초과 시 서버 자동 패스
  spiceLastAutoPass?: { playerId: string; at: number }; // 자동 패스 직후 도착한 구버전 클라 pass를 조용히 무시하기 위함
  currentSuit?: string | null; // 현재 선언된 향신료 (null = 첫 턴 or 리셋 후)
  currentNumber?: number; // 현재 선언된 숫자 (0 = 첫 턴)
  tableStack?: Card[]; // 현재 쌓인 카드 더미 (실제 카드)
  // 도전 페이즈 (Spice 게임)
  challengePhase?: {
    playerId: string; // 카드를 낸 플레이어
    playedCard: Card; // 실제로 낸 카드 (뒷면)
    declaredSuit: string; // 선언한 향신료
    declaredNumber: number; // 선언한 숫자
    nextPlayerId: string; // 도전 없을 시 다음 턴 플레이어
    timer: ReturnType<typeof setTimeout>; // 5초 자동 진행 타이머
    startedAt: number; // 도전 페이즈 시작 시각 (ms, 재연결 시 남은 시간 계산용)
    handEmptyPlayerId?: string; // 이 카드를 내면 손패가 비는 플레이어 (트로피 대상)
  } | null;
  // 트로피 (Spice 게임) - 손패를 모두 비운 플레이어에게 지급
  trophies?: Map<string, number>; // playerId → 트로피 수 (최대 3)
  // 따낸 카드 (Spice 게임) - 도전/도전만료로 더미를 획득한 카드들
  wonCards?: Map<string, Card[]>; // playerId → 획득한 카드 목록
  // 선뽑기 (Skulking 게임)
  skulkingFirstDraw?: Map<string, number>; // playerId → 뽑은 숫자
  skulkingFirstDrawDone?: Set<string>; // 뽑기 완료한 playerId
  skulkingFirstDrawPool?: number[]; // 남은 숫자 풀 (1~10 셔플)
  skulkingFirstDrawTimer?: ReturnType<typeof setTimeout>; // 안 뽑은 사람 자동 뽑기
  skulkingNextRoundTimer?: ReturnType<typeof setTimeout>; // 라운드 결과 후 다음 라운드 시작
  skulkingNextRoundAt?: number; // 다음 라운드 시작 예정 시각 (ms, 재연결 카운트다운 복원용)

  // 스컬킹 게임 전용
  skulkingRound?: number; // 현재 라운드 (1~10)
  skulkingPhase?: 'bid' | 'play'; // 현재 페이즈
  skulkingBidOrder?: string[]; // 비드 순서 (playerId 배열)
  skulkingCurrentBidIndex?: number; // 현재 비드 차례 인덱스
  bids?: Map<string, number>; // playerId → 비드 수
  tricks?: Map<string, number>; // playerId → 획득 트릭 수
  scores?: Map<string, number>; // playerId → 누적 점수
  roundScores?: Map<string, number[]>; // playerId → 라운드별 점수 기록
  roundBidTrickHistory?: Array<{
    round: number;
    bids: Record<string, number>;
    tricks: Record<string, number>;
  }>; // 라운드별 비드/트릭 기록
  skulkingLeadPlayerId?: string; // 현재 트릭 리드 플레이어
  skulkingCurrentPlayerId?: string; // 현재 카드 낼 차례 플레이어
  skulkingTrickOrder?: string[]; // 현재 트릭 내는 순서 (playerId 배열)
  skulkingTrickIndex?: number; // 현재 트릭 내는 순서 인덱스
  currentTrick?: Array<{
    playerId: string;
    nickname?: string;
    card: Card;
    tigressDeclared?: 'escape' | 'pirate';
  }>; // 현재 트릭
  skulkingTrickCount?: number; // 현재 라운드에서 완료된 트릭 수
  skulkingNextRoundReady?: Set<string>; // 다음 라운드 준비 완료한 playerId
  pendingBonus?: Map<string, number>; // 라운드 중 트릭 보너스 누적 (비드 성공 시에만 반영)
  skulkingBidTimer?: ReturnType<typeof setTimeout>; // 비드 자동 제출 타이머
  skulkingPlayTimer?: ReturnType<typeof setTimeout>; // 플레이 자동 제출 타이머
  skulkingBidTimerStartedAt?: number; // 비드 타이머 시작 시각 (ms)
  skulkingPlayTimerStartedAt?: number; // 플레이 타이머 시작 시각 (ms)

  // 카지노 전용 (GameState 내 플레이어별 데이터)
  casinoBalances?: Map<string, number>; // playerId → 잔액
  casinoCurrentGames?: Map<string, string | null>; // playerId → 현재 플레이 중인 게임
  casinoHistory?: Map<string, { t: number; b: number }[]>; // playerId → 잔액 히스토리 [{t: 경과초, b: 잔액}]
  casinoGamesPlayed?: Map<string, Record<string, number>>; // playerId → 게임별 플레이 횟수
  casinoVotes?: Set<string>; // 조기 종료 투표한 playerId
  casinoLoans?: Map<string, number>; // playerId → 총 대출금액 누적
  casinoPendingStakes?: Map<string, number>; // playerId → 결과 미반영 베팅액 (casinoResult 상한 검증용)
}

/** 끄적끄적: 선 하나. 좌표는 그림판 크기와 무관하게 0~1000 정수 [x0, y0, x1, y1, ...] */
export interface DrawingStroke {
  id: number;
  color: string;
  size: number; // 그림판 폭의 1/1000 단위
  points: number[];
}

/** 끄적끄적 진행 상태 (게임 중에만 있음) */
export interface DrawingState {
  totalRounds: number;
  drawTimeSec: number;
  round: number; // 1부터
  turnOrder: string[]; // 그리는 순서 (playerId, 시작 때 고정)
  turnIndex: number;
  phase: 'choose' | 'draw' | 'reveal';
  drawerId: string;
  choices: string[]; // 그리는 사람에게만 보이는 제시어 후보
  word: string | null;
  phaseStartedAt: number;
  phaseEndsAt: number;
  timer?: ReturnType<typeof setTimeout>; // 현재 페이즈 종료
  hintTimers: ReturnType<typeof setTimeout>[];
  hint: (string | null)[]; // 글자별 공개 상태 (null = 가림)
  strokes: DrawingStroke[];
  pointCount: number;
  guessed: string[]; // 맞힌 순서
  scores: Map<string, number>;
  turnGains: Map<string, number>; // 이번 턴에 얻은 점수
  usedWords: Set<string>;
  drawerAwayTimer?: ReturnType<typeof setTimeout>; // 그리는 사람이 끊긴 지 10초면 턴 종료
  nicknames: Map<string, string>; // 중간에 나간 사람도 결과에 이름이 남게
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
  playerIds: Map<WebSocket, string>; // socket → userId (Supabase auth UUID)
  nicknames: Map<WebSocket, string>; // socket → nickname (표시용)
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>; // userId → timer
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
  supabaseSessionId?: string; // Supabase game_sessions.id
  sessionStartedAt?: number; // 게임 시작 시각 (ms, duration 계산용)
  pendingAbandonedPlayerIds?: string[]; // sessionId 확정 전 이탈한 playerId 큐
  voiceParticipants?: Map<string, { playerId: string; nickname: string }>; // 음성 통화 참여자
  casinoInitialBalance?: number; // 카지노: 게임 시작 시 지급 잔액
  casinoTimeLimit?: number | null; // 카지노: 시간 제한 (분, null=무제한)
  casinoStartedAt?: number; // 카지노: 게임 시작 타임스탬프 (ms)
  casinoTimer?: ReturnType<typeof setTimeout>; // 카지노: 타임리밋 타이머
  // 게임 종료 후 재연결·새로고침한 사람에게 결과를 다시 보여주기 위한 값
  spiceGameOverMeta?: {
    reason: 'trophy' | 'deck' | 'playerLeft';
    winnerIds: string[];
    winnerNicknames: string[];
    maxScore: number;
  };
  skulkingGameOverResult?: { ranking: { playerId: string }[] };
  casinoLastResult?: { players: { playerId: string }[] };
  drawing?: DrawingState;
  drawingGameOverResult?: {
    reason: 'finished' | 'notEnough';
    ranking: {
      playerId: string;
      nickname: string;
      score: number;
      rank: number;
    }[];
  };
}
