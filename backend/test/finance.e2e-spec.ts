import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource, type EntityManager } from 'typeorm';
import dotenv from 'dotenv';
import { ConflictException } from '@nestjs/common';
import { FinanceService } from '../src/finance/finance.service.js';

dotenv.config();

const DB_HOST = process.env.DB_HOST ?? 'localhost';
const DB_PORT = Number(process.env.DB_PORT ?? 5432);
const DB_USER = process.env.DB_USERNAME ?? 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD ?? '';
const TEST_DB = `luxury_car_rental_finance_${process.pid}_${randomUUID().slice(0, 8)}`;
const BACKEND_ROOT = join(__dirname, '..');
const SCHEMA_FILE = join(BACKEND_ROOT, 'database', 'schema.sql');
const PATCH_DIR = join(BACKEND_ROOT, 'database', 'patches');

const ID = {
  admin: '00000000-0000-4000-8000-000000000011',
  customer: '00000000-0000-4000-8000-000000000012',
  brand: 'f0000000-0000-4000-8000-000000000011',
  category: 'c0000000-0000-4000-8000-000000000011',
  model: 'd0000000-0000-4000-8000-000000000011',
  vehicle: 'a0000000-0000-4000-8000-000000000011',
};

let admin: Client | undefined;
let db: Client | undefined;
let service: FinanceService;
let reservationId: string;
let rentalId: string;
let databaseCreated = false;

function clientFor(database: string) {
  return new Client({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database,
  });
}

function dataSourceFor(client: Client): DataSource {
  const query = async (sql: string, parameters: unknown[] = []) =>
    (await client.query(sql, parameters)).rows;
  return {
    query,
    transaction: async <T>(
      work: (manager: EntityManager) => Promise<T>,
    ) => {
      await client.query('BEGIN');
      try {
        const result = await work({ query } as unknown as EntityManager);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DataSource;
}

async function applyBaseline(target: Client) {
  await target.query(readFileSync(SCHEMA_FILE, 'utf8'));
  const patches = readdirSync(PATCH_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort();
  for (const patch of patches) {
    await target.query(readFileSync(join(PATCH_DIR, patch), 'utf8'));
  }
}

async function seed(target: Client) {
  await target.query(
    `INSERT INTO users (id, email, password_hash, role, first_name, last_name)
     VALUES
       ($1, 'finance.admin@example.test', 'x', 'admin', 'Finance', 'Admin'),
       ($2, 'finance.customer@example.test', 'x', 'customer', 'Finance', 'Customer')`,
    [ID.admin, ID.customer],
  );
  await target.query(
    `INSERT INTO customer_profiles
       (user_id, date_of_birth, license_number, license_country,
        license_issued_on, license_expires_on)
     VALUES ($1, '1990-01-01', 'FINANCE-ITEST', 'HU',
             '2015-01-01', '2040-01-01')`,
    [ID.customer],
  );
  await target.query(
    `INSERT INTO brands (id, name) VALUES ($1, 'Finance Integration Motors')`,
    [ID.brand],
  );
  await target.query(
    `INSERT INTO categories (id, name) VALUES ($1, 'Finance Integration GT')`,
    [ID.category],
  );
  await target.query(
    `INSERT INTO vehicle_models (id, brand_id, category_id, name)
     VALUES ($1, $2, $3, 'Ledger One')`,
    [ID.model, ID.brand, ID.category],
  );
  await target.query(
    `INSERT INTO vehicles
       (id, model_id, manufacture_year, license_plate, vin, transmission,
        fuel_type, daily_price, security_deposit, vehicle_value, status)
     VALUES ($1, $2, 2025, 'FIN-ITEST', 'FINANCE0000000001',
             'automatic', 'petrol', 400.00, 800.00, 200000.00, 'active')`,
    [ID.vehicle, ID.model],
  );
  const reservations = await target.query(
    `INSERT INTO reservations
       (customer_id, vehicle_id, pickup_at, return_at, rental_days,
        daily_price, deposit_amount, total_amount, status)
     VALUES ($1, $2, '2035-11-25T10:00:00Z', '2035-11-28T10:00:00Z',
             3, 400.00, 800.00, 1200.00, 'confirmed')
     RETURNING id`,
    [ID.customer, ID.vehicle],
  );
  reservationId = reservations.rows[0].id as string;

  await target.query(
    `UPDATE reservations SET status = 'converted' WHERE id = $1::uuid`,
    [reservationId],
  );
  const rentals = await target.query(
    `INSERT INTO rentals
       (reservation_id, status, started_at, expected_return_at,
        returned_at, opened_by)
     VALUES ($1, 'returned', '2035-11-25T10:00:00Z',
             '2035-11-28T10:00:00Z', '2035-11-28T10:00:00Z', $2)
     RETURNING id`,
    [reservationId, ID.admin],
  );
  rentalId = rentals.rows[0].id as string;
}

describe('FinanceService isolated PostgreSQL workflows', () => {
  beforeAll(async () => {
    admin = clientFor('postgres');
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    databaseCreated = true;
    db = clientFor(TEST_DB);
    await db.connect();
    await applyBaseline(db);
    await seed(db);
    service = new FinanceService(dataSourceFor(db));
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
    if (admin) {
      if (databaseCreated) {
        await admin.query(`DROP DATABASE ${TEST_DB} WITH (FORCE)`);
      }
      await admin.end();
    }
  }, 120_000);

  it('records partial and full rental payments, rejecting duplicates and overpayment', async () => {
    await service.recordReservationPayment(ID.admin, reservationId, {
      type: 'rental_payment',
      method: 'bank_transfer',
      amount: 450,
      reference: 'FIN-RENTAL-450',
    });
    const partial = await service.reservationSummary(reservationId, ID.customer);
    expect(partial.paymentStatus).toBe('PARTIALLY_PAID');
    expect(partial.amountPaidEur).toBe('450.00');
    expect(partial.outstandingEur).toBe('750.00');

    await expect(
      service.recordReservationPayment(ID.admin, reservationId, {
        type: 'rental_payment',
        method: 'bank_transfer',
        amount: 450,
        reference: 'FIN-RENTAL-450',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.recordReservationPayment(ID.admin, reservationId, {
        type: 'rental_payment',
        method: 'card',
        amount: 751,
        reference: 'FIN-RENTAL-OVER',
      }),
    ).rejects.toThrow('exceeds the outstanding rental balance');

    await service.recordReservationPayment(ID.admin, reservationId, {
      type: 'rental_payment',
      method: 'cash',
      amount: 750,
      reference: 'FIN-RENTAL-750',
    });
    const paid = await service.reservationSummary(reservationId, ID.customer);
    expect(paid.paymentStatus).toBe('PAID');
    expect(paid.amountPaidEur).toBe('1200.00');
    expect(paid.outstandingEur).toBe('0.00');
  });

  it('tracks deposits separately, settles only after return, and preserves ledger history', async () => {
    await service.recordDepositReceipt(ID.admin, reservationId, {
      method: 'cash',
      amount: 300,
      reference: 'FIN-DEPOSIT-300',
    });
    const partial = await service.reservationSummary(reservationId, ID.customer);
    expect(partial.deposit).toMatchObject({
      status: 'pending',
      receivedAmount: '300.00',
      outstandingAmount: '500.00',
    });
    expect(partial.amountPaidEur).toBe('1200.00');

    await service.recordDepositReceipt(ID.admin, reservationId, {
      method: 'bank_transfer',
      amount: 500,
      reference: 'FIN-DEPOSIT-500',
    });
    const held = await service.reservationSummary(reservationId, ID.customer);
    expect(held.deposit).toMatchObject({
      status: 'held',
      receivedAmount: '800.00',
      outstandingAmount: '0.00',
    });
    expect(held.amountPaidEur).toBe('1200.00');

    await expect(
      service.settleDeposit(ID.admin, rentalId, {
        retainedAmount: 100,
        reason: 'Contractual damage deduction',
        method: 'bank_transfer',
        reference: 'FIN-DEPOSIT-REFUND',
      }),
    ).resolves.toMatchObject({
      settled: true,
      status: 'partially_retained',
      retainedEur: '100.00',
      refundEur: '700.00',
    });

    await expect(
      db!.query(
        `UPDATE payments SET reference = 'CHANGED'
         WHERE reference = 'FIN-RENTAL-450'`,
      ),
    ).rejects.toThrow('append-only');
    await expect(
      db!.query(
        `DELETE FROM audit_logs
         WHERE action = 'SECURITY_DEPOSIT_SETTLED'`,
      ),
    ).rejects.toThrow('immutable');

    const settled = await service.summary(rentalId, ID.customer);
    expect(settled.deposit).toMatchObject({
      status: 'partially_retained',
      receivedAmount: '800.00',
      refundedAmount: '700.00',
      retainedAmount: '100.00',
      retentionReason: 'Contractual damage deduction',
    });
    expect(settled.payments).toHaveLength(5);
    expect(settled.amountPaidEur).toBe('1200.00');
  });

  it('rejects customer access to another customer financial dossier', async () => {
    await expect(
      service.reservationSummary(reservationId, ID.admin),
    ).rejects.toThrow('Reservation not found');
  });
});
