import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GameType } from '../database/entities/game-type.entity';

@Injectable()
export class GameTypesService {
  constructor(
    @InjectRepository(GameType)
    private readonly gameTypeRepo: Repository<GameType>,
  ) {}

  // 로비용: 활성화된 게임 타입만 반환
  async getActiveGameTypes(): Promise<{ value: string; label: string }[]> {
    const types = await this.gameTypeRepo.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC' },
    });
    return types.map((t) => ({ value: t.id, label: t.label }));
  }

  // 관리자용: 전체 목록 반환
  async getAllGameTypes(): Promise<GameType[]> {
    return this.gameTypeRepo.find({ order: { sortOrder: 'ASC' } });
  }

  async createGameType(id: string, label: string, sortOrder: number): Promise<GameType> {
    const gt = this.gameTypeRepo.create({ id, label, sortOrder, isActive: true });
    return this.gameTypeRepo.save(gt);
  }

  async updateGameType(id: string, updates: Partial<Pick<GameType, 'label' | 'isActive' | 'sortOrder'>>): Promise<void> {
    await this.gameTypeRepo.update(id, updates);
  }

  async deleteGameType(id: string): Promise<void> {
    await this.gameTypeRepo.delete(id);
  }
}
