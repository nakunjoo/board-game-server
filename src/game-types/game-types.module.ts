import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GameType } from '../database/entities/game-type.entity';
import { GameTypesController } from './game-types.controller';
import { GameTypesService } from './game-types.service';

@Module({
  imports: [TypeOrmModule.forFeature([GameType])],
  controllers: [GameTypesController],
  providers: [GameTypesService],
  exports: [GameTypesService],
})
export class GameTypesModule {}
