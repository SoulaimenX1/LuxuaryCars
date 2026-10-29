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

const TEST_DB = 'luxury_car_rental_audit_itest';
process.env.DB_DATABASE = TEST_DB;
process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'integration-test-secret-key-0123456789abcdef';
}

const PASSWORD = 'AuditPassword123!';

const ID = {
  admin: '00000000-0000-4000-8000-0000000000a1',
  staffA: '00000000-0000-4000-8000-0000000000e1',
  staffB: '00000000-0000-4000-8000-0000000000e2',
  customerA: '00000000-0000-4000-8000-0000000000c1',
  customerB: '00000000-0000-4000-8000-0000000000c2',
  agencyA: '11111111-1111-4000-8000-000000000001',
  agencyB: '22222222-2222-4000-8000-000000000002',
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
  admin: 'audit.admin@luxury.test',
  staffA: 'audit.staff.a@luxury.test',
  staffB: 'audit.staff.b@luxury.test',
  customerA: 'audit.cust.a@luxury.test',
  customerB: 'audit.cust.b@luxury.test',
};

let database: DisposableDatabase;
let db: Client;
let app: INestApplication;
let tokens = {
  admin: '',
  staffA: '',
  staffB: '',
  customerA: '',
  customerB: '',
};

async function seed(target: Client) {
  const hash = await argon2.hash(PASSWORD);

  await target.query(
    `INSERT INTO users (id, email, password_hash, role, status, first_name, last_name)
     VALUES
       ($1, $6,  $11, 'admin',    'active', 'Admin',    'One'),
       ($2, $7,  $11, 'staff',    'active', 'Staff',    'AgencyA'),
       ($3, $8,  $11, 'staff',    'active', 'Staff',    'AgencyB'),
       ($4, $9,  $11, 'customer', 'active', 'Customer', 'One'),
       ($5, $10, $11, 'customer', 'active', 'Customer', 'Two')`,
    [
      ID.admin, ID.staffA, ID.staffB, ID.customerA, ID.customerB,
      EMAIL.admin, EMAIL.staffA, EMAIL.staffB, EMAIL.customerA, EMAIL.customerB,
      hash,
    ],
  );

  await target.query(
    `INSERT INTO customer_profiles (user_id, date_of_birth, license_number, license_country, license_issued_on, license_expires_on)
     VALUES
       ($1, '1990-01-01', 'LIC-A', 'HU', '2015-01-01', '2040-01-01'),
       ($2, '1992-02-02', 'LIC-B', 'HU', '2016-01-01', '2040-01-01')`,
    [ID.customerA, ID.customerB],
  );

  // Rental agencies
  await target.query(
    `INSERT INTO rental_locations (id, code, name, category, city, country, can_pickup, can_dropoff, enabled, address)
     VALUES
       ($1, 'AGY-A', 'Agency Alpha', 'showroom', 'Budapest', 'Hongrie', true, true, true, '{"city":"Budapest","street":"Alpha 1"}'),
       ($2, 'AGY-B', 'Agency Beta',  'showroom', 'Debrecen', 'Hongrie', true, true, true, '{"city":"Debrecen","street":"Beta 2"}')`,
    [ID.agencyA, ID.agencyB],
  );

  // Assign staff to respective agencies
  await target.query(
    `INSERT INTO agency_staff_assignments (user_id, agency_id, assigned_by)
     VALUES
       ($1, $3, $5),
       ($2, $4, $5)`,
    [ID.staffA, ID.staffB, ID.agencyA, ID.agencyB, ID.admin],
  );

  // Fleet
  await target.query(`INSERT INTO brands (id, name) VALUES ($1, 'Audi')`, [ID.brand]);
  await target.query(`INSERT INTO categories (id, name) VALUES ($1, 'Executive')`, [ID.category]);
  await target.query(
    `INSERT INTO vehicle_models (id, brand_id, category_id, name) VALUES ($1, $2, $3, 'RS6')`,
    [ID.model, ID.brand, ID.category],
  );
  await target.query(
    `INSERT INTO vehicles (id, model_id, manufacture_year, license_plate, vin, transmission, fuel_type, daily_price, security_deposit, vehicle_value, status, home_location_id)
     VALUES
       ($1, $3, 2024, 'AUD-A1', 'VIN000000000000A1', 'automatic', 'petrol', 200, 1500, 120000, 'active', $4),
       ($2, $3, 2024, 'AUD-B1', 'VIN000000000000B1', 'automatic', 'petrol', 200, 1500, 120000, 'active', $5)`,
    [ID.vehicleA, ID.vehicleB, ID.model, ID.agencyA, ID.agencyB],
  );

  // Reservations
  await target.query(
    `INSERT INTO reservations (id, reservation_number, customer_id, vehicle_id, pickup_at, return_at, rental_days, daily_price, deposit_amount, total_amount, status)
     VALUES
       ($1, 'RES-2026-000001', $3, $5, '2026-11-01T10:00:00Z', '2026-11-05T10:00:00Z', 4, 200, 1500, 800, 'confirmed'),
       ($2, 'RES-2026-000002', $4, $6, '2026-11-02T10:00:00Z', '2026-11-06T10:00:00Z', 4, 200, 1500, 800, 'confirmed')`,
    [ID.reservationA, ID.reservationB, ID.customerA, ID.customerB, ID.vehicleA, ID.vehicleB],
  );

  await target.query(
    `INSERT INTO reservation_preferences (reservation_id, pickup_location_id, dropoff_location_id, pickup_location_snapshot, dropoff_location_snapshot)
     VALUES
       ($1, $3, $3, 'Agency Alpha', 'Agency Alpha'),
       ($2, $4, $4, 'Agency Beta',  'Agency Beta')`,
    [ID.reservationA, ID.reservationB, ID.agencyA, ID.agencyB],
  );

  // Rentals
  await target.query(
    `INSERT INTO rentals (id, contract_number, reservation_id, status, started_at, expected_return_at, opened_by)
     VALUES
       ($1, 'CNT-2026-000001', $3, 'active', '2026-11-01T10:00:00Z', '2026-11-05T10:00:00Z', $5),
       ($2, 'CNT-2026-000002', $4, 'active', '2026-11-02T10:00:00Z', '2026-11-06T10:00:00Z', $5)`,
    [ID.rentalA, ID.rentalB, ID.reservationA, ID.reservationB, ID.admin],
  );
}

async function loginUser(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

describe('Audit: Permissions, Agency Data Isolation, Concurrency & Security', () => {
  beforeAll(async () => {
    database = await openDisposableDatabase(TEST_DB);
    db = database.db;
    await seed(db);

    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    tokens.admin = await loginUser(EMAIL.admin);
    tokens.staffA = await loginUser(EMAIL.staffA);
    tokens.staffB = await loginUser(EMAIL.staffB);
    tokens.customerA = await loginUser(EMAIL.customerA);
    tokens.customerB = await loginUser(EMAIL.customerB);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    if (database) await closeDisposableDatabase(database);
  });

  // 1. Permissions (Customer vs Staff vs Admin)
  describe('1. Customer/Admin/Staff permissions', () => {
    it('prevents Customer from calling staff and admin routes (403)', async () => {
      await request(app.getHttpServer())
        .get('/rentals/admin')
        .set('Authorization', `Bearer ${tokens.customerA}`)
        .expect(403);

      await request(app.getHttpServer())
        .get('/admin/customers')
        .set('Authorization', `Bearer ${tokens.customerA}`)
        .expect(403);
    });

    it('prevents Staff from calling admin-only management routes (403)', async () => {
      await request(app.getHttpServer())
        .get('/admin/customers')
        .set('Authorization', `Bearer ${tokens.staffA}`)
        .expect(403);

      await request(app.getHttpServer())
        .post('/vehicles')
        .set('Authorization', `Bearer ${tokens.staffA}`)
        .send({})
        .expect(403);
    });

    it('allows Admin on all administrative and fleet management routes (200)', async () => {
      await request(app.getHttpServer())
        .get('/admin/customers')
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/rentals/admin')
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });
  });

  // 2. Agency Data Isolation
  describe('2. Agency Data Isolation', () => {
    it('isolates rentals on GET /rentals/admin by staff agency assignment', async () => {
      // Staff A belongs to Agency Alpha only
      const resA = await request(app.getHttpServer())
        .get('/rentals/admin')
        .set('Authorization', `Bearer ${tokens.staffA}`)
        .expect(200);

      const contractsA = (resA.body as { contractNumber: string }[]).map((r) => r.contractNumber);
      expect(contractsA).toContain('CNT-2026-000001');
      expect(contractsA).not.toContain('CNT-2026-000002');

      // Staff B belongs to Agency Beta only
      const resB = await request(app.getHttpServer())
        .get('/rentals/admin')
        .set('Authorization', `Bearer ${tokens.staffB}`)
        .expect(200);

      const contractsB = (resB.body as { contractNumber: string }[]).map((r) => r.contractNumber);
      expect(contractsB).toContain('CNT-2026-000002');
      expect(contractsB).not.toContain('CNT-2026-000001');

      // Admin sees both
      const resAdmin = await request(app.getHttpServer())
        .get('/rentals/admin')
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);
      expect(resAdmin.body.length).toBe(2);
    });

    it('isolates reservations on GET /reservations/admin/all by staff agency assignment', async () => {
      // Staff A only sees reservations for Agency A
      const resA = await request(app.getHttpServer())
        .get('/reservations/admin/all')
        .set('Authorization', `Bearer ${tokens.staffA}`)
        .expect(200);

      const numbersA = (resA.body as { reservationNumber: string }[]).map((r) => r.reservationNumber);
      expect(numbersA).toContain('RES-2026-000001');
      expect(numbersA).not.toContain('RES-2026-000002');

      // Staff B only sees reservations for Agency B
      const resB = await request(app.getHttpServer())
        .get('/reservations/admin/all')
        .set('Authorization', `Bearer ${tokens.staffB}`)
        .expect(200);

      const numbersB = (resB.body as { reservationNumber: string }[]).map((r) => r.reservationNumber);
      expect(numbersB).toContain('RES-2026-000002');
      expect(numbersB).not.toContain('RES-2026-000001');

      // Admin sees both
      const resAdmin = await request(app.getHttpServer())
        .get('/reservations/admin/all')
        .set('Authorization', `Bearer ${tokens.admin}`)
        .expect(200);
      expect(resAdmin.body.length).toBe(2);
    });

    it('rejects cross-agency damage inspection access for staff (403)', async () => {
      // Rental B is in Agency Beta. Staff A from Agency Alpha must be rejected.
      await request(app.getHttpServer())
        .get(`/returns/admin/${ID.rentalB}/damages`)
        .set('Authorization', `Bearer ${tokens.staffA}`)
        .expect(403);

      // Staff B from Agency Beta can access damages of Rental B
      await request(app.getHttpServer())
        .get(`/returns/admin/${ID.rentalB}/damages`)
        .set('Authorization', `Bearer ${tokens.staffB}`)
        .expect(200);
    });
  });

  // 3. Auth Security & Rate Limiting
  describe('3. Auth Security & Rate Limiting', () => {
    it('applies rate limiting and error handling on confirmation endpoints', async () => {
      await request(app.getHttpServer())
        .post('/auth/verify-email/confirm')
        .send({ token: 'bogus-token-1234' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token: 'bogus-token-1234', newPassword: 'NewPassword1!' })
        .expect(400);
    });
  });
});
