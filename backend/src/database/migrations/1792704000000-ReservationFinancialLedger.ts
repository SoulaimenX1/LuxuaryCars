import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    MigrationInterface,
    QueryRunner,
} from 'typeorm';

export class ReservationFinancialLedger1792704000000
    implements MigrationInterface {
    name = 'ReservationFinancialLedger1792704000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const patchPath = join(
            process.cwd(),
            'database',
            'patches',
            '026-reservation-financial-ledger.sql',
        );
        await queryRunner.query(readFileSync(patchPath, 'utf8'));
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        throw new Error(
            'Reservation financial ledger migration is irreversible to preserve financial history.',
        );
    }
}
