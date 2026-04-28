import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../database/entities/profile.entity';
import { GameSession } from '../database/entities/game-session.entity';
import { GamePlayerResult } from '../database/entities/game-player-result.entity';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { DatabaseService } from '../database/database.service';

@Module({
  imports: [TypeOrmModule.forFeature([Profile, GameSession, GamePlayerResult])],
  controllers: [ProfileController],
  providers: [ProfileService, DatabaseService],
})
export class ProfileModule {}
