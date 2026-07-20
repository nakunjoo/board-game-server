import { Injectable, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from '../database/entities/profile.entity';

const USERNAME_EMAIL_DOMAIN = 'bobogang.local';

@Injectable()
export class AuthService {
  private readonly supabaseAdmin: SupabaseClient;

  constructor(
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
  ) {
    this.supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }

  async signup(id: string, nickname: string, password: string): Promise<{ success: true }> {
    const existingNickname = await this.profileRepo.findOne({ where: { nickname } });
    if (existingNickname) {
      throw new ConflictException('이미 사용 중인 닉네임입니다');
    }

    const email = `${id}@${USERNAME_EMAIL_DOMAIN}`;

    const { data, error } = await this.supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username: id },
    });

    if (error || !data.user) {
      if (error?.status === 422 || error?.message?.toLowerCase().includes('already')) {
        throw new ConflictException('이미 사용 중인 아이디입니다');
      }
      throw new InternalServerErrorException('회원가입에 실패했습니다');
    }

    const userId = data.user.id;
    const existingProfile = await this.profileRepo.findOne({ where: { id: userId } });
    if (existingProfile) {
      await this.profileRepo.update(userId, { nickname });
    } else {
      await this.profileRepo.save(this.profileRepo.create({ id: userId, nickname }));
    }

    return { success: true };
  }
}
