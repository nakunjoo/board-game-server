# The Gang Server - Backend

NestJS 기반 실시간 멀티플레이어 카드 게임 서버

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
    │   └── spice.engine.ts          # Spice 100장 덱 엔진
    └── games/
        ├── gang/gang.handler.ts     # Gang 게임 핸들러
        └── spice/spice.handler.ts   # Spice 게임 핸들러
```

## 타입 정의 (game.types.ts)

### Card
```typescript
{
  type: 'clubs' | 'diamonds' | 'hearts' | 'spades'
       | 'pepper' | 'cinnamon' | 'saffron'
       | 'wild-number' | 'wild-suit'
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
