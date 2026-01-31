import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameEngineFactory } from './game-engine.factory';
import { StandardCardEngine } from './engines/standard-card.engine';

// 새 게임 엔진을 추가할 때 이 배열에 추가하면 됩니다
const ENGINES = [StandardCardEngine];

@Module({
  providers: [
    ...ENGINES,
    {
      provide: GameEngineFactory,
      useFactory: (...engines: InstanceType<(typeof ENGINES)[number]>[]) =>
        new GameEngineFactory(engines),
      inject: ENGINES,
    },
    GameGateway,
  ],
})
export class GameModule {}
