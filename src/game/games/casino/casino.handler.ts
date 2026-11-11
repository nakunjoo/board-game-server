import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { Room } from '../../game.types';
import { GameContext } from '../../game.context';
import { DatabaseService } from '../../../database/database.service';

/**
 * '카지노' 게임 전용 이벤트 핸들러
 *
 * 서버는 잔액만 관리하는 신뢰 기준점 역할.
 * 실제 게임 로직은 클라이언트에서 처리.
 *
 * 이벤트 (클라이언트 → 서버):
 *   casinoStart       - 게임 시작 (방장 전용)
 *   casinoBetPlace    - 베팅 차감
 *   casinoResult      - 게임 결과 반영 (delta)
 *   casinoSwitchGame  - 현재 플레이 중인 게임 변경
 *   casinoVoteEnd     - 조기 종료 투표
 *   casinoLoan        - 긴급 대출 (잔액이 초기금 5%와 최소 베팅액 중 큰 값 미만일 때만)
 *   casinoForceEnd    - 강제 종료 (관리자 전용)
 *
 * 서버 검증 (클라이언트를 믿지 않는 최소한의 경계):
 *   - 시작 설정은 UI 선택지(ALLOWED_*) 안에서만
 *   - 베팅은 양의 정수 & 잔액 이하, 결과 반영 전까지 casinoPendingStakes에 묶어둠
 *   - 결과(delta)는 0 이상 & '묶인 베팅액 × 게임별 최대 배수' 이하
 *   ※ 판 결과 자체(룰렛 숫자 등)는 클라이언트가 만들기 때문에 상한 안의 조작은
 *     여전히 막을 수 없다. 완전히 막으려면 결과 생성을 서버로 옮겨야 한다.
 *
 * 이벤트 (서버 → 클라이언트):
 *   casinoStarted       - 게임 시작 알림
 *   casinoBalanceUpdate - 잔액 변동 (playerId, balance, delta, historyPoint)
 *   casinoPlayerUpdate  - 플레이어 상태 변경 (playerId, currentGame)
 *   casinoVoteStatus    - 투표 현황 (votes, needed, total)
 *   casinoGameOver      - 게임 종료 (reason, players[])
 */
@Injectable()
export class CasinoHandler {
  /** 설정 모달(웹·앱)이 제공하는 선택지 — 이 외의 값은 거부 */
  static readonly ALLOWED_INITIAL_BALANCES = [1_000, 5_000, 10_000];
  static readonly ALLOWED_TIME_LIMITS = [5 * 60, 10 * 60]; // 초
  /** 미니게임 베팅액이 100 단위라, 이보다 잔액이 적으면 어떤 게임도 시작할 수 없다 */
  static readonly MIN_BET = 100;

  /**
   * 미니게임별 최대 총수령 배수 (원금 포함, 베팅액 대비).
   * casinoResult의 delta가 '결과 미반영 베팅액 × 이 배수'를 넘으면 거부한다.
   * 클라이언트 배당표(웹·앱 동일)와 반드시 맞출 것.
   */
  static readonly MAX_PAYOUT_MULTIPLIER: Record<string, number> = {
    roulette: 36, // 단일 숫자 35배 + 원금
    slots: 100, // 7️⃣7️⃣7️⃣
    blackjack: 2.5, // 내추럴 블랙잭 1.5배 + 원금 (더블은 베팅이 2번 잡혀 2배)
    videopoker: 250, // 로열 플러시
    horseracing: 4,
    mines: 1000, // 15칸
    baccarat: 9, // 타이 8:1 + 원금
  };

  constructor(
    private readonly ctx: GameContext,
    private readonly supabase: DatabaseService,
  ) {}

  // ── handleStart ───────────────────────────────────────────────

  async handleStart(
    data: { roomName: string; timeLimit: number | null; initialBalance: number },
    client: WebSocket,
  ): Promise<void> {
    const { roomName, timeLimit, initialBalance } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.clients.has(client)) {
      this.ctx.sendToClient(client, 'error', {
        message: `'${roomName}' 방에 참여하고 있지 않습니다`,
      });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (playerId !== room.hostPlayerId) {
      this.ctx.sendToClient(client, 'error', {
        message: '방장만 게임을 시작할 수 있습니다',
      });
      return;
    }

    if (room.gameStarted) {
      this.ctx.sendToClient(client, 'error', {
        message: '이미 게임이 시작되었습니다',
      });
      return;
    }

    if (!CasinoHandler.ALLOWED_INITIAL_BALANCES.includes(initialBalance)) {
      this.ctx.sendToClient(client, 'error', { message: '허용되지 않은 초기 자금입니다' });
      return;
    }
    if (timeLimit === null || !CasinoHandler.ALLOWED_TIME_LIMITS.includes(timeLimit)) {
      this.ctx.sendToClient(client, 'error', { message: '허용되지 않은 게임 시간입니다' });
      return;
    }

    // Room 레벨 상태 초기화
    room.gameStarted = true;
    room.gameFinished = false;
    room.gameOver = false;
    room.gameOverResult = null;
    room.casinoLastResult = undefined;

    const now = Date.now();
    room.sessionStartedAt = now;
    room.casinoInitialBalance = initialBalance;
    room.casinoTimeLimit = timeLimit;
    room.casinoStartedAt = now;

    // GameState 레벨 상태 초기화
    room.state.casinoBalances = new Map();
    room.state.casinoCurrentGames = new Map();
    room.state.casinoHistory = new Map();
    room.state.casinoGamesPlayed = new Map();
    room.state.casinoVotes = new Set();
    room.state.casinoLoans = new Map();
    room.state.casinoPendingStakes = new Map();

    const players: { playerId: string; nickname: string; balance: number; currentGame: null }[] = [];

    for (const [c, pid] of room.playerIds) {
      const nickname = room.nicknames.get(c) ?? pid;
      room.state.casinoBalances.set(pid, initialBalance);
      room.state.casinoCurrentGames.set(pid, null);
      room.state.casinoHistory.set(pid, [{ t: 0, b: initialBalance }]);
      room.state.casinoGamesPlayed.set(pid, {});
      players.push({ playerId: pid, nickname, balance: initialBalance, currentGame: null });
    }

    // DB: 세션 생성 (fire-and-forget)
    const sessionStartedAt = new Date(now);
    const playerList = this.ctx.getPlayersWithOrder(room);
    this.supabase
      .createSession(
        { roomName, gameType: 'casino', playerCount: room.clients.size },
        sessionStartedAt,
      )
      .then((sessionId) => {
        if (!sessionId) {
          console.error(`[Casino] createSession 실패 - sessionId가 null. roomName: ${roomName}`);
          return;
        }
        console.log(`[Casino] DB 세션 생성 완료: ${sessionId} (room: ${roomName})`);
        room.supabaseSessionId = sessionId;
        return this.supabase.insertPlayerResults(
          playerList.map((p) => ({
            sessionId,
            userId: p.playerId,
            nickname: p.nickname,
          })),
        ).then(() => {
          console.log(`[Casino] DB 플레이어 결과 행 삽입 완료 (${playerList.length}명)`);
          // pendingAbandonedPlayerIds 처리
          if (room.pendingAbandonedPlayerIds?.length) {
            for (const entry of room.pendingAbandonedPlayerIds) {
              const colonIdx = entry.indexOf(':');
              const reason = entry.slice(0, colonIdx);
              const pid = entry.slice(colonIdx + 1);
              this.supabase.markAbandoned(
                sessionId,
                pid,
                reason as 'voluntary' | 'disconnected',
              );
            }
            room.pendingAbandonedPlayerIds = [];
          }
        });
      })
      .catch((e) => {
        console.error(`[Casino] DB 세션 초기화 중 예외 발생:`, e);
      });

    console.log(
      `[Casino] Game started in room '${roomName}' | initialBalance: ${initialBalance} | timeLimit: ${timeLimit ?? 'unlimited'}`,
    );

    this.ctx.broadcastToRoom(roomName, 'casinoStarted', {
      roomName,
      initialBalance,
      timeLimit,
      players,
    });

    // 타임리밋 타이머 설정 (timeLimit = 초 단위)
    if (timeLimit !== null && timeLimit > 0) {
      const ms = timeLimit * 1000;
      room.casinoTimer = setTimeout(() => {
        if (this.ctx.rooms.get(roomName) === room) this.finishGame(roomName, 'timer');
      }, ms);
    }
  }

  // ── handleBetPlace ────────────────────────────────────────────

  handleBetPlace(
    data: { roomName: string; amount: number },
    client: WebSocket,
  ): void {
    const { roomName, amount } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.gameStarted || !room.state.casinoBalances) {
      this.ctx.sendToClient(client, 'error', { message: '게임이 진행 중이지 않습니다' });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    // 음수·0·소수·NaN 베팅 차단 (음수를 허용하면 '차감'이 곧 '지급'이 된다)
    if (!Number.isInteger(amount) || amount <= 0) {
      this.ctx.sendToClient(client, 'error', { message: '유효하지 않은 베팅 금액입니다' });
      return;
    }

    const currentBalance = room.state.casinoBalances.get(playerId) ?? 0;
    if (amount > currentBalance) {
      this.ctx.sendToClient(client, 'error', { message: '잔액이 부족합니다' });
      return;
    }

    const newBalance = currentBalance - amount;
    room.state.casinoBalances.set(playerId, newBalance);

    // 결과 반영 전까지 묶여 있는 베팅액 — casinoResult 상한 계산 기준
    const pending = room.state.casinoPendingStakes?.get(playerId) ?? 0;
    room.state.casinoPendingStakes?.set(playerId, pending + amount);

    const historyPoint = this.addHistoryPoint(room, playerId, newBalance);

    this.ctx.broadcastToRoom(roomName, 'casinoBalanceUpdate', {
      playerId,
      balance: newBalance,
      delta: -amount,
      historyPoint,
    });
  }

  // ── handleResult ──────────────────────────────────────────────

  handleResult(
    data: { roomName: string; delta: number; gameType: string },
    client: WebSocket,
  ): void {
    const { roomName, delta, gameType } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.gameStarted || !room.state.casinoBalances) {
      this.ctx.sendToClient(client, 'error', { message: '게임이 진행 중이지 않습니다' });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    // delta = 이번 판 총수령액(원금 포함, 0 이상). 게임 로직이 클라이언트에 있으므로
    // 결과 자체를 검증할 수는 없지만, '실제로 건 돈 × 그 게임 최대 배수'를 넘는
    // 금액은 어떤 정상 플레이로도 나올 수 없으므로 거부한다.
    // gameType도 클라이언트 값이라, 서버가 알고 있는 '지금 하는 게임'과 같아야 한다
    // (슬롯을 하면서 지뢰찾기 배수로 결과를 올리는 것 방지)
    const currentGame = room.state.casinoCurrentGames?.get(playerId);
    const maxMultiplier = CasinoHandler.MAX_PAYOUT_MULTIPLIER[gameType];
    const pending = room.state.casinoPendingStakes?.get(playerId) ?? 0;
    if (
      currentGame !== gameType ||
      maxMultiplier === undefined ||
      !Number.isFinite(delta) ||
      delta < 0 ||
      delta > pending * maxMultiplier
    ) {
      const who = room.nicknames.get(client) ?? playerId;
      console.warn(
        `[Casino] Rejected result from '${who}' in '${roomName}': game=${gameType} delta=${delta} pending=${pending}`,
      );
      this.ctx.sendToClient(client, 'error', { message: '유효하지 않은 게임 결과입니다' });
      return;
    }
    const payout = Math.floor(delta);
    room.state.casinoPendingStakes?.set(playerId, 0);

    const currentBalance = room.state.casinoBalances.get(playerId) ?? 0;
    const newBalance = currentBalance + payout;
    room.state.casinoBalances.set(playerId, newBalance);

    // 게임 플레이 횟수 기록
    const gamesPlayed = room.state.casinoGamesPlayed?.get(playerId) ?? {};
    gamesPlayed[gameType] = (gamesPlayed[gameType] ?? 0) + 1;
    room.state.casinoGamesPlayed?.set(playerId, gamesPlayed);

    const historyPoint = this.addHistoryPoint(room, playerId, newBalance);

    this.ctx.broadcastToRoom(roomName, 'casinoBalanceUpdate', {
      playerId,
      balance: newBalance,
      delta: payout,
      historyPoint,
    });
  }

  // ── handleSwitchGame ──────────────────────────────────────────

  handleSwitchGame(
    data: { roomName: string; game: string | null },
    client: WebSocket,
  ): void {
    const { roomName, game } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.gameStarted || !room.state.casinoCurrentGames) {
      this.ctx.sendToClient(client, 'error', { message: '게임이 진행 중이지 않습니다' });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    room.state.casinoCurrentGames.set(playerId, game);
    // 판 도중에 나가면 건 돈은 몰수 — 묶인 베팅액이 다른 게임 결과 상한으로 넘어가지 않게 비운다
    room.state.casinoPendingStakes?.set(playerId, 0);

    this.ctx.broadcastToRoom(roomName, 'casinoPlayerUpdate', {
      playerId,
      currentGame: game,
    });
  }

  // ── handleVoteEnd ─────────────────────────────────────────────

  handleVoteEnd(
    data: { roomName: string },
    client: WebSocket,
  ): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.gameStarted || !room.state.casinoVotes) {
      this.ctx.sendToClient(client, 'error', { message: '게임이 진행 중이지 않습니다' });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    room.state.casinoVotes.add(playerId);
    this.reconcileVotes(room);
  }

  /** 투표 현황을 알리고 필요한 표를 채웠으면 게임을 끝낸다 (이탈로 필요 표 수가 줄 때도 호출) */
  private reconcileVotes(room: Room): void {
    if (!room.state.casinoVotes) return;
    const roomName = room.name;

    const totalPlayers = room.clients.size;
    const needed =
      totalPlayers >= 3
        ? Math.floor(totalPlayers / 2) + 1 // 과반수
        : totalPlayers; // 전원 동의

    const votes = Array.from(room.state.casinoVotes);

    this.ctx.broadcastToRoom(roomName, 'casinoVoteStatus', {
      votes,
      needed,
      total: totalPlayers,
    });

    if (votes.length >= needed) {
      if (room.casinoTimer) {
        clearTimeout(room.casinoTimer);
        room.casinoTimer = undefined;
      }
      this.finishGame(roomName, 'vote');
    }
  }

  // ── handleLoan ────────────────────────────────────────────

  handleLoan(
    data: { roomName: string; amount: number },
    client: WebSocket,
  ): void {
    const { roomName, amount } = data;
    const room = this.ctx.rooms.get(roomName);

    if (!room || !room.gameStarted || !room.state.casinoBalances) {
      this.ctx.sendToClient(client, 'error', { message: '게임이 진행 중이지 않습니다' });
      return;
    }

    const playerId = room.playerIds.get(client);
    if (!playerId) return;

    const initialBalance = room.casinoInitialBalance ?? 10000;
    const maxLoan = Math.floor(initialBalance / 2);
    const minLoan = 10;

    if (!Number.isInteger(amount) || amount < minLoan || amount > maxLoan) {
      this.ctx.sendToClient(client, 'error', { message: `대출 금액은 ${minLoan}~${maxLoan} 사이여야 합니다` });
      return;
    }

    // 긴급 대출은 잔액이 적을 때만 (웹 대출 배너 노출 조건과 동일).
    // 이 조건이 없으면 호출을 반복해 한도 없이 빌릴 수 있었다.
    // 최소 베팅액 미만이면 초기금 5%를 넘어도 게임을 못 하므로 대출을 열어 둔다.
    const currentBalance = room.state.casinoBalances.get(playerId) ?? 0;
    if (currentBalance >= Math.max(initialBalance * 0.05, CasinoHandler.MIN_BET)) {
      this.ctx.sendToClient(client, 'error', { message: '잔액이 충분해 대출을 받을 수 없습니다' });
      return;
    }

    // 잔액에 대출금 추가
    const newBalance = currentBalance + amount;
    room.state.casinoBalances.set(playerId, newBalance);

    // 누적 대출금 기록
    const currentLoan = room.state.casinoLoans?.get(playerId) ?? 0;
    room.state.casinoLoans?.set(playerId, currentLoan + amount);

    const historyPoint = this.addHistoryPoint(room, playerId, newBalance);
    const totalLoan = (room.state.casinoLoans?.get(playerId) ?? 0);

    // 본인에게만 대출 확인 전송
    this.ctx.sendToClient(client, 'casinoLoanConfirmed', {
      amount,
      totalLoan,
      newBalance,
    });

    // 전체에게 잔액 업데이트 브로드캐스트
    this.ctx.broadcastToRoom(roomName, 'casinoBalanceUpdate', {
      playerId,
      balance: newBalance,
      delta: amount,
      historyPoint,
    });
  }

  // ── finishGame ────────────────────────────────────────────────

  async handleForceEnd(data: { roomName: string }, client: WebSocket): Promise<void> {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);
    if (!room || !room.gameStarted || !room.clients.has(client)) return;

    // UI는 관리자에게만 버튼을 보여주지만, 서버도 반드시 확인한다
    const playerId = room.playerIds.get(client);
    const isAdmin = playerId ? await this.supabase.isAdmin(playerId) : false;
    if (!isAdmin) {
      this.ctx.sendToClient(client, 'error', { message: '관리자만 강제 종료할 수 있습니다' });
      return;
    }
    // await 사이에 타이머·투표로 이미 끝났을 수 있다
    if (!room.gameStarted) return;

    if (room.casinoTimer) {
      clearTimeout(room.casinoTimer);
      room.casinoTimer = undefined;
    }
    this.finishGame(roomName, 'admin');
  }

  private finishGame(roomName: string, reason: 'timer' | 'vote' | 'admin'): void {
    const room = this.ctx.rooms.get(roomName);
    if (!room || !room.gameStarted) return;

    const initialBalance = room.casinoInitialBalance ?? 0;

    // 종료 시점에 결과가 오지 않은 판은 무효로 보고 베팅금을 돌려준다
    room.state.casinoPendingStakes?.forEach((stake, pid) => {
      if (stake > 0) {
        room.state.casinoBalances?.set(pid, (room.state.casinoBalances.get(pid) ?? 0) + stake);
      }
    });
    room.state.casinoPendingStakes = undefined;

    const playerList: {
      playerId: string;
      nickname: string;
      finalBalance: number;
      profit: number;
      rank: number;
      gamesPlayed: Record<string, number>;
      history: { t: number; b: number }[];
      totalLoan: number;
      loanRepayment: number;
    }[] = [];

    for (const [c, pid] of room.playerIds) {
      const nickname = room.nicknames.get(c) ?? pid;
      const rawBalance = room.state.casinoBalances?.get(pid) ?? initialBalance;
      const totalLoan = room.state.casinoLoans?.get(pid) ?? 0;
      const loanRepayment = Math.round(totalLoan * 1.1); // 원금 + 이자 10%
      const finalBalance = rawBalance - loanRepayment;
      const profit = finalBalance - initialBalance;
      const gamesPlayed = room.state.casinoGamesPlayed?.get(pid) ?? {};
      const history = [...(room.state.casinoHistory?.get(pid) ?? [])];

      // 대출 상환 후 실제 최종 잔액이 마지막 히스토리와 다르면 끝점 추가
      const elapsedSec = room.casinoStartedAt
        ? Math.floor((Date.now() - room.casinoStartedAt) / 1000)
        : 0;
      const lastB = history.length > 0 ? history[history.length - 1].b : rawBalance;
      if (lastB !== finalBalance) {
        history.push({ t: elapsedSec, b: finalBalance });
      }

      playerList.push({
        playerId: pid,
        nickname,
        finalBalance,
        profit,
        rank: 0,
        gamesPlayed,
        history,
        totalLoan,
        loanRepayment,
      });
    }

    // 잔액 내림차순 정렬 후 rank 부여 (동점 동순위 없이 순차)
    playerList.sort((a, b) => b.finalBalance - a.finalBalance);
    playerList.forEach((p, idx) => {
      p.rank = idx + 1;
    });

    room.gameStarted = false;
    room.gameFinished = true;
    room.gameOver = true;
    room.gameOverResult = null;

    console.log(
      `[Casino] Game over in '${roomName}' (reason: ${reason}). ` +
        playerList
          .map(
            (p) =>
              `${p.nickname}: ${p.finalBalance} (profit: ${p.profit >= 0 ? '+' : ''}${p.profit})`,
          )
          .join(' | '),
    );

    const gameOverResult = { roomName, reason, players: playerList };
    room.casinoLastResult = gameOverResult;
    this.ctx.broadcastToRoom(roomName, 'casinoGameOver', gameOverResult);

    // DB: 결과 저장 (fire-and-forget)
    if (room.supabaseSessionId) {
      const sessionId = room.supabaseSessionId;
      const durationSec = room.sessionStartedAt
        ? Math.floor((Date.now() - room.sessionStartedAt) / 1000)
        : 0;

      console.log(`[Casino] DB 결과 저장 시작 (sessionId: ${sessionId}, ${playerList.length}명)`);
      this.supabase.updateSessionDuration(sessionId, durationSec);

      const playersHistory = playerList.map((pl) => ({
        playerId: pl.playerId,
        nickname: pl.nickname,
        history: pl.history,
        rank: pl.rank,
      }));

      for (const p of playerList) {
        this.supabase.finalizePlayerResult({
          sessionId,
          userId: p.playerId,
          isWinner: p.rank === 1,
          score: p.finalBalance,
          rank: p.rank,
          playTimeSec: durationSec,
          extra: {
            initialBalance,
            profit: p.profit,
            gamesPlayed: p.gamesPlayed,
            history: p.history,
            myPlayerId: p.playerId,
            playersHistory,
          },
        });
      }
    }

    // 타이머 / 인게임 상태 정리
    if (room.casinoTimer) {
      clearTimeout(room.casinoTimer);
      room.casinoTimer = undefined;
    }
    room.state.casinoBalances = undefined;
    room.state.casinoCurrentGames = undefined;
    room.state.casinoHistory = undefined;
    room.state.casinoGamesPlayed = undefined;
    room.state.casinoVotes = undefined;
    room.state.casinoLoans = undefined;
  }

  // ── 플레이어 이탈 ─────────────────────────────────────────────

  handlePlayerLeft(room: Room, playerId: string): void {
    room.state.casinoVotes?.delete(playerId);
    // 방이 없어지면 시간 제한 타이머도 함께 끝낸다
    if (room.clients.size === 0) {
      if (room.casinoTimer) {
        clearTimeout(room.casinoTimer);
        room.casinoTimer = undefined;
      }
      return;
    }
    if (room.gameStarted && room.state.casinoVotes?.size) this.reconcileVotes(room);
  }

  // ── buildCasinoState (재연결용) ───────────────────────────────

  buildCasinoState(room: Room, playerId: string): Record<string, unknown> {
    if (room.gameType !== 'casino') return {};
    if (!room.gameStarted || !room.state.casinoBalances) {
      // 지난 판 결과는 그 판을 한 사람에게만 복원한다 (새로 들어온 사람에게 보이지 않게)
      return room.casinoLastResult?.players.some((p) => p.playerId === playerId)
        ? { casinoLastResult: room.casinoLastResult }
        : {};
    }

    const players: {
      playerId: string;
      nickname: string;
      balance: number;
      currentGame: string | null;
    }[] = [];

    for (const [c, pid] of room.playerIds) {
      const nickname = room.nicknames.get(c) ?? pid;
      players.push({
        playerId: pid,
        nickname,
        balance:
          room.state.casinoBalances.get(pid) ?? (room.casinoInitialBalance ?? 0),
        currentGame: room.state.casinoCurrentGames?.get(pid) ?? null,
      });
    }

    const elapsedSec = room.casinoStartedAt
      ? Math.floor((Date.now() - room.casinoStartedAt) / 1000)
      : 0;
    const timeLimit = room.casinoTimeLimit ?? null;
    const remainingSec = timeLimit !== null ? Math.max(0, timeLimit - elapsedSec) : null;

    const allHistories: Record<string, { t: number; b: number }[]> = {};
    if (room.state.casinoHistory) {
      for (const [pid, hist] of room.state.casinoHistory) {
        allHistories[pid] = hist;
      }
    }

    return {
      casinoStarted: true,
      casinoInitialBalance: room.casinoInitialBalance ?? 0,
      casinoTimeLimit: timeLimit,
      casinoRemainingSeconds: remainingSec,
      casinoPlayers: players,
      casinoMyHistory: allHistories[playerId] ?? [],
      casinoAllHistories: allHistories,
      casinoVotes: Array.from(room.state.casinoVotes ?? []),
      casinoPendingStake: room.state.casinoPendingStakes?.get(playerId) ?? 0,
    };
  }

  // ── 유틸 ──────────────────────────────────────────────────────

  private addHistoryPoint(
    room: Room,
    playerId: string,
    balance: number,
  ): { t: number; b: number } {
    const elapsedSec = room.casinoStartedAt
      ? Math.floor((Date.now() - room.casinoStartedAt) / 1000)
      : 0;

    const point = { t: elapsedSec, b: balance };
    const history = room.state.casinoHistory?.get(playerId);
    if (history) {
      history.push(point);
    }
    return point;
  }
}
