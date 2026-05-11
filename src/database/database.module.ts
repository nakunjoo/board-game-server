import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseService } from './database.service';
import { GameSession } from './entities/game-session.entity';
import { GamePlayerResult } from './entities/game-player-result.entity';
import { Profile } from './entities/profile.entity';
import { Friendship } from './entities/friendship.entity';
import { Report } from './entities/report.entity';
import { Admin } from './entities/admin.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GameSession, GamePlayerResult, Profile, Friendship, Report, Admin])],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
