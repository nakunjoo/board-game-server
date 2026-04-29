import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GameSession } from './entities/game-session.entity';
import { GamePlayerResult } from './entities/game-player-result.entity';

export interface CreateSessionParams {
  roomName: string;
  gameType: 'gang' | 'spice' | 'skulking' | 'minesweeper' | 'slide-puzzle' | 'blackjack';
  playerCount: number;
  totalRounds?: number;
}

export interface RecordSingleGameParams {
  userId: string;
  gameType: 'minesweeper' | 'slide-puzzle';
  isWinner: boolean;
  durationSec: number;
  extra?: Record<string, unknown>;
}

export interface InsertPlayerParams {
  sessionId: string;
  userId: string;
  nickname: string;
}

export interface FinalizePlayerParams {
  sessionId: string;
  userId: string;
  isWinner: boolean;
  score?: number;
  rank?: number;
  playTimeSec?: number;
  extra?: Record<string, unknown>;
}

@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(
    @InjectRepository(GameSession)
    private readonly sessionRepo: Repository<GameSession>,
    @InjectRepository(GamePlayerResult)
    private readonly playerResultRepo: Repository<GamePlayerResult>,
  ) {}

  async createSession(
    params: CreateSessionParams,
    startedAt: Date,
  ): Promise<string | null> {
    try {
      const session = this.sessionRepo.create({
        roomName: params.roomName,
        gameType: params.gameType,
        playerCount: params.playerCount,
        totalRounds: params.totalRounds ?? null,
        playedAt: startedAt,
      });
      const saved = await this.sessionRepo.save(session);
      return saved.id;
    } catch (e) {
      this.logger.error('createSession 실패', e);
      return null;
    }
  }

  async insertPlayerResults(players: InsertPlayerParams[]): Promise<void> {
    try {
      const rows = players.map((p) =>
        this.playerResultRepo.create({
          sessionId: p.sessionId,
          userId: p.userId,
          nickname: p.nickname,
          status: 'completed',
        }),
      );
      await this.playerResultRepo.save(rows);
    } catch (e) {
      this.logger.error('insertPlayerResults 실패', e);
    }
  }

  async markAbandoned(
    sessionId: string,
    userId: string,
    reason: 'voluntary' | 'disconnected' = 'disconnected',
  ): Promise<void> {
    try {
      await this.playerResultRepo.update(
        { sessionId, userId },
        {
          status: reason === 'voluntary' ? 'abandoned_voluntary' : 'abandoned_disconnected',
          abandonedAt: new Date(),
        },
      );
    } catch (e) {
      this.logger.error('markAbandoned 실패', e);
    }
  }

  async finalizePlayerResult(params: FinalizePlayerParams): Promise<void> {
    try {
      await this.playerResultRepo.update(
        { sessionId: params.sessionId, userId: params.userId },
        {
          isWinner: params.isWinner,
          score: params.score ?? null,
          rank: params.rank ?? null,
          playTimeSec: params.playTimeSec ?? null,
          extra: (params.extra ?? null) as object,
        },
      );
    } catch (e) {
      this.logger.error('finalizePlayerResult 실패', e);
    }
  }

  async recordSingleGame(params: RecordSingleGameParams): Promise<void> {
    try {
      const now = new Date();
      const session = this.sessionRepo.create({
        roomName: `single-${params.gameType}`,
        gameType: params.gameType,
        playerCount: 1,
        playedAt: now,
        durationSec: params.durationSec,
      });
      const saved = await this.sessionRepo.save(session);
      const result = this.playerResultRepo.create({
        sessionId: saved.id,
        userId: params.userId,
        nickname: '',
        isWinner: params.isWinner,
        status: 'completed',
        playTimeSec: params.durationSec,
        extra: (params.extra ?? null) as object,
      });
      await this.playerResultRepo.save(result);
    } catch (e) {
      this.logger.error('recordSingleGame 실패', e);
    }
  }

  async updateSessionDuration(
    sessionId: string,
    durationSec: number,
    totalRounds?: number,
  ): Promise<void> {
    try {
      await this.sessionRepo.update(sessionId, {
        durationSec,
        ...(totalRounds !== undefined && { totalRounds }),
      });
    } catch (e) {
      this.logger.error('updateSessionDuration 실패', e);
    }
  }
}
