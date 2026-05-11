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

    // Room 레벨 상태 초기화
    room.gameStarted = true;
    room.gameFinished = false;
    room.gameOver = false;
    room.gameOverResult = null;

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
        this.finishGame(roomName, 'timer');
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

    const currentBalance = room.state.casinoBalances.get(playerId) ?? 0;
    if (amount > currentBalance) {
      this.ctx.sendToClient(client, 'error', { message: '잔액이 부족합니다' });
      return;
    }

    const newBalance = currentBalance - amount;
    room.state.casinoBalances.set(playerId, newBalance);

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

    const currentBalance = room.state.casinoBalances.get(playerId) ?? 0;
    const newBalance = Math.max(0, currentBalance + delta);
    room.state.casinoBalances.set(playerId, newBalance);

    // 게임 플레이 횟수 기록
    const gamesPlayed = room.state.casinoGamesPlayed?.get(playerId) ?? {};
    gamesPlayed[gameType] = (gamesPlayed[gameType] ?? 0) + 1;
    room.state.casinoGamesPlayed?.set(playerId, gamesPlayed);

    const historyPoint = this.addHistoryPoint(room, playerId, newBalance);

    this.ctx.broadcastToRoom(roomName, 'casinoBalanceUpdate', {
      playerId,
      balance: newBalance,
      delta,
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

    if (amount < minLoan || amount > maxLoan) {
      this.ctx.sendToClient(client, 'error', { message: `대출 금액은 ${minLoan}~${maxLoan} 사이여야 합니다` });
      return;
    }

    // 잔액에 대출금 추가
    const currentBalance = room.state.casinoBalances.get(playerId) ?? 0;
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

  handleForceEnd(data: { roomName: string }, _client: WebSocket): void {
    const { roomName } = data;
    const room = this.ctx.rooms.get(roomName);
    if (!room || !room.gameStarted) return;
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

    this.ctx.broadcastToRoom(roomName, 'casinoGameOver', {
      roomName,
      reason,
      players: playerList,
    });

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

  // ── buildCasinoState (재연결용) ───────────────────────────────

  buildCasinoState(room: Room, playerId: string): Record<string, unknown> {
    if (room.gameType !== 'casino' || !room.gameStarted || !room.state.casinoBalances) {
      return {};
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
