import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: PricingRulesTable (P7.1 Scoped Pricing Advisory Rules)
 * 
 * IMPORTANT: PREPARED MIGRATION ONLY.
 * Per institutional compliance instructions, this migration is NOT automatically executed.
 * Runtime scoped pricing rules are reliably stored in `platform_settings` until formal
 * database schema migration is explicitly approved by administration.
 */
export class PricingRulesTable1792705000000 implements MigrationInterface {
  name = 'PricingRulesTable1792705000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pricing_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id VARCHAR(64) NOT NULL UNIQUE,
        recommendation_id VARCHAR(64) NOT NULL,
        vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        license_plate VARCHAR(32) NOT NULL,
        original_daily_price NUMERIC(10, 2) NOT NULL,
        approved_daily_price NUMERIC(10, 2) NOT NULL,
        variance_percent NUMERIC(5, 2) NOT NULL,
        start_date DATE,
        end_date DATE,
        admin_reason TEXT,
        approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'active',
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rolled_back_at TIMESTAMPTZ,
        rolled_back_by UUID REFERENCES users(id) ON DELETE SET NULL,
        rollback_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_pricing_rules_vehicle_id ON pricing_rules(vehicle_id);
      CREATE INDEX IF NOT EXISTS idx_pricing_rules_license_plate ON pricing_rules(license_plate);
      CREATE INDEX IF NOT EXISTS idx_pricing_rules_status ON pricing_rules(status);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS pricing_rules CASCADE;
    `);
  }
}
