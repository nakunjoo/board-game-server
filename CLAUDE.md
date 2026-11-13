# The Gang Server - Backend

NestJS 기반 실시간 멀티플레이어 카드 게임 서버

## Supabase

DB 스키마, RLS 정책, 트리거 SQL → [SUPABASE_SCHEMA.md](../SUPABASE_SCHEMA.md) 참조

## 변경 이력

| 날짜 | 내용 |
|------|------|
| 2026-11-13 | **끄적끄적(`drawing`) 추가** — `games/drawing/drawing.handler.ts`·`drawing.words.ts`(제시어 약 300개). 제시어 선택·그림 중계·정답 판정·점수·힌트·타이머 모두 서버. 게이트웨이: `drawingStart`/`drawingChoose`/`drawingStroke`/`drawingGuess` 등록, 덱 없는 게임으로 방 생성, `startGame`은 무시, 끊김/재접속 때 `handleDisconnect`/`handleReconnect`, `roomJoined`에 `buildDrawingState`. `game.types.ts`에 `DrawingState`/`DrawingStroke`, `Room.drawing`/`drawingGameOverResult`. DB `game_type`에 `'drawing'` 추가 필요(SUPABASE_SCHEMA.md 마이그레이션) — 넣기 전엔 세션 기록만 실패하고 게임은 된다 |
| 2026-11-11 | Gang: 진행 중 혼자 남으면 판을 접고 대기 상태로 돌아가 `gangGameCancelled`를 보낸다(혼자서 다음 라운드가 시작되던 문제, 앱 미반영). Skulking: `tigressDeclared`는 Tigress 카드일 때만 저장·전송 |
| 2026-11-09 | **새로고침 후속** — 유예 중 재입장 때 `userJoined` 닉네임을 클라이언트 값 대신 방에 저장된 값으로 보냄(프로필 응답 전 로그인 ID가 노출되던 문제). `buildSkulkingState`에 `skulkingNextRoundTimeLeft`(`skulkingNextRoundAt` 기준), `buildCasinoState`에 `casinoPendingStake` 추가 |
| 2026-11-09 | **재검사 후속** — Skulking 재시작 시 `skulkingRound` 초기화, 10라운드 종료 대기 타이머를 `skulkingNextRoundTimer`로 관리해 재시작 때 해제, 트릭 항목에 닉네임 저장. Spice·Skulking은 선뽑기 중 혼자 남으면 `firstDrawCancelled`/`skulkingFirstDrawCancelled`로 대기 상태 복귀(앱 미반영). 종료 결과 복원은 그 판 참가자에게만. Casino 이탈 시 투표 재계산 |
| 2026-11-09 | **이탈 처리와 방장 위임** — `GameContext.leaveRoom`이 방장을 접속 중인 다음 사람에게 넘기고 `userLeft`에 `hostPlayerId`/`hostNickname`을 싣는다. 게이트웨이 `removeFromRoom`이 나가기·끊김 유예 만료·강퇴 뒤 게임별 `handlePlayerLeft`를 호출해 준비 집계, 선뽑기, 턴, 도전 페이즈, 비드, 트릭 순서를 다시 맞춘다. 방이 비면 타이머를 모두 해제. `replaceClient`는 Map 순서를 유지 |
| 2026-11-09 | **덱 숨김** — 클라이언트로 보내는 덱은 `ctx.hiddenDeck(room)`(장수만 같은 가짜 카드). Spice 획득 더미 내용은 본인 것만 전송 |
| 2026-11-09 | **Gang** — `startGame` 방장·진행 중 검사, `successCount` 초기화, 라운드 종료 후 `selectChip`/`playerReady` 무시, `testSuccess`/`testFail`/`drawCard`는 `NODE_ENV=development`의 Gang 방에서만 동작, 스트레이트는 중복 숫자를 합쳐 가장 높은 5연속의 탑으로 판정(`getStraightTop`), `roomJoined`에 `nextRoundReady` 추가 |
| 2026-11-09 | **Spice** — DB 순위를 점수 기준으로 저장, 게임 종료 멱등 처리와 종료 후 `playCard`/`pass` 차단, 진행 중 `startGame` 차단, 선언 향신료·숫자 검증, 선뽑기 20초 후 자동 뽑기, 도전 결과 표시 3초를 턴 시계에서 제외, 혼자 남으면 `reason: 'playerLeft'`로 종료, 종료 결과를 `roomJoined`로 복원(`lastGameResults`, `spiceGameOverMeta`) |
| 2026-11-09 | **Skulking** — 다음 라운드를 서버가 8초 뒤 시작(`skulkingNextRound`는 라운드 사이에만 유효), 거부된 카드 요청이 자동 제출 타이머를 지우지 않음, 트릭 완료 후 재제출 차단, 비드·`cardIndex`·Tigress 선언 검증, 선뽑기 20초 후 자동 뽑기, 혼자 남으면 종료, 종료 결과 `skulkingGameOverResult` 복원 |
| 2026-11-09 | **Casino** — 시간 제한 타이머가 같은 이름의 새 방을 끝내지 않음, 종료 시 결과가 안 온 베팅금 환불, 대출 조건을 `잔액 < max(초기금 5%, 100)`으로 변경(100 미만 잔액 고착 해소), 종료 결과 `casinoLastResult` 복원 |
| 2026-11-09 | **GitHub Actions 자동 배포 추가** (`.github/workflows/deploy.yml`) — main push(문서만 바뀐 경우 제외) 또는 수동 실행 시 amd64 이미지를 빌드해 GCP VM 컨테이너를 교체하고 `/api` 응답을 확인. 고정 SSH 키로 `deploy` 계정에 접속한다(VM의 guest agent가 멈춰 있어 gcloud 메타데이터 키는 적용되지 않음). Secrets: `VM_HOST`, `VM_SSH_USER`, `VM_SSH_KEY`, `VM_KNOWN_HOSTS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`(`notify` job이 성공·실패·종료 코드를 텔레그램으로 전송, 없으면 건너뜀). 환경변수 원본은 VM의 `/home/deploy/.env.production`. 컨테이너 로그는 10MB × 3개로 제한. 배포하면 메모리의 방이 전부 사라진다 |
| 2026-11-09 | **미처리 rejection으로 프로세스가 죽던 문제 수정** — 게이트웨이가 async 핸들러를 `return` 없이 호출해 Nest가 예외를 잡지 못했고, `{"event":"casinoStart"}`처럼 data 없는 메시지 하나로 Node 22가 종료됐음. `startGame`/`casinoStart`가 promise를 반환하도록 변경(새 async 핸들러도 반드시 `return`), `main.ts`에 `unhandledRejection` 로깅 추가, 카지노 방의 `startGame`은 Gang 핸들러로 넘기지 않음 |
| 2026-11-09 | **스컬킹 10라운드 종료 수정** — 클라이언트는 마지막 라운드에 `skulkingNextRound`를 보내지 않아 `endGame`이 호출되지 않았음. `endRound`가 마지막 라운드면 5초 뒤 서버에서 직접 종료. `endGame`은 중복 실행을 막고 `gameStarted = false` 처리, `handleStartGame`은 `gameFinished`/`gameOver` 초기화 |
| 2026-11-09 | `joinRoom`: 비밀번호 검사를 Case 1·2(재연결) 뒤로 이동 — 기존 멤버가 재연결할 때 거부되어 30초 뒤 퇴장되던 문제 수정. 신규 입장은 계속 검사 |
| 2026-11-09 | 접속 인증 완료 시 `authenticated` 이벤트 전송(웹이 재입장 시점으로 사용). 토큰 검증 중 끊긴 소켓은 등록하지 않음 |
| 2026-11-09 | `database/supabase-admin.ts`: 토큰 검증용 Supabase 클라이언트 싱글턴(`autoRefreshToken: false`). 기존엔 검증마다 `createClient`를 호출해 해제되지 않는 타이머가 인스턴스마다 쌓였음 |
| 2026-10-08 | **Spice 턴 타이머를 서버로 이동** — 예전엔 턴 주인 클라이언트가 30초 후 직접 `pass`를 보냈고 서버엔 턴 타이머가 없어서, 턴 주인이 화면을 잠그거나 앱을 전환하면(iOS) 판이 영원히 멈췄음. `startTurn`/`clearTurnTimer`/`handleTurnTimeout` 추가, 턴이 바뀌는 4곳(`startMainGame`·`resolveChallengeExpired`·`applyPass`·`handleChallenge`)에서 `startTurn` 호출, 카드 낼 때·게임 종료 시 정지. `TURN_TIME_MS`(30초) + 1.5초 여유 후 자동 패스(`cardPassed.auto = true`) |
| 2026-10-08 | Spice: 턴 주인이 방에서 빠지면(재연결 유예 초과) 퇴장 처리가 `playerOrder`에서만 지우고 `currentTurnPlayerId`는 남겨 판이 멈추던 문제 — 턴 시간 초과 시 남은 첫 플레이어에게 턴을 넘김 |
| 2026-10-08 | Spice `handlePass`: 도전 페이즈 가드 추가 (`playCard`엔 있고 pass엔 없어서, 도전 중 카드 낸 사람의 pass가 통과해 카드를 더 받고 턴이 꼬였음). 패스 본체는 `applyPass`로 분리해 자동 패스와 공유. 자동 패스 직후 5초 안에 같은 사람이 보낸 늦은 pass는 에러 없이 무시 (구버전 클라 호환) |
| 2026-10-08 | Spice 도전: `challengePhase` 브로드캐스트에 `challengeTimeLimitMs` 추가 (클라 카운트다운을 서버 데드라인에 맞추기 위함). 닫힌 페이즈에 온 도전은 `error`('도전 페이즈가 아닙니다' → 클라 alert) 대신 개인 `challengeTooLate` 전송 — 닫히는 경우는 만료 or 남이 먼저 도전뿐이라 사용자 잘못이 아님. `CHALLENGE_TIME_MS`/`TURN_TIME_MS` 상수화, 게이트웨이 재연결 남은시간 계산도 이 상수 사용 |
| 2026-10-08 | **카지노 서버 검증 추가** (기존엔 클라이언트 값을 그대로 반영해 누구나 잔액·기록 조작 가능): `casinoStart` 초기자금/시간은 UI 선택지만 / `casinoBetPlace` 양의 정수만(음수 베팅이 잔액을 늘리던 버그) / `casinoResult`는 `0 ≤ delta ≤ 묶인 베팅액(casinoPendingStakes) × MAX_PAYOUT_MULTIPLIER[게임]`, `gameType`은 서버가 아는 현재 게임과 일치해야 함 / 게임 전환 시 묶인 베팅 몰수 / `casinoLoan`은 잔액 < 초기금 5%일 때만(반복 호출로 무제한 대출 가능했음) / `casinoForceEnd`는 서버에서 `isAdmin` 확인(아무나 판을 끝낼 수 있었음) |
| 2026-10-08 | 레거시 독립 블랙잭 잔재 제거 — `game.types.ts`의 `bj*` 상태 필드·`BjHand`·`bjBotSockets`, `game.context.ts`의 봇 전용 방 정리 분기(`bjBotSockets`가 어디서도 할당되지 않아 실행된 적 없음). DB `game_type` 유니온의 `'blackjack'`은 과거 기록 호환용으로 유지 |
| 2026-10-08 | **테스트 추가**: `casino.handler.spec.ts`(19), `spice.handler.spec.ts`(12), 공용 헬퍼 `test/game-test-utils.ts`(빌드 제외 위치). `npm test` |
| 2026-08-13 | **Gang 결과 판정 버그 수정** |
| 2026-08-13 | `game/games/gang/gang.handler.ts`: `evaluateHand`의 "하이카드" 폴백에서 `tiebreakers`가 보드 공유 카드까지 섞인 `allSorted` 기준으로 계산되던 버그 수정 — 내 카드만(`myCardsSorted`) 기준으로 변경, 미사용 `allSorted` 변수 제거. 이 값이 `checkWinCondition`(실제 성공/실패 판정)에 직접 쓰여서, 칩 번호 순서와 족보 순서가 실제로는 맞는데도 실패로 잘못 판정되는 버그가 있었음 |
| 2026-08-13 | **구글 로그인 제거 → 아이디/닉네임/비밀번호 회원가입 전환** |
| 2026-08-13 | `auth/` 모듈 신규 생성 (`auth.controller.ts`, `auth.service.ts`, `auth.module.ts`) — `POST /api/auth/signup`(공개, 인증 불필요). 아이디 4~20자(영문 소문자/숫자/`_`), 닉네임 1~6자, 비밀번호 6자 이상 검증. Supabase Admin API로 `${id}@bobogang.local` 합성 이메일 계정을 `email_confirm: true`로 생성(이메일 인증 절차 생략) 후 `profiles` 테이블에 선택한 닉네임 반영. 닉네임 중복 시 `ConflictException` |
| 2026-08-13 | `app.module.ts`: `AuthModule` 등록 |
| 2026-08-13 | **일일 가상 회원 자동 생성 (Supabase 휴면 방지)** |
| 2026-08-13 | `@nestjs/schedule` 추가, `app.module.ts`에 `ScheduleModule.forRoot()` 등록 |
| 2026-08-13 | `keepalive/keepalive.service.ts` 신규 — 매일 새벽 3시(서버 시스템 시간 기준) `AuthService.signup`을 재사용해 랜덤 아이디/닉네임(접두어 1자+명사 1자+숫자 4자리, 예: "봄손1234")/비밀번호로 가상 회원 1명 자동 생성. 실패 시 최대 5회 재시도. Supabase 프로젝트가 1주일 무활동으로 일시 정지되는 것을 방지하기 위함 |
| 2026-08-13 | **버그 발견**: `admins` 테이블에서 `granted_by` 컬럼이 (사용자가 직접) 삭제되어 있어 `GET /api/profile`이 관리자 여부 조회 시 500 에러 발생 — 모든 사용자에게 영향. `ALTER TABLE admins ADD COLUMN granted_by uuid;`로 Supabase SQL 에디터에서 직접 복구 (코드 변경 아님) |
| 2026-05-11 | **카지노 게임 기록 데이터 보강** |
| 2026-05-11 | `game/games/casino/casino.handler.ts`: `finishGame`에서 각 플레이어 `extra`에 `playersHistory`(전원의 playerId/nickname/history/rank 배열) 및 `myPlayerId` 추가 저장 — MyPage 차트에서 멀티플레이어 라인 표시용 |
| 2026-05-11 | `game/games/casino/casino.handler.ts`: `finishGame`에서 대출 상환 후 최종 잔액(`finalBalance`)이 마지막 히스토리 포인트와 다를 경우 끝점 추가 — 음수 최종 잔액이 차트에 반영됨

| 날짜 | 내용 |
|------|------|
| 2026-05-11 | **게임 기록 상세 데이터 보강** |
| 2026-05-11 | `profile/profile.service.ts`: `getHistory`에서 같은 세션 모든 플레이어 row를 `In(sessionIds)`로 추가 조회 → `players` 배열로 반환 (rank 기준 정렬, `isMe` 플래그 포함) |
| 2026-05-11 | `game/games/skulking/skulking.handler.ts`: `extra`에 `roundHistory` 추가 — `roundBidTrickHistory`를 플레이어별로 변환한 `{ round, bid, tricks, score }[]` |
| 2026-05-11 | **카지노 대출 시스템 추가** |
| 2026-05-11 | `game/game.types.ts`: `GameState`에 `casinoLoans?: Map<string, number>` 추가 (playerId → 누적 대출금) |
| 2026-05-11 | `game/games/casino/casino.handler.ts`: `handleLoan` 추가 — 대출금 잔액 반영, 누적 기록, 본인에게 `casinoLoanConfirmed` 전송, 전체에게 `casinoBalanceUpdate` 브로드캐스트. `finishGame`에서 `totalLoan * 1.1` 차감 후 finalBalance 계산 (음수 허용). `handleStart`/`finishGame`에 `casinoLoans` 초기화/정리 추가 |
| 2026-05-11 | `game/game.gateway.ts`: `casinoLoan` 이벤트 핸들러 추가 |
| 2026-05-11 | **카지노 게임 추가** |
| 2026-05-11 | `game/games/casino/casino.handler.ts` 신규 생성 — `casinoStart`/`casinoBetPlace`/`casinoResult`/`casinoSwitchGame`/`casinoVoteEnd` 이벤트 처리. `handleBetPlace`: 잔액에서 베팅금 차감. `handleResult`: 잔액에 delta 추가 + 히스토리 포인트 기록. `finishGame`: 타이머 만료 또는 과반수 투표 시 종료. `buildCasinoState`: 재연결 시 카지노 전체 상태 복원 |
| 2026-05-11 | `game/game.types.ts`: `GameState`에 카지노 전용 필드 추가 (`casinoBalances`, `casinoCurrentGames`, `casinoHistory`, `casinoGamesPlayed`, `casinoVotes`). `Room`에 `casinoInitialBalance`, `casinoTimeLimit`, `casinoStartedAt`, `casinoTimer` 추가 |
| 2026-05-11 | `game/game.module.ts`: `CasinoHandler` 등록 |
| 2026-05-11 | `game/game.gateway.ts`: `CasinoHandler` 주입. `casinoStart`/`casinoBetPlace`/`casinoResult`/`casinoSwitchGame`/`casinoVoteEnd` 이벤트 핸들러 추가. `roomJoined`에 casino 재연결 상태(`casinoStarted`, `casinoInitialBalance`, `casinoTimeLimit`, `casinoRemainingSeconds`, `casinoPlayers`, `casinoVotes`) 포함 |
| 2026-05-11 | `database/database.service.ts`: `CreateSessionParams.gameType`에 `'casino'` 추가 |
| 2026-05-11 | **카지노 WebSocket 이벤트** — 클라이언트→서버: `casinoStart`(roomName, timeLimit, initialBalance) / `casinoBetPlace`(roomName, amount) / `casinoResult`(roomName, delta, gameType) / `casinoSwitchGame`(roomName, game) / `casinoVoteEnd`(roomName). 서버→클라이언트: `casinoStarted`(initialBalance, timeLimit, players) / `casinoBalanceUpdate`(playerId, balance, delta, historyPoint) / `casinoPlayerUpdate`(playerId, currentGame) / `casinoVoteStatus`(votes, needed, total) / `casinoGameOver`(players 순위, 결과) |
| 2026-04-29 | **게임타입 관리 + 신고 관리 추가** |
| 2026-04-29 | `entities/game-type.entity.ts` 신규 생성 — `game_types` 테이블 TypeORM 엔티티 (`id TEXT PK`, `label`, `is_active`, `sort_order`, `created_at`) |
| 2026-04-29 | `game-types/` 모듈 신규 생성 — `GameTypesService`(공개용 `getActiveGameTypes` + 관리자용 전체 CRUD), `GameTypesController`(공개 `GET /api/game-types` — 인증 불필요), `GameTypesModule`(exports GameTypesService) |
| 2026-04-29 | `manager/manager.service.ts`: 게임타입 CRUD (`getAllGameTypes`, `createGameType`, `updateGameType`, `deleteGameType`) + 신고 관리 (`getReports`, `updateReportStatus`, `banUser`, `unbanUser`) 추가. Report 엔티티 inject, GameTypesService 의존성 주입 |
| 2026-04-29 | `manager/manager.controller.ts`: `GET/POST/PUT/DELETE /api/manager/game-types`, `GET /api/manager/reports`, `PUT /api/manager/reports/:id/status`, `POST /api/manager/users/:userId/ban`, `POST /api/manager/users/:userId/unban` 추가 |
| 2026-04-29 | `manager/manager.module.ts`: `Report` 엔티티, `GameTypesModule` import 추가 |
| 2026-04-29 | `app.module.ts`: `GameType` 엔티티, `GameTypesModule` 등록 |
| 2026-04-29 | **Supabase 마이그레이션 필요**: `CREATE TABLE game_types (id TEXT PK, label TEXT, is_active BOOL DEFAULT true, sort_order INT DEFAULT 0, created_at TIMESTAMPTZ)` + 기본 3개 행 INSERT (gang/spice/skulking) |
| 2026-04-29 | **관리자 시스템 추가**: `admins` 테이블 기반 관리자 관리 (`user_id PK`, `granted_by`, `created_at`) |
| 2026-04-29 | `entities/admin.entity.ts` 신규 생성 — `admins` 테이블 TypeORM 엔티티 |
| 2026-04-29 | `profile.service.ts`: `getProfile` 응답에 `isAdmin: boolean` 추가 (`admins` 테이블 조회). `isAdmin(userId)` 메서드 추가 |
| 2026-04-29 | `profile.module.ts`: `Admin` 엔티티 등록, `ProfileService` export 추가 |
| 2026-04-29 | `manager/` 모듈 신규 생성 — `ManagerGuard`(관리자 체크), `ManagerService`(어드민 CRUD + 닉네임 검색), `ManagerController`(`GET /api/manager/admins`, `POST/DELETE /api/manager/admins/:userId`, `GET /api/manager/users/search`) |
| 2026-04-29 | `app.module.ts`: `Admin` 엔티티, `ManagerModule` 등록 |
| 2026-04-28 | **WebSocket 인증 추가 + playerId = userId 전환**: WS 연결 시 `?token=` 쿼리파람으로 Supabase 토큰 검증 (60s 캐시). `handleConnection`에서 userId를 `ctx.clientAuth`에 저장. `createRoom`/`joinRoom` payload의 playerId/userId 무시 → 서버가 `clientAuth.get(client)`로 직접 결정 |
| 2026-04-28 | `game.context.ts`: `clientAuth: Map<WebSocket, string>` 추가 (소켓 → userId). `handleDisconnect`에서 자동 정리 |
| 2026-04-28 | `game.gateway.ts`: `handleConnection(client, req: IncomingMessage)` async로 변경. `validateToken()` private 메서드 추가 (supabase admin `auth.getUser` + 60s TOKEN_CACHE). `handleCreateRoom`/`handleJoinRoom` payload 타입에서 `playerId`/`userId` 제거 |
| 2026-04-28 | `game.types.ts`: `Room` 인터페이스에서 `playerUserIds: Map<string, string>` 제거 (playerId = userId이므로 불필요). `playerIds` 주석을 "Supabase auth UUID"로 수정 |
| 2026-04-28 | `gang.handler.ts` / `spice.handler.ts` / `skulking.handler.ts`: `insertPlayerResults` 호출 시 `userId: room.playerUserIds.get(p.playerId) ?? null` → `userId: p.playerId` 로 변경 (playerId가 곧 userId) |
| 2026-04-28 | `game.types.ts`: `Room` 인터페이스에 `voiceParticipants?: Map<string, { playerId: string; nickname: string }>` 필드 추가 |
| 2026-04-28 | `game.gateway.ts`: 음성 통화 WebRTC 시그널링 핸들러 3개 추가 — `voiceJoin`(방 참여자 목록 반환 + 브로드캐스트), `voiceLeave`(참여자 제거 + 브로드캐스트), `voiceSignal`(offer/answer/ICE 특정 플레이어에게 중계). 시그널은 방 단위로 격리됨 |
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

**서버 → 클라이언트:** `firstDrawStarted`, `firstDrawResult`, `firstDrawProgress`, `firstDrawFinished`, `gameStarted`, `cardPassed`(`auto`: 서버 자동 패스 여부), `myHandUpdate`, `challengePhase`(`challengeTimeLimitMs` 포함), `challengeExpired`, `challengeResult`, `challengeTooLate`(개인, 한 발 늦은 도전), `spiceGameOver`

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

## 끄적끄적 (`drawing.handler.ts`)

3~6명(관리자는 우회). 한 명씩 돌아가며 그리고, 모두 한 번씩 그리면 한 바퀴. 방장이 `drawingStart`로 바퀴 수(1/2/3)와 그리는 시간(60/80/100초)을 정한다.

**한 턴:** `choose`(제시어 3개 중 고르기, 10초 — 못 고르면 자동, 그리는 사람이 끊겨 있으면 넘김) → `draw`(절반 지나면 초성, 10초 남으면 한 글자 공개) → 모두 맞히거나 시간 끝 → `reveal`(정답 공개 4초) → 다음 사람. 나간 사람은 순서에서 건너뛴다.

**점수:** 맞힌 사람 `max(40, 100 - 60 × 경과비율)` + 첫 정답 20, 그린 사람은 한 명 맞힐 때마다 30.

**정답 판정:** 공백 제거·소문자로 비교. 한 글자 차이면 `drawingClose`를 보낸 사람에게만(남에게는 큰 힌트라 안 보냄). 이미 맞힌 사람의 말은 맞힌 사람과 그리는 사람에게만(`scope: 'guessed'`). 그리는 사람이 정답이 들어간 말을 하면 `drawingBlocked`.

**그림:** 좌표는 그림판 크기와 무관한 0~1000 정수(그림판은 세로 3:4 고정), 굵기는 가로의 1/1000 단위. 조각(`b` 시작 / `m` 이어 그리기 / `u` 되돌리기 / `x` 전체 지우기)을 검증해 저장하고 그리는 사람 외에게 중계한다. 색·굵기는 허용 목록만, 한 턴 점 20,000개·메시지당 조각 200개 상한. 턴마다 비운다.

**끊김:** 그리는 사람이 10초(`DRAWER_AWAY_MS`) 넘게 끊기면 턴 종료(`reason: 'drawerAway'`). 모두 맞혔는지는 접속 중인 사람만 센다. 30초 유예가 지나 방에서 빠지면 `handlePlayerLeft` — 그리는 사람이면 턴 종료, 2명 미만이면 `notEnough`로 게임 종료.

**클라이언트 → 서버:** `drawingStart`(rounds, drawTimeSec), `drawingChoose`(index), `drawingStroke`(ops), `drawingGuess`(text, 100자)

**서버 → 클라이언트:**
| 이벤트 | 내용 |
|--------|------|
| `drawingStarted` | 시작 (totalRounds, drawTimeSec, turnOrder, scores) |
| `drawingTurn` | 새 턴 (round, drawerId, drawerNickname, timeLimitMs) |
| `drawingChoices` | 제시어 후보 — 그리는 사람에게만 |
| `drawingDrawStart` | 그리기 시작 (hint: 글자별 null/초성/글자, timeLimitMs) |
| `drawingWord` | 고른 제시어 — 그리는 사람에게만 |
| `drawingStroke` | 그림 조각 중계 (ops) — 그리는 사람 제외 |
| `drawingHint` | 힌트 갱신 (hint) |
| `drawingChat` | 채팅 (playerId, nickname, text, scope) |
| `drawingCorrect` | 정답 (playerId, gained, order, guessed, totalGuessers, scores) — 정답 글자는 없음 |
| `drawingClose` / `drawingBlocked` | 아까운 답 / 정답 누설 차단 — 보낸 사람에게만 |
| `drawingTurnEnd` | 턴 종료 (reason: time·allGuessed·drawerLeft·drawerAway, word — 고르기 전이면 null, gains, scores, timeLimitMs) |
| `drawingPresence` | 연결 끊김/복귀 (playerId, connected) |
| `drawingGameOver` | 종료 (reason: finished·notEnough, ranking) |

**재연결:** `roomJoined`의 `drawing`(진행 상태 + 지금까지의 `strokes`, 남은 시간 `timeLeftMs`, 그리는 사람에게만 `word`/`choices`) 또는 `drawingGameOver`(끝난 결과).

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

## 타이머 동기화 / 턴 타이머 (Spice)

턴 제한은 **서버가 집행**한다. `currentTurnPlayerId`가 바뀌는 모든 지점에서 `startTurn(roomName, room)`을 호출한다 — `turnStartedAt = Date.now()` 기록 + `spiceTurnTimer` 재설정.
- `startMainGame`: 게임 시작 시 첫 플레이어 턴
- 카드 낼 때: `turnStartedAt = null` + `clearTurnTimer` (도전 페이즈 중 턴 타이머 정지)
- `resolveChallengeExpired`: 도전 페이즈 만료 후 다음 턴
- `applyPass`: 패스(사용자/자동) 후 다음 턴
- `handleChallenge`: 도전 결과 후 패배자 턴
- `finishSpiceGame`: `clearTurnTimer`

`handleTurnTimeout`: `TURN_TIME_MS + TURN_TIMEOUT_GRACE_MS` 뒤 실행. 그 사이 턴이 넘어갔거나 도전 페이즈면 무시. 턴 주인이 `playerOrder`에 있으면 `applyPass(..., auto=true)`, 없으면(퇴장) `playerOrder[0]`에게 턴을 넘기고 `cardPassed(auto)` 브로드캐스트.

> **새로 턴을 넘기는 코드를 추가할 때는 `turnStartedAt`을 직접 건드리지 말고 반드시 `startTurn`을 쓸 것.** 안 그러면 그 턴은 자동 패스가 안 걸려 판이 멈출 수 있다.

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
