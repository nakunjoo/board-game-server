import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('reports')
export class Report {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'reporter_id', type: 'uuid' })
  reporterId: string;

  @Column({ name: 'reported_id', type: 'uuid' })
  reportedId: string;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId: string | null;

  @Column({ type: 'text' })
  reason: 'cheating' | 'abusive' | 'afk' | 'other';

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', default: 'pending' })
  status: 'pending' | 'reviewed' | 'dismissed';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
