import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { GamePlayerResult } from './game-player-result.entity';

@Entity('game_sessions')
export class GameSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'room_name', type: 'text' })
  roomName: string;

  @Column({ name: 'game_type', type: 'text' })
  gameType: 'gang' | 'spice' | 'skulking' | 'minesweeper' | 'slide-puzzle' | 'blackjack';

  @CreateDateColumn({ name: 'played_at' })
  playedAt: Date;

  @Column({ name: 'duration_sec', type: 'int', nullable: true })
  durationSec: number | null;

  @Column({ name: 'player_count', type: 'int' })
  playerCount: number;

  @Column({ name: 'total_rounds', type: 'int', nullable: true })
  totalRounds: number | null;

  @OneToMany(() => GamePlayerResult, (result) => result.session)
  playerResults: GamePlayerResult[];
}
