import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {MigrationInterface, QueryRunner} from 'typeorm';

export class AgencyCheckIn1790856000014 implements MigrationInterface {
  name = 'AgencyCheckIn1790856000014';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(readFileSync(
      join(process.cwd(), 'database', 'patches', '024-agency-check-in.sql'),
      'utf8',
    ));
  }

  async down(): Promise<void> {
    throw new Error('Agency check-in history must be reviewed before rollback.');
  }
}
