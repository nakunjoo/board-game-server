import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Admin } from '../database/entities/admin.entity';
import { Profile } from '../database/entities/profile.entity';
import { Report } from '../database/entities/report.entity';
import { ProfileModule } from '../profile/profile.module';
import { GameTypesModule } from '../game-types/game-types.module';
import { ManagerController } from './manager.controller';
import { ManagerService } from './manager.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Admin, Profile, Report]),
    ProfileModule,
    GameTypesModule,
  ],
  controllers: [ManagerController],
  providers: [ManagerService],
})
export class ManagerModule {}
