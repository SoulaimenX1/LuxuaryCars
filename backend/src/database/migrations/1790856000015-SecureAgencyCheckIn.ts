import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {MigrationInterface, QueryRunner} from 'typeorm';

export class SecureAgencyCheckIn1790856000015 implements MigrationInterface {
  name = 'SecureAgencyCheckIn1790856000015';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(readFileSync(
      join(process.cwd(), 'database', 'patches', '025-secure-agency-check-in.sql'),
      'utf8',
    ));
  }

  async down(): Promise<void> {
    throw new Error('Check-in credentials and inspection history must be reviewed before rollback.');
  }
}
