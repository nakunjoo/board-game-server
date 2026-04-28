import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('profiles')
export class Profile {
  @PrimaryColumn('uuid')
  id: string; // Supabase auth.users.id

  @Column({ type: 'text' })
  nickname: string;

  @Column({ type: 'text', nullable: true })
  avatarUrl: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  @Column({ name: 'is_banned', default: false })
  isBanned: boolean;

  @Column({ name: 'ban_reason', type: 'text', nullable: true })
  banReason: string | null;

  @Column({ name: 'nickname_updated_at', type: 'timestamptz', nullable: true })
  nicknameUpdatedAt: Date | null;
}
