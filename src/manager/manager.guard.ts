import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ProfileService } from '../profile/profile.service';

@Injectable()
export class ManagerGuard implements CanActivate {
  constructor(private readonly profileService: ProfileService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req['userId'] as string | undefined;
    if (!userId) throw new ForbiddenException();

    const isAdmin = await this.profileService.isAdmin(userId);
    if (!isAdmin) throw new ForbiddenException('관리자 권한이 필요합니다');

    return true;
  }
}
