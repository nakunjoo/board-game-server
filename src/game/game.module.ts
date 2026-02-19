import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameEngineFactory } from './game-engine.factory';
import { GameContext } from './game.context';
import { GangHandler } from './games/gang/gang.handler';
import { SpiceHandler } from './games/spice/spice.handler';
import { StandardCardEngine } from './engines/standard-card.engine';
import { SpiceEngine } from './engines/spice.engine';

const ENGINES = [StandardCardEngine, SpiceEngine];

@Module({
  providers: [
    ...ENGINES,
    {
      provide: GameEngineFactory,
      useFactory: (...engines: InstanceType<(typeof ENGINES)[number]>[]) =>
        new GameEngineFactory(engines),
      inject: ENGINES,
    },
    GameContext,
    GangHandler,
    SpiceHandler,
    GameGateway,
  ],
})
export class GameModule {}
