import {
    Column,
    Entity,
    PrimaryColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity('platform_settings')
export class PlatformSetting {
    @PrimaryColumn({ type: 'varchar', length: 100 })
    key!: string;

    @Column({ type: 'text' })
    value!: string;

    @Column({ type: 'varchar', length: 50, default: 'general' })
    category!: string;

    @Column({ type: 'text', nullable: true })
    description!: string | null;

    @Column({ name: 'updated_by', type: 'uuid', nullable: true })
    updatedBy!: string | null;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt!: Date;
}
