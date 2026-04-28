import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import type { Request } from 'express';
import { ProfileService } from './profile.service';
import { SupabaseAuthGuard } from './auth.guard';

@Controller('profile')
@UseGuards(SupabaseAuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  getProfile(@Req() req: Request) {
    return this.profileService.getProfile(req['userId']);
  }

  @Get('history')
  getHistory(@Req() req: Request) {
    return this.profileService.getHistory(req['userId']);
  }

  @Post('history/single')
  @HttpCode(200)
  recordSingleGame(
    @Req() req: Request,
    @Body() body: { gameType: 'minesweeper' | 'slide-puzzle'; isWinner: boolean; durationSec: number; extra?: Record<string, unknown> },
  ) {
    if (!body.gameType || body.isWinner === undefined || body.durationSec === undefined) {
      return { error: '필수 파라미터가 없습니다' };
    }
    return this.profileService.recordSingleGame(
      req['userId'],
      body.gameType,
      body.isWinner,
      body.durationSec,
      body.extra,
    );
  }

  @Patch('nickname')
  @HttpCode(200)
  updateNickname(
    @Req() req: Request,
    @Body('nickname') nickname: string,
  ) {
    if (!nickname?.trim() || nickname.trim().length > 6) {
      return { error: '닉네임은 1~6자여야 합니다' };
    }
    return this.profileService.updateNickname(req['userId'], nickname.trim());
  }
}
