import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import type { Client } from 'pg';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import dotenv from 'dotenv';

import {
  closeDisposableDatabase,
  openDisposableDatabase,
} from './support/itest-database.js';

import type { DisposableDatabase } from './support/itest-database.js';

dotenv.config();

const TEST_DB = 'luxury_car_rental_f18_itest';
process.env.DB_DATABASE = TEST_DB;
process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'integration-test-secret-key-0123456789abcdef';
}

const PASSWORD = 'F18TestPassword123!';

const ID = {
  admin: '00000000-0000-4000-8000-0000000000a1',
  staff: '00000000-0000-4000-8000-0000000000e1',
  customer: '00000000-0000-4000-8000-0000000000c1',
  agency: '11111111-1111-4000-8000-000000000001',
  brand: 'f0000000-0000-4000-8000-0000000000f1',
  category: 'c0000000-0000-4000-8000-0000000000c1',
  model: 'd0000000-0000-4000-8000-0000000000d1',
  vehicleA: 'a0000000-0000-4000-8000-000000000001',
  vehicleB: 'b0000000-0000-4000-8000-000000000002',
  reservationA: '33333333-3333-4000-8000-000000000001',
  reservationB: '44444444-4444-4000-8000-000000000002',
  rentalA: '55555555-5555-4000-8000-000000000001',
  rentalB: '66666666-6666-4000-8000-000000000002',
};

const EMAIL = {
  admin: 'f18.admin@luxury.test',
  staff: 'f18.staff@luxury.test',
  customer: 'f18.customer@luxury.test',
};

let database: DisposableDatabase;
let db: Client;
let app: INestApplication;
const tokens = {
  admin: '',
  staff: '',
  customer: '',
};

async function seed(target: Client) {
  const hash = await argon2.hash(PASSWORD);

  // 1. Users
  await target.query(
    `INSERT INTO users (id, email, password_hash, role, status, first_name, last_name, email_verified_at)
     VALUES
       ($1, $4, $7, 'admin', 'active', 'Admin', 'Officer', now()),
       ($2, $5, $7, 'staff', 'active', 'Staff', 'Desk', now()),
       ($3, $6, $7, 'customer', 'active', 'Client', 'Prestige', now())`,
    [ID.admin, ID.staff, ID.customer, EMAIL.admin, EMAIL.staff, EMAIL.customer, hash],
  );

  await target.query(
    `INSERT INTO customer_profiles (user_id, date_of_birth, license_number, license_country, license_issued_on, license_expires_on)
     VALUES ($1, '1988-06-15', 'HU-LIC-8812', 'HU', '2010-01-01', '2040-01-01')`,
    [ID.customer],
  );

  // 2. Locations & Staff assignment
  await target.query(
    `INSERT INTO rental_locations (id, code, name, category, city, country, can_pickup, can_dropoff, enabled, address)
     VALUES ($1, 'AGY-BUD', 'Budapest Central Agency', 'showroom', 'Budapest', 'Hongrie', true, true, true, '{"city":"Budapest","street":"Andrassy 1"}')`,
    [ID.agency],
  );

  await target.query(
    `INSERT INTO agency_staff_assignments (user_id, agency_id, assigned_by)
     VALUES ($1, $2, $3)`,
    [ID.staff, ID.agency, ID.admin],
  );

  // 3. Vehicles
  await target.query(`INSERT INTO brands (id, name) VALUES ($1, 'Bentley')`, [ID.brand]);
  await target.query(`INSERT INTO categories (id, name) VALUES ($1, 'Grand Tourer')`, [ID.category]);
  await target.query(
    `INSERT INTO vehicle_models (id, brand_id, category_id, name) VALUES ($1, $2, $3, 'Continental GT')`,
    [ID.model, ID.brand, ID.category],
  );

  await target.query(
    `INSERT INTO vehicles (id, model_id, manufacture_year, license_plate, vin, transmission, fuel_type, daily_price, security_deposit, vehicle_value, status, home_location_id)
     VALUES
       ($1, $3, 2024, 'BEN-001', 'VIN00000000000001', 'automatic', 'petrol', 400.00, 2000.00, 220000, 'active', $4),
       ($2, $3, 2024, 'BEN-002', 'VIN00000000000002', 'automatic', 'petrol', 400.00, 2000.00, 220000, 'active', $4)`,
    [ID.vehicleA, ID.vehicleB, ID.model, ID.agency],
  );

  // 4. Reservations (4 days @ €400/day = €1600 total, €2000 deposit)
  await target.query(
    `INSERT INTO reservations (id, reservation_number, customer_id, vehicle_id, pickup_at, return_at, rental_days, daily_price, deposit_amount, total_amount, status)
     VALUES
       ($1, 'RES-F18-000001', $3, $4, '2026-11-01T10:00:00Z', '2026-11-05T10:00:00Z', 4, 400.00, 2000.00, 1600.00, 'confirmed'),
       ($2, 'RES-F18-000002', $3, $5, '2026-11-10T10:00:00Z', '2026-11-14T10:00:00Z', 4, 400.00, 2000.00, 1600.00, 'confirmed')`,
    [ID.reservationA, ID.reservationB, ID.customer, ID.vehicleA, ID.vehicleB],
  );

  await target.query(
    `INSERT INTO reservation_preferences (reservation_id, pickup_location_id, dropoff_location_id, pickup_location_snapshot, dropoff_location_snapshot)
     VALUES
       ($1, $3, $3, 'Budapest Central Agency', 'Budapest Central Agency'),
       ($2, $3, $3, 'Budapest Central Agency', 'Budapest Central Agency')`,
    [ID.reservationA, ID.reservationB, ID.agency],
  );

  // 5. Active Rentals
  await target.query(
    `INSERT INTO rentals (id, contract_number, reservation_id, status, started_at, expected_return_at, opened_by)
     VALUES
       ($1, 'CNT-F18-000001', $3, 'active', '2026-11-01T10:00:00Z', '2026-11-05T10:00:00Z', $5),
       ($2, 'CNT-F18-000002', $4, 'active', '2026-11-10T10:00:00Z', '2026-11-14T10:00:00Z', $5)`,
    [ID.rentalA, ID.rentalB, ID.reservationA, ID.reservationB, ID.admin],
  );

  // 6. Handover Inspections (Required by trigger trg_inspection_mileage prior to return)
  await target.query(
    `INSERT INTO inspections (rental_id, type, performed_by, mileage_km, fuel_level_pct, overall_condition)
     VALUES
       ($1, 'handover', $3, 24000, 100, 'excellent'),
       ($2, 'handover', $3, 17500, 100, 'excellent')`,
    [ID.rentalA, ID.rentalB, ID.admin],
  );
}

async function loginUser(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

describe('F18 End-to-End Validation (Disposable Database & Real HTTP APIs)', () => {
  beforeAll(async () => {
    // Spin up disposable database
    database = await openDisposableDatabase(TEST_DB);
    db = database.db;
    await seed(db);

    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    tokens.admin = await loginUser(EMAIL.admin);
    tokens.staff = await loginUser(EMAIL.staff);
    tokens.customer = await loginUser(EMAIL.customer);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    if (database) {
      await closeDisposableDatabase(database);
      // Cleanly drop disposable DB
      const adminClient = database.admin;
      await adminClient.connect().catch(() => {});
      await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
      await adminClient.end().catch(() => {});
    }
  });

  // ============================================================
  // 1. RBAC PERMISSIONS VERIFICATION
  // ============================================================
  describe('1. RBAC Security & Access Control', () => {
    it('rejects unauthenticated requests to finance admin API (401)', async () => {
      await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .expect(401);
    });

    it('rejects customer from accessing finance admin endpoints (403)', async () => {
      await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .set('Authorization', `Bearer ${tokens.customer}`)
        .expect(403);

      await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalA}/payments`)
        .set('Authorization', `Bearer ${tokens.customer}`)
        .send({ type: 'rental_payment', method: 'card', amount: 100, reference: 'HACK' })
        .expect(403);
    });

    it('rejects staff from accessing admin-only finance endpoints (403)', async () => {
      await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .set('Authorization', `Bearer ${tokens.staff}`)
        .expect(403);

      await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalA}/payments`)
        .set('Authorization', `Bearer ${tokens.staff}`)
        .send({ type: 'rental_payment', method: 'bank_transfer', amount: 500, reference: 'STAFF-PAY' })
        .expect(403);
    });

    it('allows Admin full access to finance endpoints (200)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(res.body.rental.contractNumber).toBe('CNT-F18-000001');
      expect(res.body.amountPaidEur).toBe('0.00');
      expect(res.body.outstandingEur).toBe('1600.00');
      expect(res.body.paymentStatus).toBe('PENDING');
      expect(res.body.deposit.status).toBe('pending');
    });
  });

  // ============================================================
  // 2. PAYMENT RECORDING & LEDGER IMMUTABILITY
  // ============================================================
  describe('2. Payment Processing & Ledger Validation', () => {
    let paymentId: string;

    it('records verified manual payment for rental contract', async () => {
      const res = await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalA}/payments`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({
          type: 'rental_payment',
          method: 'bank_transfer',
          amount: 1600.00,
          reference: 'WIRE-F18-001',
        })
        .expect(201);

      expect(res.body.recorded).toBe(true);
      expect(res.body.paymentId).toBeDefined();
      paymentId = res.body.paymentId;

      // Verify updated financial statement
      const summary = await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(summary.body.amountPaidEur).toBe('1600.00');
      expect(summary.body.outstandingEur).toBe('0.00');
      expect(summary.body.paymentStatus).toBe('PAID');
      expect(summary.body.payments).toHaveLength(1);
      expect(summary.body.payments[0].reference).toBe('WIRE-F18-001');
    });

    it('prevents duplicate payment recording with the same audit reference (409 Conflict)', async () => {
      await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalA}/payments`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({
          type: 'rental_payment',
          method: 'bank_transfer',
          amount: 100.00,
          reference: 'WIRE-F18-001', // duplicate
        })
        .expect(409);
    });

    it('downloads an official luxury PDF receipt for the payment', async () => {
      const res = await request(app.getHttpServer())
        .get(`/finance/admin/payments/${paymentId}/receipt`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(res.headers['content-type']).toBe('application/pdf');
      const buffer = res.body as Buffer;
      expect(buffer.toString('ascii', 0, 8)).toBe('%PDF-1.4');
    });
  });

  // ============================================================
  // 3. SECURITY DEPOSIT ESCROW HOLD
  // ============================================================
  describe('3. Security Deposit Escrow Hold', () => {
    it('transitions security deposit from pending to held on vehicle handover', async () => {
      const res = await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalA}/deposit/hold`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({
          method: 'card',
          reference: 'AUTH-PRE-9901',
        })
        .expect(201);

      expect(res.body.receivedEur).toBe('2000.00');
      expect(res.body.outstandingEur).toBe('0.00');

      // Verify summary reflects held deposit
      const summary = await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(summary.body.deposit.status).toBe('held');
      expect(summary.body.deposit.receivedAmount).toBe('2000.00');
    });
  });

  // ============================================================
  // 4. VEHICLE RETURN & ADDITIONAL CHARGES
  // ============================================================
  describe('4. Vehicle Return & Inspection Penalties', () => {
    it('records physical vehicle return', async () => {
      await request(app.getHttpServer())
        .post(`/returns/admin/${ID.rentalA}/return`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({
          mileageKm: 24500,
          fuelLevelPct: 100,
          keysReturned: true,
          condition: 'good',
          damages: [],
        })
        .expect(201);

      const summary = await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(summary.body.rental.status).toBe('returned');
    });

    it('records verified additional charge for return damage or penalty', async () => {
      await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalA}/charges`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({
          type: 'cleaning',
          description: 'Specialist interior leather treatment',
          amount: 250.00,
        })
        .expect(201);

      const summary = await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(summary.body.charges).toHaveLength(1);
      expect(summary.body.charges[0].amount).toBe('250.00');
      expect(summary.body.outstandingEur).toBe('250.00');
    });
  });

  // ============================================================
  // 5. DEPOSIT SETTLEMENT & AUTOMATIC REFUND
  // ============================================================
  describe('5. Deposit Settlement & Automated Refund Ledger', () => {
    it('settles deposit retaining €250 for cleaning fee and refunding €1750 to client', async () => {
      const res = await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalA}/deposit/settle`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({
          retainedAmount: 250.00,
          reason: 'Specialist interior leather treatment',
          method: 'bank_transfer',
          reference: 'WIRE-REFUND-DEP-01',
        })
        .expect(201);

      expect(res.body.settled).toBe(true);
      expect(res.body.status).toBe('partially_retained');
      expect(res.body.retainedEur).toBe('250.00');
      expect(res.body.refundEur).toBe('1750.00');

      // Verify that the deposit refund is recorded in the payment ledger
      const summary = await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(summary.body.deposit.status).toBe('partially_retained');
      expect(summary.body.deposit.retainedAmount).toBe('250.00');
      expect(summary.body.deposit.refundedAmount).toBe('1750.00');
      expect(summary.body.deposit.retentionReason).toBe('Specialist interior leather treatment');

      const refundEntry = summary.body.payments.find((p: any) => p.type === 'deposit_refund');
      expect(refundEntry).toBeDefined();
      expect(refundEntry?.amount).toBe('1750.00');
      expect(refundEntry?.reference).toBe('WIRE-REFUND-DEP-01');
    });
  });

  // ============================================================
  // 6. INVOICE ISSUANCE & GAPLESS SEQUENTIAL NUMBERING
  // ============================================================
  describe('6. Sequential Invoicing & Legal Documents', () => {
    let invoice1Number: string;
    let invoice2Number: string;

    it('issues gapless sequential invoice for first rental contract', async () => {
      const res = await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalA}/invoice`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(201);

      expect(res.body.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
      expect(res.body.totalAmount).toBe('1850.00'); // 1600 base + 250 cleaning
      invoice1Number = res.body.invoiceNumber;
    });

    it('issues next sequential invoice for second rental contract without gaps', async () => {
      // First return rental B so invoice can be issued
      await request(app.getHttpServer())
        .post(`/returns/admin/${ID.rentalB}/return`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({
          mileageKm: 18000,
          fuelLevelPct: 100,
          keysReturned: true,
          condition: 'excellent',
          damages: [],
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/finance/admin/${ID.rentalB}/invoice`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(201);

      expect(res.body.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
      invoice2Number = res.body.invoiceNumber;

      // Verify gapless increment: e.g. INV-2026-000001 -> INV-2026-000002
      const seq1 = parseInt(invoice1Number.slice(-6), 10);
      const seq2 = parseInt(invoice2Number.slice(-6), 10);
      expect(seq2).toBe(seq1 + 1);
    });

    it('downloads the official luxury invoice PDF and verifies demo watermark', async () => {
      const res = await request(app.getHttpServer())
        .get(`/finance/admin/${ID.rentalA}/documents/invoice`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(res.headers['content-type']).toBe('application/pdf');
      const buffer = res.body as Buffer;
      expect(buffer.toString('ascii', 0, 8)).toBe('%PDF-1.4');

      // Verify demo watermarks in PDF
      const pdfText = buffer.toString('latin1');
      expect(pdfText).toContain('INVOICE - DEMO');
      expect(pdfText).toContain('LUXURY CARS - DEMONSTRATION DOCUMENT');
    });
  });
});
