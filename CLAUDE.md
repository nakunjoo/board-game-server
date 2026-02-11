# The Gang Server

NestJS 기반의 실시간 멀티플레이어 카드 게임 서버

## 기술 스택

- **Framework**: NestJS v11
- **WebSocket**: `@nestjs/platform-ws` + `@nestjs/websockets` (ws 라이브러리 기반)
- **Language**: TypeScript v5.7
- **Runtime**: Node.js
- **Test**: Jest v30
- **Linter/Formatter**: ESLint v9 + Prettier v3

## 프로젝트 구조

```
src/
├── main.ts                          # 앱 엔트리포인트 (포트 9030, WebSocket 어댑터, CORS 설정)
├── app.module.ts                    # 루트 모듈 (GameModule import)
├── app.controller.ts                # 기본 HTTP 컨트롤러 (헬스체크)
├── app.service.ts                   # 기본 서비스
└── game/
    ├── game.module.ts               # 게임 모듈 (엔진 팩토리, 게이트웨이 등록)
    ├── game.gateway.ts              # WebSocket 게이트웨이 (방 관리, 게임 로직, 재연결, 강퇴 등)
    ├── game.types.ts                # 공통 타입 정의
    │                                  - Card: type, value, image, name
    │                                  - Room: clients, playerIds, nicknames, state, password 등
    │                                  - GameState: deck, hands, chips, currentStep, playerReady 등
    │                                  - Chip: number, state, owner
    │                                  - PlayerResult, PlayerHand
    ├── game-engine.interface.ts     # 게임 엔진 인터페이스 (gameType, createDeck, drawCard)
    ├── game-engine.factory.ts       # 게임 엔진 팩토리 (게임 타입별 엔진 선택)
    └── engines/
        └── standard-card.engine.ts  # 표준 52장 카드 덱 엔진 (gameType: 'gang')
```

## 주요 컴포넌트

### 1. WebSocket Gateway (`/ws`)

**위치**: `src/game/game.gateway.ts`

모든 실시간 게임 통신을 처리하는 핵심 컴포넌트입니다.

**클라이언트 → 서버 이벤트:**
- `createRoom`: 방 생성 (name, playerId, nickname, gameType, password?)
- `joinRoom`: 방 참가/재연결 (name, playerId, nickname, password?)
- `leaveRoom`: 방 퇴장 (name)
- `startGame`: 게임 시작 (roomName) - 방장만 가능
- `drawCard`: 카드 뽑기 (roomName, playerId)
- `selectChip`: 칩 선택 (roomName, playerId, chipNumber)
- `playerReady`: 플레이어 준비 완료 (roomName, playerId)
- `readyNextRound`: 다음 라운드 준비 (roomName, playerId)
- `getRooms`: 방 목록 조회
- `getPlayerList`: 특정 방의 플레이어 목록 조회 (roomName)
- `roomMessage`: 채팅 메시지 (roomName, nickname, message)
- `kickPlayer`: 플레이어 강퇴 (roomName, targetPlayerId) - 방장 전용, 게임 시작 전만

**서버 → 클라이언트 이벤트:**
- `roomCreated`: 방 생성 완료
- `roomJoined`: 방 참가 완료 (재연결 시 전체 게임 상태 포함)
- `userJoined`: 다른 플레이어 참가 알림
- `userLeft`: 다른 플레이어 퇴장 알림
- `gameStarted`: 게임 시작 (초기 덱, 손패, 칩 상태)
- `cardDrawn`: 카드 뽑기 완료
- `chipSelected`: 칩 선택 완료
- `playerReadyUpdate`: 플레이어 준비 상태 업데이트
- `nextStep`: 다음 스텝 진행 (오픈 카드 공개)
- `gameFinished`: 게임 종료 (결과 데이터)
- `nextRoundReadyUpdate`: 다음 라운드 준비 상태 업데이트
- `roomList`: 방 목록 (name, playerCount, isPrivate 등)
- `playerList`: 플레이어 목록
- `roomMessage`: 채팅 메시지
- `kicked`: 강퇴 알림 (강퇴당한 플레이어에게만 전송)
- `error`: 에러 메시지

**주요 기능:**

1. **재연결 시스템**
   - Grace Period: 5초 (DISCONNECT_GRACE_MS)
   - 타이머 내 재연결 시 기존 playerId로 복구
   - 손패, 칩, 플레이어 순서 유지
   - 재연결 시 전체 게임 상태 전송

2. **비밀방 시스템**
   - 방 생성 시 password 설정 가능
   - joinRoom 시 password 검증
   - 방 목록에 isPrivate 필드로 표시

3. **강퇴 시스템**
   - 방장(hostPlayerId)만 사용 가능
   - 게임 시작 전에만 강퇴 가능
   - 강퇴당한 플레이어는 kicked 이벤트 수신

4. **자동 방 삭제**
   - 방이 비면 자동 삭제
   - 메모리 효율적 관리

### 2. 게임 엔진 시스템

**위치**: `src/game/game-engine.factory.ts`, `src/game/engines/`

팩토리 패턴으로 다양한 게임 타입을 지원합니다.

**GameEngine 인터페이스** (`game-engine.interface.ts`):
- `gameType: string` - 게임 타입 식별자
- `createDeck(): Card[]` - 초기 덱 생성
- `drawCard(state: GameState): { state: GameState; drawn: Card }` - 카드 뽑기 로직

**현재 구현된 엔진:**
- `StandardCardEngine` (gameType: 'gang'): 표준 52장 카드 덱 (하트, 다이아, 스페이드, 클럽)

### 3. 타입 정의 (`game.types.ts`)

**Card**
```typescript
{
  type: 'clubs' | 'diamonds' | 'hearts' | 'spades'
  value: number  // 1-13
  image: string  // 카드 이미지 URL
  name: string   // 카드 이름 (예: 'A', '2', 'K')
}
```

**Chip**
```typescript
{
  number: number        // 칩 번호 (1, 2, 3, ...)
  state: number         // 0: white, 1: yellow, 2: orange, 3: red
  owner: string | null  // playerId of owner, null if not selected
}
```

**GameState**
```typescript
{
  deck: Card[]
  hands: Map<WebSocket, Card[]>
  currentTurn: number
  playerOrder: WebSocket[]
  openCards: Card[]        // 공개된 카드
  chips: Chip[]            // 칩 목록
  currentStep: number      // 1, 2, 3, 4 (오픈카드 0, 3, 4, 5장)
  playerReady: Set<string> // 준비 완료한 플레이어 playerId
  nextRoundReady: Set<string>
  previousChips: Map<string, number[]>  // playerId → 이전 라운드 칩
  winLossRecord: Map<string, boolean[]> // playerId → 승/패 기록 (최대 5개)
}
```

**Room**
```typescript
{
  name: string
  gameType: string
  clients: Set<WebSocket>
  playerIds: Map<WebSocket, string>  // socket → playerId
  nicknames: Map<WebSocket, string>  // socket → nickname
  disconnectTimers: Map<string, Timer>  // playerId → timer
  state: GameState
  createdAt: Date
  gameStarted: boolean
  gameFinished: boolean
  lastGameResults?: PlayerResult[]
  gameOver?: boolean
  gameOverResult?: 'victory' | 'defeat' | null
  hostPlayerId: string
  hostNickname: string
  password?: string  // 비밀방인 경우
}
```

## Gang 게임 로직

**게임 진행 단계:**
1. 최소 3명 플레이어 필요
2. 각 플레이어 2장 카드 지급
3. 4단계에 걸쳐 오픈 카드 공개
   - Step 1: 0장
   - Step 2: 3장
   - Step 3: 4장
   - Step 4: 5장
4. 각 단계마다 칩 선택 후 준비
5. 모든 플레이어 준비 시 다음 단계 진행
6. 최종 단계에서 칩 순서대로 족보 검증

**칩 시스템:**
- 칩을 선택하면 해당 플레이어의 소유가 됨
- 다른 플레이어의 칩도 선택 가능 (빼앗기)
- 칩을 빼앗기거나 변경하면 준비 상태 자동 해제

**승리 조건:**
- 칩 번호 순서대로 족보가 올라가야 성공
- 예: 1번 칩 < 2번 칩 < 3번 칩 (족보 기준)

## 명령어

```bash
# 개발 서버 실행 (watch mode)
npm run start:dev

# 빌드
npm run build

# 프로덕션 실행
npm run start:prod

# 테스트
npm run test          # 유닛 테스트
npm run test:e2e      # E2E 테스트
npm run test:cov      # 커버리지

# 린트 및 포맷
npm run lint          # ESLint 실행 및 자동 수정
npm run format        # Prettier 포맷팅
```

## 새 게임 엔진 추가 방법

1. `src/game/engines/` 에 새 엔진 파일 생성 (예: `new-game.engine.ts`)
2. `GameEngine` 인터페이스 구현
3. `@Injectable()` 데코레이터 추가
4. `game.module.ts`의 `ENGINES` 배열에 추가
5. 필요한 경우 `game.types.ts`에 게임별 타입 추가

예시:
```typescript
@Injectable()
export class NewGameEngine implements GameEngine {
  readonly gameType = 'new-game';

  createDeck(): Card[] {
    // 덱 생성 로직
  }

  drawCard(state: GameState) {
    // 카드 뽑기 로직
  }
}
```

## 환경 변수

- `PORT`: 서버 포트 (기본값: 9030)

## 배포

- **GCP App Engine** 배포 가이드: `GCP-DEPLOY-GUIDE.md` 참조
- **Docker**: `Dockerfile` 사용 가능
- 배포 스크립트: `deploy-gcp.sh`, `quick-deploy.sh`
