import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from '../database/entities/profile.entity';

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class ProfileService {
  constructor(
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
  ) {}

  async getProfile(userId: string): Promise<{ nickname: string; nicknameUpdatedAt: string | null }> {
    const profile = await this.profileRepo.findOne({ where: { id: userId } });
    if (!profile) throw new NotFoundException('프로필을 찾을 수 없습니다');

    return {
      nickname: profile.nickname,
      nicknameUpdatedAt: profile.nicknameUpdatedAt?.toISOString() ?? null,
    };
  }

  async updateNickname(userId: string, newNickname: string): Promise<{ nickname: string; nicknameUpdatedAt: string }> {
    const profile = await this.profileRepo.findOne({ where: { id: userId } });
    if (!profile) throw new NotFoundException('프로필을 찾을 수 없습니다');

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
}
