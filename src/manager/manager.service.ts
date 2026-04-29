import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Admin } from '../database/entities/admin.entity';
import { Profile } from '../database/entities/profile.entity';
import { Report } from '../database/entities/report.entity';
import { GameTypesService } from '../game-types/game-types.service';

@Injectable()
export class ManagerService {
  constructor(
    @InjectRepository(Admin)
    private readonly adminRepo: Repository<Admin>,
    @InjectRepository(Profile)
    private readonly profileRepo: Repository<Profile>,
    @InjectRepository(Report)
    private readonly reportRepo: Repository<Report>,
    private readonly gameTypesService: GameTypesService,
  ) {}

  // ──────────────────────────────────────────────
  // 어드민 관리
  // ──────────────────────────────────────────────

  async getAdmins(): Promise<{ userId: string; nickname: string; grantedBy: string | null; createdAt: Date }[]> {
    const admins = await this.adminRepo.find({ relations: ['profile'] });
    return admins.map((a) => ({
      userId: a.userId,
      nickname: a.profile?.nickname ?? '(알 수 없음)',
      grantedBy: a.grantedBy,
      createdAt: a.createdAt,
    }));
  }

  async addAdmin(targetUserId: string, grantedBy: string): Promise<void> {
    const profile = await this.profileRepo.findOne({ where: { id: targetUserId } });
    if (!profile) throw new NotFoundException('해당 유저를 찾을 수 없습니다');

    const exists = await this.adminRepo.findOne({ where: { userId: targetUserId } });
    if (exists) return;

    const admin = this.adminRepo.create({ userId: targetUserId, grantedBy });
    await this.adminRepo.save(admin);
  }

  async removeAdmin(targetUserId: string): Promise<void> {
    await this.adminRepo.delete({ userId: targetUserId });
  }

  async searchUserByNickname(nickname: string): Promise<{ userId: string; nickname: string } | null> {
    const profile = await this.profileRepo.findOne({ where: { nickname } });
    if (!profile) return null;
    return { userId: profile.id, nickname: profile.nickname };
  }

  // ──────────────────────────────────────────────
  // 게임 타입 관리 (GameTypesService 위임)
  // ──────────────────────────────────────────────

  getAllGameTypes() {
    return this.gameTypesService.getAllGameTypes();
  }

  createGameType(id: string, label: string, sortOrder: number) {
    return this.gameTypesService.createGameType(id, label, sortOrder);
  }

  updateGameType(id: string, updates: { label?: string; isActive?: boolean; sortOrder?: number }) {
    return this.gameTypesService.updateGameType(id, updates);
  }

  deleteGameType(id: string) {
    return this.gameTypesService.deleteGameType(id);
  }

  // ──────────────────────────────────────────────
  // 신고 관리
  // ──────────────────────────────────────────────

  async getReports(status?: 'pending' | 'reviewed' | 'dismissed') {
    const where = status ? { status } : {};
    const reports = await this.reportRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });

    // reporterId / reportedId 에 해당하는 닉네임 일괄 조회
    const userIds = [...new Set([...reports.map((r) => r.reporterId), ...reports.map((r) => r.reportedId)])];
    const profiles = await this.profileRepo.findByIds(userIds);
    const nicknameMap = new Map(profiles.map((p) => [p.id, p.nickname]));

    return reports.map((r) => ({
      id: r.id,
      reporterNickname: nicknameMap.get(r.reporterId) ?? r.reporterId,
      reportedNickname: nicknameMap.get(r.reportedId) ?? r.reportedId,
      reportedId: r.reportedId,
      reason: r.reason,
      description: r.description,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async updateReportStatus(reportId: string, status: 'reviewed' | 'dismissed'): Promise<void> {
    await this.reportRepo.update(reportId, { status });
  }

  async banUser(userId: string, reason: string): Promise<void> {
    await this.profileRepo.update(userId, { isBanned: true, banReason: reason });
  }

  async unbanUser(userId: string): Promise<void> {
    await this.profileRepo.update(userId, { isBanned: false, banReason: null });
  }
}
