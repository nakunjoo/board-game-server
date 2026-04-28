import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GameModule } from './game/game.module';
import { ProfileModule } from './profile/profile.module';
import { Profile } from './database/entities/profile.entity';
import { GameSession } from './database/entities/game-session.entity';
import { GamePlayerResult } from './database/entities/game-player-result.entity';
import { Friendship } from './database/entities/friendship.entity';
import { Report } from './database/entities/report.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        ssl: { rejectUnauthorized: false },
        entities: [Profile, GameSession, GamePlayerResult, Friendship, Report],
        synchronize: false, // schema.sql로 직접 관리
        logging: config.get('NODE_ENV') !== 'production',
      }),
    }),
    GameModule,
    ProfileModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
