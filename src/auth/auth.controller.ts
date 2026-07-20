import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';

const ID_REGEX = /^[a-z0-9_]{4,20}$/;

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  @HttpCode(200)
  async signup(
    @Body() body: { id: string; nickname: string; password: string },
  ) {
    const id = body.id?.trim();
    const nickname = body.nickname?.trim();
    const password = body.password;

    if (!id || !ID_REGEX.test(id)) {
      return { error: '아이디는 영문 소문자/숫자/언더스코어 4~20자여야 합니다' };
    }
    if (!nickname || nickname.length > 6) {
      return { error: '닉네임은 1~6자여야 합니다' };
    }
    if (!password || password.length < 6) {
      return { error: '비밀번호는 6자 이상이어야 합니다' };
    }

    return this.authService.signup(id, nickname, password);
  }
}
