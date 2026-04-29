import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('game_types')
export class GameType {
  @PrimaryColumn({ type: 'text' })
  id: string; // e.g. "gang", "spice", "skulking"

  @Column({ type: 'text' })
  label: string; // e.g. "갱스터", "향신료", "스컬킹"

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'sort_order', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
