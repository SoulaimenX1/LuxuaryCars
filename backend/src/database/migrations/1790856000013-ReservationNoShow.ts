import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {MigrationInterface, QueryRunner} from 'typeorm';

export class ReservationNoShow1790856000013 implements MigrationInterface {
    name = 'ReservationNoShow1790856000013';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(readFileSync(
            join(process.cwd(), 'database', 'patches', '023-reservation-no-show.sql'),
            'utf8',
        ));
    }

    async down(): Promise<void> {
        throw new Error('No-show history must be reviewed before rollback.');
    }
}
