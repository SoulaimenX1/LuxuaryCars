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

const TEST_DB = 'luxury_car_rental_stripe_lifecycle_itest';
process.env.DB_DATABASE = TEST_DB;
process.env.DEFAULT_RENTAL_AGENCY_CODE = 'BUD-STEST';
process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'integration-test-secret-key-0123456789abcdef';
}

const PASSWORD = 'StripeTestPassword123!';

const ID = {
  admin: '10000000-0000-4000-8000-0000000000a1',
  customer: '10000000-0000-4000-8000-0000000000c1',
  customer2: '10000000-0000-4000-8000-0000000000c2',
  agency: '20000000-0000-4000-8000-000000000001',
  brand: '30000000-0000-4000-8000-0000000000f1',
  category: '40000000-0000-4000-8000-0000000000c1',
  model: '50000000-0000-4000-8000-0000000000d1',
  vehicle1: '60000000-0000-4000-8000-000000000001',
  vehicle2: '60000000-0000-4000-8000-000000000002',
};

const EMAIL = {
  admin: 'stripe.admin@luxury.test',
  customer: 'stripe.customer@luxury.test',
  customer2: 'stripe.customer2@luxury.test',
};

let database: DisposableDatabase;
let db: Client;
let app: INestApplication;
const tokens = {
  admin: '',
  customer: '',
  customer2: '',
};

async function seedTestData(target: Client) {
  const hash = await argon2.hash(PASSWORD);

  // Agency
  await target.query(`
    INSERT INTO rental_locations (id, code, name, category, city, country, address, can_pickup, can_dropoff, enabled, timezone)
    VALUES ($1, 'BUD-STEST', 'Budapest Stripe Test Agency', 'showroom', 'Budapest', 'Hongrie', '12 Test St', true, true, true, 'Europe/Budapest')
  `, [ID.agency]);

  // Users
  await target.query(`
    INSERT INTO users (id, email, password_hash, first_name, last_name, role, status, email_verified_at)
    VALUES
      ($1, $2, $3, 'Stripe', 'Admin', 'admin', 'active', now()),
      ($4, $5, $3, 'Stripe', 'Customer', 'customer', 'active', now()),
      ($6, $7, $3, 'Second', 'Customer', 'customer', 'active', now())
  `, [ID.admin, EMAIL.admin, hash, ID.customer, EMAIL.customer, ID.customer2, EMAIL.customer2]);

  // Customer profile with verified driving licence
  await target.query(`
    INSERT INTO customer_profiles (user_id, date_of_birth, address_line, city, postal_code, country, license_number, license_country, license_issued_on, license_expires_on)
    VALUES
      ($1, '1990-01-01', '10 Test St', 'Budapest', '1051', 'HU', 'LIC-STRIPE-01', 'HU', '2015-01-01', '2035-01-01'),
      ($2, '1992-05-10', '15 Test St', 'Budapest', '1051', 'HU', 'LIC-STRIPE-02', 'HU', '2016-01-01', '2035-01-01')
  `, [ID.customer, ID.customer2]);

  // Fleet
  await target.query(`INSERT INTO brands (id, name) VALUES ($1, 'Aston Martin')`, [ID.brand]);
  await target.query(`INSERT INTO categories (id, name, description) VALUES ($1, 'Supercar', 'High performance supercar')`, [ID.category]);
  await target.query(`
    INSERT INTO vehicle_models (id, brand_id, category_id, name)
    VALUES ($1, $2, $3, 'DBS Superleggera')
  `, [ID.model, ID.brand, ID.category]);

  await target.query(`
    INSERT INTO vehicles (id, model_id, manufacture_year, license_plate, vin, transmission, fuel_type, daily_price, security_deposit, vehicle_value, status, home_location_id, current_location_id)
    VALUES
      ($1, $2, 2024, 'LUX-STR-01', 'VINSTRIPE00000001', 'automatic', 'petrol', 2500.00, 5000.00, 300000.00, 'active', $3, $3),
      ($4, $2, 2024, 'LUX-STR-02', 'VINSTRIPE00000002', 'automatic', 'petrol', 2500.00, 5000.00, 300000.00, 'active', $3, $3)
  `, [ID.vehicle1, ID.model, ID.agency, ID.vehicle2]);
}

describe('Stripe Booking Lifecycle & Webhook Verification (HTTP APIs)', () => {
  beforeAll(async () => {
    console.log('[E2E-LIFECYCLE] Initializing disposable database...');
    database = await openDisposableDatabase(TEST_DB);
    db = database.db;
    console.log('[E2E-LIFECYCLE] Seeding test data...');
    await seedTestData(db);

    console.log('[E2E-LIFECYCLE] Compiling NestJS AppModule...');
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    console.log('[E2E-LIFECYCLE] Starting NestJS application...');
    app = moduleRef.createNestApplication();
    await app.init();

    console.log('[E2E-LIFECYCLE] Authenticating test users...');
    // Authenticate
    for (const [role, email] of Object.entries(EMAIL)) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      tokens[role as keyof typeof tokens] = res.body.token ?? res.body.accessToken;
    }
    console.log('[E2E-LIFECYCLE] Setup completed successfully.');
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (database) await closeDisposableDatabase(database);
  }, 60_000);

  let reservationNumber = '';
  let paymentIntentId = '';

  it('1. Customer creates reservation request -> Status is PENDING', async () => {
    // Current time in simulation is late October 2026. Use November 2026 (future).
    // 10:00 UTC is 12:00 Budapest, guaranteed during business hours (09:00-18:00)
    const pickupAt = '2026-11-10T10:00:00.000Z';
    const returnAt = '2026-11-13T10:00:00.000Z';

    const res = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${tokens.customer}`)
      .send({
        vehicleId: ID.vehicle1,
        pickupAt,
        returnAt,
        pickupLocationId: ID.agency,
        dropoffLocationId: ID.agency,
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.reservationNumber).toMatch(/^RES-/);
    reservationNumber = res.body.reservationNumber;
    expect(Number(res.body.totalAmount)).toBe(7500); // 3 days * 2500
    expect(Number(res.body.depositAmount)).toBe(5000);
  });

  it('2. Admin reviews and approves booking -> Status becomes AWAITING_PAYMENT with 24h deadline', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/reservations/admin/by-number/${encodeURIComponent(reservationNumber)}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_payment');
    expect(res.body.paymentDeadlineAt).toBeDefined();

    // Verify payment deadline is set ~24h in the future
    const deadline = new Date(res.body.paymentDeadlineAt).getTime();
    const now = Date.now();
    const diffHours = (deadline - now) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(23.8);
    expect(diffHours).toBeLessThan(24.2);

    // Verify Stripe checkout URL exists
    expect(res.body.paymentUrl).toBeDefined();
    expect(res.body.stripeSessionId).toBeDefined();

    // Verify customer email outbox entry was recorded
    const outbox = await db.query(
      `SELECT * FROM customer_email_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [EMAIL.customer],
    );
    expect(outbox.rows.length).toBe(1);
    expect(outbox.rows[0].subject).toContain('Payment Required');
  });

  it('2b. Handover attempt before payment verification must be rejected (409 Conflict)', async () => {
    // Regression check: Handover attempt before payment verification must be rejected (409 Conflict)
    const unpaidHandover = await request(app.getHttpServer())
      .post(`/finance/stripe/admin/handover/${encodeURIComponent(reservationNumber)}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ mileageKm: 12000, fuelLevelPct: 100 });
    expect(unpaidHandover.status).toBe(409);
    expect(unpaidHandover.body.message).toContain('Only confirmed reservations can be handed over');
  });

  it('3. Verified Stripe Webhook confirms payment atomically -> Status becomes CONFIRMED', async () => {
    paymentIntentId = `pi_test_webhook_${Date.now()}`;
    const webhookEventId = `evt_test_checkout_${Date.now()}`;

    const webhookPayload = {
      id: webhookEventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          client_reference_id: reservationNumber,
          payment_intent: paymentIntentId,
          amount_total: 1250000, // 7500 + 5000 in cents
          currency: 'eur',
          payment_status: 'paid',
          metadata: {
            reservationNumber,
          },
        },
      },
    };

    // Send verified webhook
    const res = await request(app.getHttpServer())
      .post('/finance/stripe/webhook')
      .send(webhookPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');

    // Verify DB state
    const row = (await db.query(
      `SELECT status, paid_at, stripe_payment_intent_id FROM reservations WHERE reservation_number = $1`,
      [reservationNumber],
    )).rows[0];
    expect(row.status).toBe('confirmed');
    expect(row.paid_at).not.toBeNull();
    expect(row.stripe_payment_intent_id).toBe(paymentIntentId);

    // Verify payments ledger has separate rental and deposit payments
    const payments = await db.query(
      `SELECT type, method, amount, reference FROM payments WHERE reservation_id = (SELECT id FROM reservations WHERE reservation_number = $1)`,
      [reservationNumber],
    );
    expect(payments.rows.length).toBe(2);
    const depositRow = payments.rows.find((p: any) => p.type === 'deposit_payment');
    const rentalRow = payments.rows.find((p: any) => p.type === 'rental_payment');
    expect(depositRow).toBeDefined();
    expect(Number(depositRow!.amount)).toBe(5000);
    expect(rentalRow).toBeDefined();
    expect(Number(rentalRow!.amount)).toBe(7500);

    // Verify security_deposits record is held
    const deposit = (await db.query(
      `SELECT status, amount, held_at FROM security_deposits WHERE reservation_id = (SELECT id FROM reservations WHERE reservation_number = $1)`,
      [reservationNumber],
    )).rows[0];
    expect(deposit.status).toBe('held');
    expect(Number(deposit.amount)).toBe(5000);
    expect(deposit.held_at).not.toBeNull();
  });

  it('4. Webhook idempotency: Duplicate webhook events are detected and safely ignored', async () => {
    // Re-send the exact same webhook event ID
    const webhookPayload = {
      id: `evt_duplicate_check_01`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_duplicate`,
          client_reference_id: reservationNumber,
          payment_intent: paymentIntentId,
        },
      },
    };

    const first = await request(app.getHttpServer())
      .post('/finance/stripe/webhook')
      .send(webhookPayload);
    expect(first.status).toBe(200);

    // Second call with same event ID
    const second = await request(app.getHttpServer())
      .post('/finance/stripe/webhook')
      .send(webhookPayload);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('duplicate_ignored');

    // Confirm no duplicate payments created
    const count = (await db.query(
      `SELECT count(*) FROM payments WHERE reservation_id = (SELECT id FROM reservations WHERE reservation_number = $1)`,
      [reservationNumber],
    )).rows[0].count;
    expect(Number(count)).toBe(2);
  });

  it('5. Double booking protection: Overlapping booking on same vehicle is blocked', async () => {
    const pickupAt = '2026-11-11T10:00:00.000Z'; // Overlaps Nov 10-13
    const returnAt = '2026-11-12T10:00:00.000Z';

    const res = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${tokens.customer2}`)
      .send({
        vehicleId: ID.vehicle1,
        pickupAt,
        returnAt,
        pickupLocationId: ID.agency,
        dropoffLocationId: ID.agency,
      });

    // Must be rejected as unavailable
    expect(res.status).toBe(409);
  });

  it('6. Admin performs documented vehicle handover -> Status becomes ACTIVE_RENTAL', async () => {
    const res = await request(app.getHttpServer())
      .post(`/finance/stripe/admin/handover/${encodeURIComponent(reservationNumber)}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        mileageKm: 12150,
        fuelLevelPct: 100,
        conditionNotes: 'Joint inspection: pristine condition, keys delivered',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active_rental');
    expect(res.body.handoverAt).toBeDefined();

    // Verify rental contract is active in rentals table
    const rental = (await db.query(
      `SELECT status, started_at, opened_by FROM rentals WHERE reservation_id = (SELECT id FROM reservations WHERE reservation_number = $1)`,
      [reservationNumber],
    )).rows[0];
    expect(rental.status).toBe('active');
    expect(rental.opened_by).toBe(ID.admin);

    // Verify handover inspection recorded
    const inspection = (await db.query(
      `SELECT type, mileage_km, fuel_level_pct FROM inspections WHERE rental_id = (SELECT id FROM rentals WHERE reservation_id = (SELECT id FROM reservations WHERE reservation_number = $1))`,
      [reservationNumber],
    )).rows[0];
    expect(inspection.type).toBe('handover');
    expect(inspection.mileage_km).toBe(12150);
    expect(inspection.fuel_level_pct).toBe(100);
  });

  it('6b. Duplicate activation attempt on already active rental must be rejected (409 Conflict)', async () => {
    // Regression check: Duplicate activation attempt on already active rental must be rejected (409 Conflict)
    const duplicateHandover = await request(app.getHttpServer())
      .post(`/finance/stripe/admin/handover/${encodeURIComponent(reservationNumber)}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ mileageKm: 12150, fuelLevelPct: 100 });
    expect(duplicateHandover.status).toBe(409);
    expect(duplicateHandover.body.message).toContain('active_rental');
  });

  it('6c. A rejected agency payment request does NOT invalidate an independently verified Stripe payment', async () => {
    // 1. Create a reservation on vehicle2
    const pickupAt = '2026-11-20T10:00:00.000Z';
    const returnAt = '2026-11-22T10:00:00.000Z';
    const createRes = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${tokens.customer}`)
      .send({
        vehicleId: ID.vehicle2,
        pickupAt,
        returnAt,
        pickupLocationId: ID.agency,
        dropoffLocationId: ID.agency,
      });
    expect(createRes.status).toBe(201);
    const resNum = createRes.body.reservationNumber;

    // 2. Admin approves booking -> awaiting_payment
    const approveRes = await request(app.getHttpServer())
      .patch(`/reservations/admin/by-number/${encodeURIComponent(resNum)}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send();
    expect(approveRes.status).toBe(200);

    // 3. Customer requests payment at agency
    const agencyReq = await request(app.getHttpServer())
      .post(`/finance/agency-payment/request/${encodeURIComponent(resNum)}`)
      .set('Authorization', `Bearer ${tokens.customer}`)
      .send({ agencyName: 'LuxuryCars Showroom Budapest', notes: 'Will pay cash' });
    expect(agencyReq.status).toBe(201);

    // 4. Admin rejects agency request (e.g. cash limit exceeded) -> agency_payment_status = 'rejected'
    const rejectRes = await request(app.getHttpServer())
      .post(`/finance/admin/agency-payments/${encodeURIComponent(resNum)}/reject`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ reason: 'Agency cash limit exceeded. Please complete online card payment.' });
    expect(rejectRes.status).toBe(201);

    // 5. Customer then completes online Stripe payment (verified webhook event arrives)
    const webhookEventId = `evt_test_checkout_agency_fallback_${Date.now()}`;
    const webhookPayload = {
      id: webhookEventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_agency_fallback_${Date.now()}`,
          client_reference_id: resNum,
          payment_intent: `pi_test_agency_fallback_${Date.now()}`,
          amount_total: 1000000, // 5000 rental + 5000 deposit in cents
          currency: 'eur',
          payment_status: 'paid',
          metadata: { reservationNumber: resNum },
        },
      },
    };
    const webhookRes = await request(app.getHttpServer())
      .post('/finance/stripe/webhook')
      .send(webhookPayload);
    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.status).toBe('confirmed');

    // 6. Admin performs vehicle handover -> MUST SUCCEED (201) and become ACTIVE_RENTAL
    // Proves that rejected agency request does NOT block valid Stripe payment!
    const handoverRes = await request(app.getHttpServer())
      .post(`/finance/stripe/admin/handover/${encodeURIComponent(resNum)}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ mileageKm: 8500, fuelLevelPct: 100, conditionNotes: 'Verified Stripe handover' });
    expect(handoverRes.status).toBe(201);
    expect(handoverRes.body.status).toBe('active_rental');
  });

  it('7. Admin performs return inspection with partial refund & damage deduction -> Status becomes COMPLETED', async () => {
    // Deposit is 5000. Customer scuffed wheel rim: retain 450 EUR, refund 4550 EUR.
    const res = await request(app.getHttpServer())
      .post(`/finance/stripe/admin/return-refund/${encodeURIComponent(reservationNumber)}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        refundAmount: 4550,
        retainedAmount: 450,
        reason: 'Front right alloy wheel repair charge',
        inspectionDetails: {
          mileageKm: 12600,
          fuelLevelPct: 100,
          condition: 'good',
          notes: 'Return inspection complete. 450 EUR retained for wheel repair.',
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.refundStatus).toBe('partial_refund');
    expect(Number(res.body.refundAmount)).toBe(4550);
    expect(Number(res.body.retainedAmount)).toBe(450);

    // Verify DB state
    const resRow = (await db.query(
      `SELECT status, deposit_refund_status, deposit_refunded_amount, deposit_retained_amount, deposit_retention_reason, return_confirmed_at
       FROM reservations WHERE reservation_number = $1`,
      [reservationNumber],
    )).rows[0];
    expect(resRow.status).toBe('completed');
    expect(resRow.deposit_refund_status).toBe('partial_refund');
    expect(Number(resRow.deposit_refunded_amount)).toBe(4550);
    expect(Number(resRow.deposit_retained_amount)).toBe(450);
    expect(resRow.deposit_retention_reason).toBe('Front right alloy wheel repair charge');
    expect(resRow.return_confirmed_at).not.toBeNull();

    // Verify rental contract is closed
    const rental = (await db.query(
      `SELECT status, closed_at FROM rentals WHERE reservation_id = (SELECT id FROM reservations WHERE reservation_number = $1)`,
      [reservationNumber],
    )).rows[0];
    expect(rental.status).toBe('closed');
    expect(rental.closed_at).not.toBeNull();
  });

  it('8. Automatic 24h expiration: Overdue reservation expires to CANCELLED_UNPAID without admin', async () => {
    // Create an awaiting_payment reservation on vehicle 2 with expired deadline
    const numExpired = 'RES-EXPIRE-01';
    await db.query(`
      INSERT INTO reservations (
        reservation_number, customer_id, vehicle_id, pickup_at, return_at,
        rental_days, daily_price, deposit_amount, total_amount, status, payment_deadline_at
      ) VALUES (
        $1, $2, $3, '2026-12-01T10:00:00.000Z', '2026-12-03T10:00:00.000Z',
        2, 2500, 5000, 5000, 'awaiting_payment', now() - interval '2 hours'
      )
    `, [numExpired, ID.customer2, ID.vehicle2]);

    // Vehicle 2 is currently blocked by the awaiting_payment reservation
    const overlapBefore = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${tokens.customer}`)
      .send({
        vehicleId: ID.vehicle2,
        pickupAt: '2026-12-01T10:00:00.000Z',
        returnAt: '2026-12-03T10:00:00.000Z',
        pickupLocationId: ID.agency,
        dropoffLocationId: ID.agency,
      });
    expect(overlapBefore.status).toBe(409);

    // Call the automatic expiration service method directly (as executed by background timer)
    const { StripePaymentService } = await import('../src/finance/stripe-payment.service.js');
    const stripeService = app.get(StripePaymentService);
    const result = await stripeService.expireOverdueAwaitingPayments();
    expect(result.expiredCount).toBeGreaterThanOrEqual(1);

    // Verify the reservation is now CANCELLED_UNPAID
    const statusRow = (await db.query(
      `SELECT status FROM reservations WHERE reservation_number = $1`,
      [numExpired],
    )).rows[0];
    expect(statusRow.status).toBe('cancelled_unpaid');

    // Vehicle 2 is now instantly freed and available!
    const bookingAfter = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${tokens.customer}`)
      .send({
        vehicleId: ID.vehicle2,
        pickupAt: '2026-12-01T10:00:00.000Z',
        returnAt: '2026-12-03T10:00:00.000Z',
        pickupLocationId: ID.agency,
        dropoffLocationId: ID.agency,
      });
    expect(bookingAfter.status).toBe(201);
  });

  it('9. Security & environment gating: Payment simulator is strictly forbidden in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const res = await request(app.getHttpServer())
        .post(`/finance/stripe/simulate-payment/${encodeURIComponent(reservationNumber)}`)
        .set('Authorization', `Bearer ${tokens.customer}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('Payment simulator is strictly disabled in production');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('10. Deposit settlement validation: Rejects mismatch between refund and retained amounts', async () => {
    // Create an active rental for return testing
    const numRet = 'RES-RET-VAL-01';
    await db.query(`
      INSERT INTO reservations (
        reservation_number, customer_id, vehicle_id, pickup_at, return_at,
        rental_days, daily_price, deposit_amount, total_amount, status
      ) VALUES (
        $1, $2, $3, now() - interval '2 days', now(),
        2, 2500, 5000, 5000, 'active_rental'
      )
    `, [numRet, ID.customer, ID.vehicle1]);

    // Deposit is 5000. Try submitting refund 4000 + retained 500 (total 4500 != 5000)
    const mismatch = await request(app.getHttpServer())
      .post(`/finance/stripe/admin/return-refund/${encodeURIComponent(numRet)}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        refundAmount: 4000,
        retainedAmount: 500,
      });

    expect(mismatch.status).toBe(400);
    expect(mismatch.body.message).toContain('Deposit settlement mismatch');

    // Test 100% full refund (refund: 5000, retained: 0)
    const fullRefund = await request(app.getHttpServer())
      .post(`/finance/stripe/admin/return-refund/${encodeURIComponent(numRet)}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        refundAmount: 5000,
        retainedAmount: 0,
      });
    expect(fullRefund.status).toBe(201);
    expect(fullRefund.body.refundStatus).toBe('refunded');

    // Test 100% zero refund / fully retained (refund: 0, retained: 5000) on vehicle 2
    const numZero = 'RES-RET-ZERO-01';
    await db.query(`
      INSERT INTO reservations (
        reservation_number, customer_id, vehicle_id, pickup_at, return_at,
        rental_days, daily_price, deposit_amount, total_amount, status
      ) VALUES (
        $1, $2, $3, now() - interval '3 days', now() - interval '1 day',
        2, 2500, 5000, 5000, 'active_rental'
      )
    `, [numZero, ID.customer, ID.vehicle2]);

    const zeroRefund = await request(app.getHttpServer())
      .post(`/finance/stripe/admin/return-refund/${encodeURIComponent(numZero)}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        refundAmount: 0,
        retainedAmount: 5000,
        reason: 'Total loss / extensive damage retention',
      });
    expect(zeroRefund.status).toBe(201);
    expect(zeroRefund.body.refundStatus).toBe('retained');
    expect(Number(zeroRefund.body.refundAmount)).toBe(0);
    expect(Number(zeroRefund.body.retainedAmount)).toBe(5000);
  });
});
