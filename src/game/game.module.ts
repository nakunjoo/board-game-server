import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameEngineFactory } from './game-engine.factory';
import { GameContext } from './game.context';
import { GangHandler } from './games/gang/gang.handler';
import { SpiceHandler } from './games/spice/spice.handler';
import { SkulkingHandler } from './games/skulking/skulking.handler';
import { StandardCardEngine } from './engines/standard-card.engine';
import { SpiceEngine } from './engines/spice.engine';
import { SkulkingEngine } from './engines/skulking.engine';

const ENGINES = [StandardCardEngine, SpiceEngine, SkulkingEngine];

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
    SkulkingHandler,
    GameGateway,
  ],
})
export class GameModule {}
