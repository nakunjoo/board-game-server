import { Controller, Get } from '@nestjs/common';
import { GameTypesService } from './game-types.service';

@Controller('game-types')
export class GameTypesController {
  constructor(private readonly gameTypesService: GameTypesService) {}

  // 공개 API — 로비에서 인증 없이 호출
  @Get()
  getActiveGameTypes() {
    return this.gameTypesService.getActiveGameTypes();
  }
}
