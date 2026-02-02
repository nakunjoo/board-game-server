# Gang Server

NestJS 기반의 실시간 카드 게임 서버입니다.

## 기술 스택

- **Framework**: NestJS v11
- **WebSocket**: `@nestjs/platform-ws` (ws 기반)
- **Language**: TypeScript
- **Test**: Jest
- **Linter/Formatter**: ESLint, Prettier

## 프로젝트 구조

```
src/
├── main.ts                 # 앱 엔트리포인트 (포트 3000, WebSocket 어댑터 설정)
├── app.module.ts           # 루트 모듈
├── app.controller.ts       # 기본 컨트롤러
├── app.service.ts          # 기본 서비스
└── game/
    ├── game.module.ts              # 게임 모듈 (엔진 팩토리, 게이트웨이 등록)
    ├── game.gateway.ts             # WebSocket 게이트웨이 (방 관리, 게임 로직)
    ├── game.types.ts               # 타입 정의 (Card, Room, GameState 등)
    ├── game-engine.interface.ts    # 게임 엔진 인터페이스
    ├── game-engine.factory.ts      # 게임 엔진 팩토리
    └── engines/
        └── standard-card.engine.ts # 표준 카드 덱 엔진 (gang 게임 타입)
```

## 주요 컴포넌트

### WebSocket Gateway (`/ws`)

게임의 모든 실시간 통신을 처리합니다.

**지원 이벤트:**
- `createRoom`: 방 생성 (name, nickname, gameType)
- `joinRoom`: 방 입장 (name, nickname)
- `leaveRoom`: 방 퇴장 (name)
- `drawCard`: 카드 뽑기 (roomName, nickname)
- `roomMessage`: 방 내 메시지 전송
- `getRooms`: 방 목록 조회

**특징:**
- 재연결 Grace Period: 5초 이내 재연결 시 기존 상태 유지
- 방이 비면 자동 삭제

### 게임 엔진 시스템

팩토리 패턴을 사용하여 다양한 게임 타입을 지원합니다.

**GameEngine 인터페이스:**
- `gameType`: 게임 타입 식별자
- `createDeck()`: 덱 생성
- `drawCard(state)`: 카드 뽑기 로직

**현재 구현된 엔진:**
- `StandardCardEngine` (gameType: 'gang'): 표준 52장 카드 덱

### 타입 정의

- `Card`: type (clubs/diamonds/hearts/spades), value (1-13), image, name
- `Room`: 방 정보 (clients, nicknames, state, disconnectTimers)
- `GameState`: 덱, 플레이어 핸드, 현재 턴, 플레이어 순서

## 명령어

```bash
# 개발 서버 실행
npm run start:dev

# 빌드
npm run build

# 프로덕션 실행
npm run start:prod

# 테스트
npm run test
npm run test:e2e

# 린트
npm run lint

# 포맷
npm run format
```

## 새 게임 엔진 추가 방법

1. `src/game/engines/` 에 새 엔진 파일 생성
2. `GameEngine` 인터페이스 구현
3. `@Injectable()` 데코레이터 추가
4. `game.module.ts`의 `ENGINES` 배열에 추가

## 환경 변수

- `PORT`: 서버 포트 (기본값: 9030)
