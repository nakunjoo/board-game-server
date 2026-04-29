import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Profile } from './profile.entity';

@Entity('admins')
export class Admin {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId: string;

  @Column({ name: 'granted_by', type: 'uuid', nullable: true })
  grantedBy: string | null; // 최초 어드민은 null (DB 직접 삽입)

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Profile)
  @JoinColumn({ name: 'user_id' })
  profile: Profile;
}
