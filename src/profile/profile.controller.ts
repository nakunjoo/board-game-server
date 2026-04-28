import {
  Controller,
  Get,
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
