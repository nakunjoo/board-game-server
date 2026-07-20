import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthService } from '../auth/auth.service';

const PREFIXES = ['봄', '해', '달', '별', '꽃', '눈', '빛', '숲'];
const NOUNS = ['손', '님', '벗', '객', '린', '우'];

function randomId(): string {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `bot${suffix}`.slice(0, 20);
}

function randomNickname(): string {
  const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}${noun}${num}`;
}

function randomPassword(): string {
  return Math.random().toString(36).slice(2, 12) + 'A1!';
}

@Injectable()
export class KeepaliveService {
  private readonly logger = new Logger(KeepaliveService.name);

  constructor(private readonly authService: AuthService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async createDailyDummyUser() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.authService.signup(randomId(), randomNickname(), randomPassword());
        this.logger.log('Daily keepalive dummy user created');
        return;
      } catch (err) {
        this.logger.warn(`Keepalive signup attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.logger.error('Keepalive dummy user creation failed after retries');
  }
}
