import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Query,
  Param,
  Body,
  UseGuards,
  Req,
  HttpCode,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../profile/auth.guard';
import { ManagerGuard } from './manager.guard';
import { ManagerService } from './manager.service';

@Controller('manager')
@UseGuards(SupabaseAuthGuard, ManagerGuard)
export class ManagerController {
  constructor(private readonly managerService: ManagerService) {}

  // ──────────────────────────────────────────────
  // 어드민 관리
  // ──────────────────────────────────────────────

  @Get('admins')
  getAdmins() {
    return this.managerService.getAdmins();
  }

  @Get('users/search')
  searchUser(@Query('nickname') nickname: string) {
    if (!nickname?.trim()) return null;
    return this.managerService.searchUserByNickname(nickname.trim());
  }

  @Post('admins/:userId')
  @HttpCode(200)
  addAdmin(@Param('userId') userId: string, @Req() req: Request) {
    return this.managerService.addAdmin(userId, req['userId']);
  }

  @Delete('admins/:userId')
  @HttpCode(200)
  removeAdmin(@Param('userId') userId: string) {
    return this.managerService.removeAdmin(userId);
  }

  // ──────────────────────────────────────────────
  // 게임 타입 관리
  // ──────────────────────────────────────────────

  @Get('game-types')
  getAllGameTypes() {
    return this.managerService.getAllGameTypes();
  }

  @Post('game-types')
  @HttpCode(200)
  createGameType(@Body() body: { id: string; label: string; sortOrder?: number }) {
    return this.managerService.createGameType(body.id, body.label, body.sortOrder ?? 0);
  }

  @Put('game-types/:id')
  @HttpCode(200)
  updateGameType(
    @Param('id') id: string,
    @Body() body: { label?: string; isActive?: boolean; sortOrder?: number },
  ) {
    return this.managerService.updateGameType(id, body);
  }

  @Delete('game-types/:id')
  @HttpCode(200)
  deleteGameType(@Param('id') id: string) {
    return this.managerService.deleteGameType(id);
  }

  // ──────────────────────────────────────────────
  // 신고 관리
  // ──────────────────────────────────────────────

  @Get('reports')
  getReports(@Query('status') status?: 'pending' | 'reviewed' | 'dismissed') {
    return this.managerService.getReports(status);
  }

  @Put('reports/:id/status')
  @HttpCode(200)
  updateReportStatus(
    @Param('id') id: string,
    @Body() body: { status: 'reviewed' | 'dismissed' },
  ) {
    return this.managerService.updateReportStatus(id, body.status);
  }

  @Post('users/:userId/ban')
  @HttpCode(200)
  banUser(@Param('userId') userId: string, @Body() body: { reason: string }) {
    return this.managerService.banUser(userId, body.reason ?? '관리자 제재');
  }

  @Post('users/:userId/unban')
  @HttpCode(200)
  unbanUser(@Param('userId') userId: string) {
    return this.managerService.unbanUser(userId);
  }
}
