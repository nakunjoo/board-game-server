import { Injectable } from '@nestjs/common';
import { GameEngine } from './game-engine.interface';

@Injectable()
export class GameEngineFactory {
  private engines: Map<string, GameEngine> = new Map();

  constructor(engines: GameEngine[]) {
    for (const engine of engines) {
      this.engines.set(engine.gameType, engine);
    }
  }

  get(gameType: string): GameEngine {
    const engine = this.engines.get(gameType);
    if (!engine) {
      throw new Error(`알 수 없는 게임 타입: '${gameType}'`);
    }
    return engine;
  }

  getAvailableTypes(): string[] {
    return Array.from(this.engines.keys());
  }
}
