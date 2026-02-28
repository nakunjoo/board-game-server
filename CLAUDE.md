# The Gang Server - Backend

NestJS 기반 실시간 멀티플레이어 카드 게임 서버

## 변경 이력

| 날짜 | 내용 |
|------|------|
| 2026-02-28 | `skulking.handler.ts`: 선뽑기 선 플레이어가 매 라운드 고정되던 버그 수정 — `resolveTrick`에서 라운드 마지막 트릭 시 `endRound` 호출 전 `skulkingLeadPlayerId = winnerId` 저장 누락 수정 |
| 2026-02-28 | `skulking.handler.ts` / `buildSkulkingState`: 재연결 시 `skulkingTrickOrder` 포함 — 새로고침 후 턴 순서 복원 |
| 2026-02-28 | `skulking.handler.ts` / `buildSkulkingState`: 재연결 시 `skulkingTimerTimeLeft` 포함 — 비드/플레이 타이머 남은 시간(서버 `Date.now()` 기반 계산) 전달 |
| 2026-02-28 | `skulking.handler.ts`: `startBidTimer`에서 `skulkingBidTimerStartedAt = Date.now()` 저장, `startPlayTimer`에서 `skulkingPlayTimerStartedAt = Date.now()` 저장 |
| 2026-02-28 | `skulking.handler.ts`: `skulkingCardPlayed` 이벤트에 `nickname`, `card`, `tigressDeclared` 필드 이미 포함 (채팅 로그 용도로 클라이언트에서 활용) |
| 2026-02-28 | `game.types.ts`: `GameState`에 `skulkingBidTimerStartedAt?: number`, `skulkingPlayTimerStartedAt?: number` 필드 추가 |
| 2026-02-27 | `skulking.handler.ts`: 트릭 승자 판정 버그 수정 — 탈출카드만 있던 경우 `firstNonEscapeEntry`로 처음 나온 숫자 수트 카드 기준으로 승자 판정 (탈출카드 2장 + 숫자카드 상황 오판정 해결) |
| 2026-02-27 | `skulking.handler.ts`: `handleTestStart` 추가 — DEV 전용, 방장만 사용 가능, 라운드+손패 지정 후 비드 단계 시작, `pendingBonus` 초기화 포함 |
| 2026-02-27 | `game.gateway.ts`: `skulkingTestStart` 이벤트 핸들러 추가 |
| 2026-02-27 | `skulking.handler.ts`: 보너스 점수 로직 수정 — `resolveTrick`에서 즉시 반영하던 방식 → `pendingBonus` Map에 누적 후 `endRound`에서 **비드 성공 시에만** 합산 |
| 2026-02-27 | `game.types.ts`: `GameState`에 `pendingBonus?: Map<string, number>` 필드 추가 |
| 2026-02-27 | `skulking.handler.ts`: `pendingBonus` 초기화 — `startMainGame`, `startNewRound`, `handleTestStart` 세 곳에 `room.state.pendingBonus = new Map()` 추가 |
| 2026-02-27 | `skulking.handler.ts`: `skulkingPlayPhase` 이벤트에 `trickOrder` 포함 (클라이언트에서 리드 플레이어=1번 순서 표시용) |
| 2026-02-27 | `skulking.handler.ts`: `skulkingTurnUpdate(isNewTrick: true)` 이벤트에 `trickOrder` 포함 (새 트릭 시작 시 순서 갱신) |
| 2026-02-26 | `game.types.ts`: `GameState`에 `roundBidTrickHistory` 필드 추가 (`Array<{ round, bids, tricks }>`) |
| 2026-02-26 | `skulking.handler.ts`: 게임 시작 시 `roundBidTrickHistory = []` 초기화, `endRound()`에서 완료된 라운드 bid/trick 히스토리 push 후 `skulkingRoundResult` 이벤트에 포함 |
| 2026-02-26 | `game.gateway.ts` (`buildSkulkingState`): 재연결 시 `roundBidTrickHistory` 포함하여 `roomJoined`에 반환 |
| 2026-02-25 | `skulking.handler.ts`: 비드 단계 20초 타이머 추가 — 만료 시 미제출 플레이어 전원 0으로 자동 제출 후 플레이 페이즈 진행 (`startBidTimer`, `clearBidTimer`) |
| 2026-02-25 | `skulking.handler.ts`: 플레이 단계 20초 타이머 추가 — 만료 시 현재 차례 플레이어가 낼 수 있는 카드(리드 수트 팔로우 규칙 적용) 중 랜덤 자동 제출 (`startPlayTimer`, `clearPlayTimer`) |
| 2026-02-25 | `skulking.handler.ts`: `skulkingTurnUpdate`에 `isNewTrick` 플래그 추가 — 트릭 중간 차례 변경(`false`) vs 새 트릭 시작(`true`) 구분 |
| 2026-02-25 | `skulking.handler.ts`: `handlePlayCard`에서 카드 낸 플레이어에게 `myHandUpdate` 개인 전송 (손패에서 낸 카드만 제거) |
| 2026-02-25 | `game.types.ts`: `skulkingBidTimer`, `skulkingPlayTimer` 필드 추가 (`ReturnType<typeof setTimeout>`) |
| 2026-02-24 | `skulking.handler.ts`: Follow suit 서버 검증 수정 — `currentTrick[0]` 기준이 아닌 첫 번째 숫자 수트 카드 기준으로 리드 수트 결정 |
| 2026-02-24 | `skulking.handler.ts`: `handlePlayCard` follow suit 버그 수정 — `hand.some((c) => c.type === leadType)` 전체 손패 체크로 변경 |
| 2026-02-24 | `skulking.handler.ts`: 선뽑기 추가 — `handleStartGame`이 `handleFirstDraw` 호출, `startMainGame(firstPlayerId)` 분리 |
| 2026-02-24 | `skulking.handler.ts`: `startNewRound`에서 `skulkingLeadPlayerId`(마지막 트릭 승자)를 첫 비드 플레이어로 설정 |
| 2026-02-24 | `game.gateway.ts`: `skulkingDrawFirstCard` 이벤트 핸들러 추가 |
| 2026-02-24 | `game.types.ts`: `skulkingFirstDraw`, `skulkingFirstDrawDone`, `skulkingFirstDrawPool` 필드 추가 |
| 2026-02-23 | 스컬킹(Skull King) 게임 추가: `engines/skulking.engine.ts`, `games/skulking/skulking.handler.ts` 신규 생성 |
| 2026-02-23 | `game.types.ts`: CardType에 `sk-black/yellow/purple/green/escape/pirate/mermaid/skulking/tigress` 추가, GameState에 skulking 전용 필드 추가 |
| 2026-02-23 | `game.module.ts`: SkulkingEngine, SkulkingHandler 등록 |
| 2026-02-23 | `game.gateway.ts`: `skulkingBid`, `skulkingPlayCard`, `skulkingNextRound` 이벤트 핸들러 추가, `buildSkulkingState()` 헬퍼 추가, roomJoined에 skulking 상태 포함 |
| 2026-02-22 | `DISCONNECT_GRACE_MS` 5초 → 30초 연장 |
| 2026-02-22 | `handleJoinRoom` 전면 재구성: Case 2에서 같은 소켓 중복 `joinRoom` 안전 처리, `buildFirstDrawState()` / `buildSpiceState()` 헬퍼 추출 |
| 2026-02-22 | `roomJoined`에 firstDraw 전체 상태, `turnTimeLeft`, `challengeTimeLeft` 포함 |
| 2026-02-22 | `GameState`에 `turnStartedAt`, `challengePhase.startedAt` 추가 (타이머 동기화용) |
| 2026-02-22 | `spice.handler.ts`: 턴 전환 4곳에 `turnStartedAt = Date.now()` 설정, `challengePhase`에 `startedAt` 추가 |

## 기술 스택

- **Framework**: NestJS v11
- **WebSocket**: `@nestjs/platform-ws` + `ws`
- **Language**: TypeScript v5.7
- **Port**: 9030

## 프로젝트 구조

```
src/
├── main.ts                          # 엔트리포인트 (포트 9030, WebSocket 어댑터)
├── app.module.ts
├── app.controller.ts                # HTTP 헬스체크
└── game/
    ├── game.module.ts
    ├── game.gateway.ts              # WebSocket 게이트웨이 (방 관리, 재연결, 강퇴)
    ├── game.types.ts                # 공통 타입 (Card, Room, GameState, Chip 등)
    ├── game.context.ts              # 게임 컨텍스트/상태 관리 (DISCONNECT_GRACE_MS 등)
    ├── game-engine.interface.ts     # 게임 엔진 인터페이스
    ├── game-engine.factory.ts       # 게임 엔진 팩토리
    ├── engines/
    │   ├── standard-card.engine.ts  # 표준 52장 덱 엔진 (Gang)
    │   ├── spice.engine.ts          # Spice 100장 덱 엔진
    │   └── skulking.engine.ts       # Skulking 66장 덱 엔진
    └── games/
        ├── gang/gang.handler.ts     # Gang 게임 핸들러
        ├── spice/spice.handler.ts   # Spice 게임 핸들러
        └── skulking/skulking.handler.ts  # Skulking 게임 핸들러
```

## 타입 정의 (game.types.ts)

### Card
```typescript
{
  type: 'clubs' | 'diamonds' | 'hearts' | 'spades'        // Gang
       | 'pepper' | 'cinnamon' | 'saffron'                 // Spice 수트
       | 'wild-number' | 'wild-suit'                       // Spice 와일드
       | 'sk-black' | 'sk-yellow' | 'sk-purple' | 'sk-green'  // Skulking 수트
       | 'sk-escape' | 'sk-pirate' | 'sk-mermaid' | 'sk-skulking' | 'sk-tigress'  // Skulking 특수
  value: number
  image: string
  name: string
}
```

### GameState (Spice 관련 필드 포함)
```typescript
{
  deck: Card[]
  hands: Map<WebSocket, Card[]>
  playerOrder: WebSocket[]
  openCards: Card[]
  chips: Chip[]
  currentStep: number
  playerReady: Set<string>
  nextRoundReady: Set<string>
  previousChips: Map<string, number[]>
  winLossRecord: Map<string, boolean[]>
  // Spice 전용
  firstDraw?: Map<string, number>
  firstDrawDone?: Set<string>
  firstDrawPool?: number[]
  currentTurnPlayerId?: string
  turnStartedAt?: number | null      // 현재 턴 시작 시각 (ms) - 재연결 시 남은 시간 계산용
  currentSuit?: string | null
  currentNumber?: number
  tableStack?: Card[]
  challengePhase?: {
    playerId, playedCard, declaredSuit, declaredNumber,
    nextPlayerId, timer, startedAt: number,  // 도전 페이즈 시작 시각 (ms)
    handEmptyPlayerId?
  } | null
  trophies?: Map<string, number>
  wonCards?: Map<string, Card[]>
  // Skulking 전용
  skulkingRound?: number                    // 현재 라운드 (1~10)
  skulkingPhase?: 'bid' | 'play'            // 현재 페이즈
  skulkingBidOrder?: string[]               // 비드 순서 (playerId 배열)
  skulkingCurrentBidIndex?: number          // 현재 비드 중인 인덱스
  bids?: Map<string, number>                // playerId → 비드 수
  tricks?: Map<string, number>              // playerId → 획득 트릭 수
  scores?: Map<string, number>              // playerId → 누적 점수
  roundScores?: Map<string, number[]>       // playerId → 라운드별 점수 기록
  skulkingLeadPlayerId?: string             // 현재 트릭 리드 플레이어
  skulkingCurrentPlayerId?: string          // 현재 카드 낼 차례 플레이어
  skulkingTrickOrder?: string[]             // 트릭 플레이 순서
  skulkingTrickIndex?: number               // 현재 트릭 플레이 인덱스
  currentTrick?: TrickEntry[]               // 현재 트릭 카드들
  skulkingTrickCount?: number               // 현재 라운드 진행된 트릭 수
  skulkingNextRoundReady?: Set<string>      // 다음 라운드 준비 완료한 playerId
  skulkingBidTimer?: ReturnType<typeof setTimeout>   // 비드 단계 자동 제출 타이머
  skulkingPlayTimer?: ReturnType<typeof setTimeout>  // 플레이 단계 자동 제출 타이머
  skulkingBidTimerStartedAt?: number                 // 비드 타이머 시작 시각 (ms) — 재연결 시 남은 시간 계산용
  skulkingPlayTimerStartedAt?: number                // 플레이 타이머 시작 시각 (ms) — 재연결 시 남은 시간 계산용
  roundBidTrickHistory?: Array<{                    // 완료된 라운드별 bid/trick 기록 (통계 모달 + 재연결 복원용)
    round: number;
    bids: Record<string, number>;
    tricks: Record<string, number>;
  }>
  pendingBonus?: Map<string, number>               // 트릭 중 획득한 보너스 점수 (비드 성공 시에만 endRound에서 합산)
}
```

## 공통 이벤트

**클라이언트 → 서버:**
| 이벤트 | 설명 |
|--------|------|
| `createRoom` | 방 생성 |
| `joinRoom` | 방 참가/재연결 (30초 grace period) |
| `leaveRoom` | 방 퇴장 |
| `getRooms` | 방 목록 조회 |
| `roomMessage` | 채팅 |
| `kickPlayer` | 강퇴 (방장 전용, 게임 시작 전만) |

**서버 → 클라이언트:**
| 이벤트 | 설명 |
|--------|------|
| `roomJoined` | 방 참가 완료 + 전체 게임 상태 (Gang/Spice 모두 포함) |
| `userJoined` / `userLeft` | 플레이어 입/퇴장 |
| `roomList` | 방 목록 |
| `kicked` | 강퇴 알림 |
| `error` | 에러 |

## Gang 게임 이벤트

**클라이언트 → 서버:** `startGame`, `drawCard`, `selectChip`, `playerReady`, `readyNextRound`

**서버 → 클라이언트:** `gameStarted`, `cardDrawn`, `chipSelected`, `playerReadyUpdate`, `nextStep`, `gameFinished`, `nextRoundReadyUpdate`

## Spice 게임 이벤트

**클라이언트 → 서버:** `startGame`, `drawFirstCard`, `playCard`, `pass`, `challenge`, `readyNextRound`

**서버 → 클라이언트:** `firstDrawStarted`, `firstDrawResult`, `firstDrawProgress`, `firstDrawFinished`, `gameStarted`, `cardPlayed`, `cardPassed`, `myHandUpdate`, `challengePhase`, `challengeExpired`, `challengeResult`, `spiceGameOver`

## Skulking 게임 이벤트

**클라이언트 → 서버:** `startGame`, `skulkingDrawFirstCard`, `skulkingBid`, `skulkingPlayCard`, `skulkingNextRound`, `skulkingTestStart`(DEV 전용, roomName/round/hands)

**서버 → 클라이언트:**
| 이벤트 | 내용 |
|--------|------|
| `skulkingFirstDrawStarted` | 선뽑기 시작 |
| `skulkingFirstDrawResult` | 내가 뽑은 숫자 (drawnNumber, drawnCount) — 개인 전송 |
| `skulkingFirstDrawProgress` | 전체 뽑기 진행 현황 (drawnCount) |
| `skulkingFirstDrawFinished` | 선뽑기 완료 (results, firstPlayerId, firstNickname) |
| `skulkingRoundStarted` | 라운드 시작 (round, myHand, playerHands, scores) |
| `skulkingBidPhase` | 비드 단계 시작 (round, bids) — 동시 선언 방식, 20초 타이머 시작 |
| `skulkingBidUpdate` | 비드 제출 현황 (bids) |
| `skulkingPlayPhase` | 플레이 단계 시작 (leadPlayerId, bids, **trickOrder**) |
| `skulkingCardPlayed` | 카드 냄 (playerId, nickname, card, tigressDeclared, currentTrick, playerHands) |
| `myHandUpdate` | 내 손패 업데이트 (myHand) — 카드 낸 플레이어에게 개인 전송 |
| `skulkingTurnUpdate` | 다음 차례 (currentPlayerId, isNewTrick: boolean, **trickOrder?**) — `isNewTrick: true`면 새 트릭 시작 + trickOrder 포함, `false`면 같은 트릭 내 차례 변경 |
| `skulkingTrickResult` | 트릭 결과 (winnerId, winnerNickname, trick[], tricks, bonus, trickCount, totalTricks) |
| `skulkingRoundResult` | 라운드 결과 (round, bids, tricks, roundScores, totalScores, roundScoreHistory, **roundBidTrickHistory**, isLastRound) |
| `skulkingGameOver` | 최종 결과 (finalScores, ranking, roundScoreHistory) |

## Skulking 타이머

### 비드 타이머 (`startBidTimer` / `clearBidTimer`)
- 비드 페이즈 시작 시 **20초** 타이머 설정
- 만료 시 아직 비드 미제출 플레이어 전원에게 0 자동 제출 → 플레이 페이즈 진행
- `handleBid`에서 모든 플레이어 비드 완료 시 타이머 취소

### 플레이 타이머 (`startPlayTimer` / `clearPlayTimer`)
- 각 플레이어 차례 시작 시 **20초** 타이머 설정 (`startTrick`, `skulkingTurnUpdate` 발생 시마다)
- 만료 시 현재 차례 플레이어의 유효한 카드 중 랜덤 자동 제출
  - 리드 수트 팔로우 규칙 적용 (손패에 리드 수트 있으면 해당 수트 또는 특수 카드만)
  - Tigress 자동 제출 시 `escape`로 선언
- `handlePlayCard` 진입 시 타이머 취소 (`clearPlayTimer`)

## Skulking 트릭 승자 판정 (`skulking.handler.ts`)

```
인어(해골왕 있을 때) > 해골왕 > 해적/타이그레스(해적) > 인어(해골왕 없을 때) > ♠ 검정 수트(높은 숫자) > 리드 수트(높은 숫자) > 나머지
E 탈출은 항상 짐. 여러 명이 같은 특수카드를 내면 먼저 낸 사람이 이김 (trick[0] 폴백)
```

**탈출카드 리드 버그 수정** (2026-02-27):
- 탈출카드가 리드로 나왔을 때 숫자카드 무시하던 버그 수정
- `firstNonEscapeEntry`: 트릭에서 탈출카드가 아닌 첫 번째 숫자 수트 카드 기준으로 리드 수트 결정
- 모든 카드가 탈출카드면 `trick[0]`(첫 번째 낸 플레이어) 승리

## Skulking 리드 수트 결정 규칙

- 트릭에서 **처음으로 나온 숫자 수트 카드**가 리드 수트 (`sk-black/yellow/purple/green`)
- 특수카드(`sk-escape/pirate/mermaid/skulking/tigress`)는 리드 수트가 되지 않음
- 손패에 리드 수트가 있으면 리드 수트 또는 특수 카드만 낼 수 있음

```typescript
// handlePlayCard 내 리드 수트 검증
const leadEntry = currentTrick.find((e) => this.isNumberSuit(this.getEffectiveType(e)));
if (leadEntry) {
  const leadType = this.getEffectiveType(leadEntry);
  if (!SPECIAL_TYPES.includes(playedType) && playedType !== leadType) {
    const hasLeadSuit = hand.some((c) => c.type === leadType);
    if (hasLeadSuit) { /* error */ }
  }
}
```

## Skulking 선뽑기 흐름

1. `startGame` → `handleStartGame` → 선뽑기 초기화 → `skulkingFirstDrawStarted` 브로드캐스트
2. 각 플레이어 `skulkingDrawFirstCard` 전송 → `skulkingFirstDrawResult`(개인) + `skulkingFirstDrawProgress`(전체)
3. 전원 완료 → `skulkingFirstDrawFinished` 브로드캐스트 → 2초 후 `startMainGame(firstPlayerId)`
4. `startMainGame`: 선뽑기 상태 초기화 → 라운드 시작

## Skulking 라운드 리드 플레이어

- `skulkingLeadPlayerId`: `startTrick()`에서 갱신 (매 트릭 승자)
- `startNewRound()`에서 `skulkingLeadPlayerId` 기반으로 비드 순서 설정 → 마지막 트릭 승자가 다음 라운드 첫 비드

## Skulking 점수 계산

- **비드 성공**: 비드 × 20점 (비드 0 성공: 라운드 수 × 10점)
- **비드 실패**: |비드 - 실제| × -10점 (비드 0 실패: 라운드 수 × -10점)
- **보너스** (`calculateTrickBonus`, `pendingBonus` 패턴):
  - Skull King으로 Pirate 잡을 때 +30점/마리
  - Mermaid가 Skull King을 잡을 때 +50점
  - **비드 성공 시에만 적용**: `resolveTrick`에서 `pendingBonus` Map에 누적 → `endRound`에서 비드 성공 플레이어에게만 합산
  - `startMainGame`, `startNewRound`, `handleTestStart` 시 `pendingBonus = new Map()` 초기화

## Skulking 재연결 (roomJoined에 포함되는 상태)

`buildSkulkingState()` 헬퍼로 계산:
- `gameStarted`, `myHand`, `playerHands`, `skulkingRound`, `skulkingPhase`
- `skulkingCurrentBidPlayerId`, `bids`, `tricks`, `scores`, `roundScores`
- `skulkingCurrentPlayerId`, `skulkingLeadPlayerId`, `currentTrick`
- `skulkingTrickOrder` — 재연결 후 턴 순서(플레이어 order) 복원용
- `skulkingTimerTimeLeft` — 현재 단계(bid/play) 타이머 남은 초 (`Date.now()` 기반 계산)
- `roundBidTrickHistory` (완료된 라운드별 bid/trick 누적 기록 — 통계 모달 새로고침 복원용)
- 선뽑기 중이면: `skulkingIsFirstDraw`, `skulkingDrawnCount`, `skulkingTotalCount`

## 재연결 시스템

- 연결 끊김 후 **30초 grace period** (`GameContext.DISCONNECT_GRACE_MS = 30000`)
- `joinRoom` 이벤트로 재연결 요청
- `handleJoinRoom` 세 가지 케이스:
  1. **Case 1** (grace period 내): disconnect timer 취소 + `replaceClient` → `roomJoined`
  2. **Case 2** (같은 playerId가 방에 존재):
     - 다른 소켓: `replaceClient` (빠른 새로고침) → `roomJoined`
     - **같은 소켓** (중복 `joinRoom`): room 상태 변경 없이 `roomJoined`만 재전송 → `playerOrder` 중복 방지
  3. **Case 3** (신규 입장): 게임 시작 후 진입 차단, 대기 중이면 방에 추가
- `roomJoined`에 포함되는 Spice 재연결 상태:
  - `currentTurnPlayerId`, `currentSuit`, `currentNumber`, `tableStackSize`
  - `trophies`, `wonCardCounts`, `challengePhase`
  - `turnTimeLeft` (현재 턴 남은 초, 도전 페이즈 중이면 null)
  - `challengeTimeLeft` (도전 페이즈 남은 초)
  - `isFirstDraw`, `myDrawnNumber`, `drawnCount`, `firstDrawFinished`, `firstDrawResults`, `firstPlayerId`, `firstNickname`

### 헬퍼 함수 (handleJoinRoom 내부)

```typescript
buildFirstDrawState()  // 선뽑기 단계 상태 계산
buildSpiceState()      // Spice 게임 진행 상태 + 타이머 남은 시간 계산
```

## 타이머 동기화

`spice.handler.ts`에서 `currentTurnPlayerId`가 바뀌는 모든 지점에 `turnStartedAt = Date.now()` 설정:
- `startMainGame`: 게임 시작 시 첫 플레이어 턴
- 카드 낼 때: `turnStartedAt = null` (도전 페이즈 중 턴 타이머 일시 중단)
- `resolveChallengeExpired`: 도전 페이즈 만료 후 다음 턴
- `handlePass`: 패스 후 다음 턴
- `handleChallenge`: 도전 결과 후 패배자 턴

## Spice 도전 판정 로직

```
숫자 와일드(wild-number) + 숫자 도전  → 항상 실패 (숫자는 언제나 참)
숫자 와일드(wild-number) + 향신료 도전 → 항상 성공 (향신료가 없음)
문양 와일드(wild-suit) + 향신료 도전  → 항상 실패 (향신료는 언제나 참)
문양 와일드(wild-suit) + 숫자 도전   → 항상 성공 (숫자가 없음)
일반 카드 + 숫자 도전               → value !== declaredNumber
일반 카드 + 향신료 도전              → type !== declaredSuit
```

## Spice 덱 구성 (100장)

| 카드 | 구성 |
|------|------|
| 후추 (pepper) | 1~10, 각 3장 = 30장 |
| 계피 (cinnamon) | 1~10, 각 3장 = 30장 |
| 사프란 (saffron) | 1~10, 각 3장 = 30장 |
| 숫자 와일드 (wild-number) | 5장 |
| 문양 와일드 (wild-suit) | 5장 |

## Spice 점수 계산

| 조건 | 점수 |
|------|------|
| 따낸 카드 1장 | +1점 |
| 트로피 1개 | +10점 |
| 손에 남은 카드 1장 | -1점 |

게임 종료 조건:
- 트로피 조건: 한 플레이어가 트로피 2개 이상 OR 트로피 총합 3개
- 덱 소진: 덱이 떨어지면 종료

## 명령어

```bash
npm run start:dev   # 개발 서버 (watch mode)
npm run build       # 빌드
npm run start:prod  # 프로덕션 실행
npm run test        # 유닛 테스트
npm run lint        # ESLint
```

## 배포

- GCP App Engine: `GCP-DEPLOY-GUIDE.md` 참조
- Docker: `Dockerfile` 사용
