import {
  Injectable,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from '../database/entities/profile.entity';
import { GamePlayerResult } from '../database/entities/game-player-result.entity';
import { DatabaseService } from '../database/database.service';

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIXES = ['붉은', '푸른', '검은', '흰', '금빛'];
const NOUNS = ['여우', '곰', '토끼', '늑대', '사자', '펭귄', '판다', '매'];

function generateRandomNickname(): string {
  const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${prefix}${noun}${num}`;
}

@Injectable()
export class ProfileService {
  constructor(
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
    @InjectRepository(GamePlayerResult)
    private readonly playerResultRepo: Repository<GamePlayerResult>,
    private readonly db: DatabaseService,
  ) {}

  async getProfile(userId: string): Promise<{ nickname: string; nicknameUpdatedAt: string | null }> {
    let profile = await this.profileRepo.findOne({ where: { id: userId } });

    if (!profile) {
      // 프로필 없으면 랜덤 닉네임으로 자동 생성
      let nickname = generateRandomNickname();

      // 닉네임 중복 시 재생성 (최대 5회)
      for (let i = 0; i < 5; i++) {
        const exists = await this.profileRepo.findOne({ where: { nickname } });
        if (!exists) break;
        nickname = generateRandomNickname();
      }

      profile = this.profileRepo.create({ id: userId, nickname });
      await this.profileRepo.save(profile);
    }

    return {
      nickname: profile.nickname,
      nicknameUpdatedAt: profile.nicknameUpdatedAt?.toISOString() ?? null,
    };
  }

  async updateNickname(userId: string, newNickname: string): Promise<{ nickname: string; nicknameUpdatedAt: string }> {
    let profile = await this.profileRepo.findOne({ where: { id: userId } });

    if (!profile) {
      profile = this.profileRepo.create({ id: userId, nickname: newNickname });
      await this.profileRepo.save(profile);
      return { nickname: newNickname, nicknameUpdatedAt: new Date().toISOString() };
    }

    // 쿨다운 체크
    if (profile.nicknameUpdatedAt) {
      const elapsed = Date.now() - profile.nicknameUpdatedAt.getTime();
      if (elapsed < COOLDOWN_MS) {
        const nextDate = new Date(profile.nicknameUpdatedAt.getTime() + COOLDOWN_MS);
        throw new BadRequestException(
          `닉네임은 7일에 한 번만 변경할 수 있습니다. 다음 변경 가능일: ${nextDate.toLocaleDateString('ko-KR')}`,
        );
      }
    }

    // 중복 체크
    const existing = await this.profileRepo.findOne({ where: { nickname: newNickname } });
    if (existing && existing.id !== userId) {
      throw new ConflictException('이미 사용 중인 닉네임입니다');
    }

    const now = new Date();
    await this.profileRepo.update(userId, {
      nickname: newNickname,
      nicknameUpdatedAt: now,
    });

    return { nickname: newNickname, nicknameUpdatedAt: now.toISOString() };
  }

  async recordSingleGame(
    userId: string,
    gameType: 'minesweeper' | 'slide-puzzle',
    isWinner: boolean,
    durationSec: number,
    extra?: Record<string, unknown>,
  ) {
    await this.db.recordSingleGame({ userId, gameType, isWinner, durationSec, extra });
  }

  async getHistory(userId: string) {
    const results = await this.playerResultRepo.find({
      where: { userId },
      relations: ['session'],
      order: { session: { playedAt: 'DESC' } },
      take: 50,
    });

    return results.map((r) => ({
      sessionId: r.sessionId,
      gameType: r.session.gameType,
      playedAt: r.session.playedAt,
      playerCount: r.session.playerCount,
      totalRounds: r.session.totalRounds,
      durationSec: r.session.durationSec,
      status: r.status,
      isWinner: r.isWinner,
      score: r.score,
      rank: r.rank,
    }));
  }
}
