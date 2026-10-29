import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProfessionalVehicleReturns1792704600000
    implements MigrationInterface {
    name = 'ProfessionalVehicleReturns1792704600000';

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(readFileSync(
            join(process.cwd(), 'database', 'patches', '027-professional-vehicle-returns.sql'),
            'utf8',
        ));
    }

    async down(): Promise<void> {
        throw new Error(
            'Vehicle return and inspection history must be reviewed before rollback.',
        );
    }
}
