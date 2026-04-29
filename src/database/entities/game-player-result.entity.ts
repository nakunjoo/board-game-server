import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { GameSession } from './game-session.entity';

@Entity('game_player_results')
export class GamePlayerResult {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => GameSession, (session) => session.playerResults, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'session_id' })
  session: GameSession;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'text' })
  nickname: string;

  @Column({ name: 'is_winner', type: 'boolean', nullable: true })
  isWinner: boolean | null;

  @Column({ type: 'int', nullable: true })
  score: number | null;

  @Column({ type: 'int', nullable: true })
  rank: number | null;

  @Column({ type: 'text', default: 'completed' })
  status: 'completed' | 'abandoned_voluntary' | 'abandoned_disconnected';

  @Column({ name: 'abandoned_at', type: 'timestamptz', nullable: true })
  abandonedAt: Date | null;

  @Column({ name: 'play_time_sec', type: 'int', nullable: true })
  playTimeSec: number | null;

  @Column({ type: 'jsonb', nullable: true })
  extra: object | null;
}
