import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KeepaliveService } from './keepalive.service';

@Module({
  imports: [AuthModule],
  providers: [KeepaliveService],
})
export class KeepaliveModule {}
