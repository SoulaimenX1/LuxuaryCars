import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import dotenv from 'dotenv';

import { AvailabilityService } from '../src/availability/availability.service.js';
import { CustomerProfile } from '../src/customer-profiles/entities/customer-profile.entity.js';
import { LocationsService } from '../src/locations/locations.service.js';
import { PremiumService } from '../src/premium/premium.service.js';
import { Reservation } from '../src/reservations/entities/reservation.entity.js';
import { ReservationsService } from '../src/reservations/reservations.service.js';
import {NoShowService} from '../src/reservations/no-show.service.js';
import {InboxService} from '../src/notifications/inbox.service.js';
import {EmailOutboxService} from '../src/notifications/email-outbox.service.js';
import {RentalsService} from '../src/rentals/rentals.service.js';
import {checkInCodeHash, checkInCodeMatches} from '../src/rentals/check-in-code.js';

// ==========================================================
// TESTS D'INTÉGRATION — DISPONIBILITÉ PAR VÉHICULE PHYSIQUE
// ==========================================================
//
// Ces tests s'exécutent contre une vraie base PostgreSQL
// jetable : le schéma réel (schema.sql + patches) est appliqué,
// puis AvailabilityService/LocationsService interrogent la base
// avec EXACTEMENT les mêmes requêtes qu'en production.
//
// Ils vérifient les règles réelles (contrainte EXCLUDE, triggers
// réservation <-> indisponibilité, statuts bloquants, frontière
// de retour, tampon de préparation, lieux, concurrence) et non
// des simulations.
//
// RÈGLE MÉTIER : une entreprise peut posséder PLUSIEURS véhicules
// physiques du même modèle (même marque, même nom, années
// éventuellement identiques). La disponibilité se calcule donc
// PAR vehicle_id et jamais par marque ni par modèle.

dotenv.config();
process.env.JWT_SECRET = 'isolated-e2e-only-secret-that-is-at-least-32-characters';

const DB_HOST = process.env.DB_HOST ?? 'localhost';
const DB_PORT = Number(process.env.DB_PORT ?? 5432);
const DB_USER = process.env.DB_USERNAME ?? 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD ?? '';
const TEST_DB = `luxury_car_rental_availability_itest_${process.pid}`;

const BACKEND_ROOT = join(__dirname, '..');
const SCHEMA_FILE = join(BACKEND_ROOT, 'database', 'schema.sql');
const PATCH_DIR = join(BACKEND_ROOT, 'database', 'patches');

// Identifiants stables pour rejouer les tests sur une base neuve.
const ID = {
  customerUser: '00000000-0000-4000-8000-000000000001',
  staffUser: '00000000-0000-4000-8000-000000000002',
  brand: 'f0000000-0000-4000-8000-000000000001',
  category: 'c0000000-0000-4000-8000-000000000001',
  modelOne: 'd0000000-0000-4000-8000-000000000001',
  modelTwo: 'd0000000-0000-4000-8000-000000000002',
  vehicleOne: 'a0000000-0000-4000-8000-000000000001',
  vehicleTwo: 'a0000000-0000-4000-8000-000000000002',
  vehicleThree: 'a0000000-0000-4000-8000-000000000003',
  locationA: 'b0000000-0000-4000-8000-000000000001',
  locationB: 'b0000000-0000-4000-8000-000000000002',
  locationForeign: 'b0000000-0000-4000-8000-000000000003',
  locationPickupOnly: 'b0000000-0000-4000-8000-000000000004',
  locationDropoffOnly: 'b0000000-0000-4000-8000-000000000005',
};

// Instants futurs : la disponibilité exige un départ dans le futur.
// Les heures restent dans la plage 09:00–18:00 du point de service
// (Europe/Budapest = UTC+2 en été) : 09:00Z = 11:00 locale, etc.
const T = {
  d1: '2035-06-01T09:00:00.000Z',
  d1b: '2035-06-01T10:00:00.000Z',
  d2: '2035-06-02T09:00:00.000Z',
  d2b: '2035-06-02T10:00:00.000Z',
  d2Early: '2035-06-02T07:30:00.000Z',
  d2Evening: '2035-06-02T17:00:00.000Z',
  d3: '2035-06-03T09:00:00.000Z',
  d4: '2035-06-04T09:00:00.000Z',
  d5: '2035-06-05T09:00:00.000Z',
};

let admin: Client;
let db: Client;
let applicationDb: DataSource;
let service: AvailabilityService;
let quotes: PremiumService;
let reservations: ReservationsService;
let testDatabaseCreated = false;

function clientFor(database: string): Client {
  return new Client({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database,
  });
}

// Adaptateur minimal : AvailabilityService et LocationsService
// n'utilisent que `dataSource.query`. On branche donc le client
// PostgreSQL réel directement dessus.
function makeDataSource(client: Client): DataSource {
  return {
    query: (text: string, params: unknown[] = []) =>
      client.query(text, params).then((result) => result.rows),
  } as unknown as DataSource;
}

function makeTransactionalDataSource(client: Client): DataSource {
  const query = (text: string, params: unknown[] = []) =>
    client.query(text, params).then((result) => result.rows);
  return {
    query,
    transaction: async <T>(work: (manager: EntityManager) => Promise<T>) => {
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
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const patch of patches) {
    await target.query(readFileSync(join(PATCH_DIR, patch), 'utf8'));
  }
}

async function seed(target: Client) {
  await target.query(
    `INSERT INTO users (id, email, password_hash, role, first_name, last_name, email_verified_at)
     VALUES
       ($1, 'itest.customer@example.com', 'x', 'customer', 'Test', 'Customer', now()),
       ($2, 'itest.staff@example.com', 'x', 'staff', 'Test', 'Staff', now())`,
    [ID.customerUser, ID.staffUser],
  );
  await target.query(
    `INSERT INTO customer_profiles
       (user_id, date_of_birth, license_number, license_country, license_issued_on, license_expires_on)
     VALUES ($1, '1990-01-01', 'ITEST-1', 'HU', '2015-01-01', '2040-01-01')`,
    [ID.customerUser],
  );
  await target.query(
    `INSERT INTO brands (id, name) VALUES ($1, 'Integration Motors')`,
    [ID.brand],
  );
  await target.query(
    `INSERT INTO categories (id, name) VALUES ($1, 'Grand Tourer')`,
    [ID.category],
  );
  await target.query(
    `INSERT INTO vehicle_models (id, brand_id, category_id, name)
     VALUES ($1, $3, $4, 'One'), ($2, $3, $4, 'Two')`,
    [ID.modelOne, ID.modelTwo, ID.brand, ID.category],
  );

  // Plusieurs véhicules physiques peuvent partager un même modèle :
  // vehicleTwo et vehicleThree référencent le même modèle (modelTwo)
  // mais restent des véhicules distincts (id, année, plaque, VIN propres).
  await target.query(
    `INSERT INTO vehicles
       (id, model_id, manufacture_year, license_plate, vin, transmission, fuel_type,
        daily_price, security_deposit, vehicle_value, status)
     VALUES
       ($1, $4, 2024, 'ITEST-01', 'VIN00000000000001', 'automatic', 'petrol', 320.00, 2800.00, 250000.00, 'active'),
       ($2, $5, 2024, 'ITEST-02', 'VIN00000000000002', 'automatic', 'hybrid', 240.00, 2000.00, 140000.00, 'active'),
       ($3, $5, 2023, 'ITEST-03', 'VIN00000000000003', 'automatic', 'petrol', 180.00, 1500.00, 90000.00, 'active')`,
    [ID.vehicleOne, ID.vehicleTwo, ID.vehicleThree, ID.modelOne, ID.modelTwo],
  );

  await target.query(
    `INSERT INTO rental_locations
       (id, code, name, category, city, country, address, can_pickup, can_dropoff, enabled,
        timezone, opens_at, closes_at, turnaround_minutes)
     VALUES
       ($1, 'ITEST-A', 'Integration Hub', 'showroom', 'Budapest', 'Hongrie', 'A utca 1', true, true, true, 'Europe/Budapest', '09:00', '18:00', 0),
       ($2, 'ITEST-B', 'Integration Airport', 'airport', 'Budapest', 'Hongrie', 'B utca 2', true, true, true, 'Europe/Budapest', '09:00', '18:00', 0),
       ($3, 'ITEST-C', 'Foreign Hub', 'showroom', 'Paris', 'France', 'C rue 3', true, true, true, 'Europe/Paris', '09:00', '18:00', 0),
       ($4, 'ITEST-P', 'Pickup Only Hub', 'showroom', 'Budapest', 'Hongrie', 'P utca 4', true, false, true, 'Europe/Budapest', '09:00', '18:00', 0),
       ($5, 'ITEST-D', 'Dropoff Only Hub', 'showroom', 'Budapest', 'Hongrie', 'D utca 5', false, true, true, 'Europe/Budapest', '10:00', '20:00', 0)`,
    [ID.locationA, ID.locationB, ID.locationForeign, ID.locationPickupOnly, ID.locationDropoffOnly],
  );
  await target.query(
    `INSERT INTO vehicle_rental_locations (vehicle_id, location_id)
     VALUES
       ($1, $4), ($2, $4), ($3, $4)`,
    [ID.vehicleOne, ID.vehicleTwo, ID.vehicleThree, ID.locationA],
  );
}

async function insertReservation(
  target: Client,
  options: {
    vehicleId?: string;
    from: string;
    to: string;
    status?: string;
  },
): Promise<{ id: string }> {
  const isConfirmed = (options.status ?? 'confirmed') === 'confirmed';
  const row = await target.query<{ id: string }>(
    `INSERT INTO reservations
       (customer_id, vehicle_id, pickup_at, return_at, rental_days, daily_price, deposit_amount, total_amount, status, paid_at)
     VALUES ($1, $2, $3, $4, 2, 100.00, 1000.00, 200.00, $5, $6)
     RETURNING id`,
    [
      ID.customerUser,
      options.vehicleId ?? ID.vehicleOne,
      options.from,
      options.to,
      options.status ?? 'confirmed',
      isConfirmed ? new Date() : null,
    ],
  );
  if (isConfirmed) {
    await target.query(
      `INSERT INTO payments (reservation_id, type, method, amount, currency, paid_at, reference, recorded_by, is_simulated, is_demo)
       VALUES 
         ($1::uuid, 'rental_payment', 'card', 200.00, 'EUR', now(), 'PAY-ITEST-RENTAL', $2::uuid, false, false),
         ($1::uuid, 'deposit_payment', 'card', 1000.00, 'EUR', now(), 'PAY-ITEST-DEPOSIT', $2::uuid, false, false)`,
      [row.rows[0].id, ID.staffUser],
    );
    await target.query(
      `INSERT INTO security_deposits (reservation_id, amount, status, held_at)
       VALUES ($1::uuid, 1000.00, 'held', now())`,
      [row.rows[0].id],
    );
  }
  return row.rows[0];
}

const check = (from: string, to: string, extra: Partial<Parameters<AvailabilityService['check']>[0]> = {}) =>
  service.check({
    vehicleId: ID.vehicleOne,
    pickupAt: from,
    returnAt: to,
    ...extra,
  });

describe('AvailabilityService (PostgreSQL réel)', () => {
  beforeAll(async () => {
    admin = clientFor('postgres');
    await admin.connect();
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    testDatabaseCreated = true;

    db = clientFor(TEST_DB);
    await db.connect();
    await applyBaseline(db);
    await seed(db);

    const locationService = new LocationsService(
      makeDataSource(db),
      new ConfigService({ DEFAULT_RENTAL_AGENCY_CODE: 'ITEST-A' }),
    );
    service = new AvailabilityService(makeDataSource(db), locationService);
    quotes = new PremiumService(makeDataSource(db), locationService);
    applicationDb = new DataSource({
      type: 'postgres',
      host: DB_HOST,
      port: DB_PORT,
      username: DB_USER,
      password: DB_PASSWORD,
      database: TEST_DB,
      entities: [CustomerProfile, Reservation],
      synchronize: false,
      migrationsRun: false,
      logging: false,
    });
    await applicationDb.initialize();
    reservations = new ReservationsService(
      applicationDb.getRepository(CustomerProfile),
      applicationDb.getRepository(Reservation),
      applicationDb,
      quotes,
      service,
    );
  }, 180_000);

  afterAll(async () => {
    if (applicationDb?.isInitialized) await applicationDb.destroy();
    await db?.end();
    if (admin && testDatabaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    }
    await admin?.end();
  });

  beforeEach(async () => {
    // Repartir d'un planning vide entre chaque scénario (base jetable).
    await db.query(
      'TRUNCATE rentals, vehicle_unavailability, reservations RESTART IDENTITY CASCADE',
    );
    await db.query("DELETE FROM audit_logs WHERE entity_type = 'reservation'");
    await db.query("DELETE FROM user_notifications WHERE entity_type = 'reservation'");
    await db.query('UPDATE rental_locations SET turnaround_minutes = 0');
    await db.query("UPDATE rental_locations SET closes_at = '18:00'");
    await db.query("UPDATE vehicles SET status = 'active'");
    await db.query('DELETE FROM vehicle_rental_locations');
    await db.query('UPDATE vehicles SET home_location_id = NULL');
    await db.query(
      `INSERT INTO vehicle_rental_locations (vehicle_id, location_id)
       VALUES
         ($1, $4), ($2, $4), ($3, $4)`,
      [ID.vehicleOne, ID.vehicleTwo, ID.vehicleThree, ID.locationA],
    );
  });

  it('autorise plusieurs véhicules physiques pour le même modèle', async () => {
    // Deux véhicules physiques distincts (années, plaques et VIN
    // différents) référencent le MÊME modèle : c'est autorisé. Le
    // catalogue de modèles est partagé, jamais la flotte.
    const rows = await db.query<{ id: string; year: number; plate: string }>(
      `SELECT id, manufacture_year AS year, license_plate AS plate
         FROM vehicles WHERE model_id = $1 ORDER BY license_plate`,
      [ID.modelTwo],
    );
    expect(rows.rows.length).toBe(2);
    const ids = rows.rows.map(
      (row: { id: string; year: number; plate: string }) => row.id,
    );
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(ID.vehicleTwo);
    expect(ids).toContain(ID.vehicleThree);
  });

  it('ne crée aucune contrainte UNIQUE sur le modèle ou l’année', async () => {
    // Aucune contrainte d'unicité ne doit porter sur model_id,
    // manufacture_year, ni sur un couple marque/modèle/année :
    // seuls id, immatriculation et VIN sont uniques par véhicule.
    const rows = await db.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'vehicles'::regclass
          AND contype IN ('u', 'x')`,
    );
    const defs = rows.rows.map(
      (row: { conname: string; def: string }) => row.def,
    );
    expect(defs.some((def: string) => def.includes('UNIQUE (license_plate)'))).toBe(
      true,
    );
    expect(defs.some((def: string) => def.includes('UNIQUE (vin)'))).toBe(true);
    for (const def of defs) {
      expect(def).not.toMatch(/model_id|manufacture_year/i);
    }
  });

  it('autorise deux véhicules du même modèle et de la même année', async () => {
    // Reproduit l'exemple métier : deux G63 2024 cohabitent comme
    // véhicules physiques distincts (seuls id, plaque et VIN diffèrent).
    const duplicateId = 'a0000000-0000-4000-8000-000000000099';
    try {
      await db.query(
        `INSERT INTO vehicles
           (id, model_id, manufacture_year, license_plate, vin, transmission, fuel_type,
            daily_price, security_deposit, vehicle_value, status)
         VALUES ($1, $2, 2024, 'ITEST-99', 'VIN00000000000099',
                 'automatic', 'petrol', 210.00, 1800.00, 120000.00, 'active')`,
        [duplicateId, ID.modelTwo],
      );
      const rows = await db.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM vehicles WHERE model_id = $1 AND manufacture_year = 2024',
        [ID.modelTwo],
      );
      expect(Number(rows.rows[0].total)).toBeGreaterThanOrEqual(2);
    } finally {
      await db.query('DELETE FROM vehicles WHERE id = $1', [duplicateId]);
    }
  });

  it('une réservation ne bloque que le véhicule physique concerné', async () => {
    // vehicleTwo et vehicleThree partagent le même modèle mais sont
    // des véhicules physiques distincts : bloquer l'un ne doit jamais
    // bloquer l'autre.
    await insertReservation(db, { vehicleId: ID.vehicleTwo, from: T.d1, to: T.d3 });

    const blocked = await service.check({
      vehicleId: ID.vehicleTwo,
      pickupLocationId: ID.locationA,
      pickupAt: T.d1,
      returnAt: T.d3,
    });
    expect(blocked.available).toBe(false);

    const stillFree = await service.check({
      vehicleId: ID.vehicleThree,
      pickupLocationId: ID.locationA,
      pickupAt: T.d1,
      returnAt: T.d3,
    });
    expect(stillFree.available).toBe(true);
  });

  it('accepte un intervalle réellement libre', async () => {
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('refuse une réservation entièrement chevauchante', async () => {
    await insertReservation(db, { from: T.d1, to: T.d3 });
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('conflict');
  });

  it('refuse un chevauchement partiel (début et fin)', async () => {
    await insertReservation(db, { from: T.d2, to: T.d4 });

    const before = await check(T.d1, T.d3); // fin à l'intérieur
    expect(before.available).toBe(false);

    const after = await check(T.d3, T.d5); // début à l'intérieur
    expect(after.available).toBe(false);
  });

  it('refuse une demande identique (mêmes instants)', async () => {
    await insertReservation(db, { from: T.d1, to: T.d3 });
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(false);
  });

  it('autorise une prise en charge exactement à la fin du retour précédent', async () => {
    // Contrainte EXCLUDE en intervalle semi-ouvert [) : la frontière
    // exacte (return === pickup suivant) n'est PAS un chevauchement.
    await insertReservation(db, { from: T.d1, to: T.d3 });
    const result = await check(T.d3, T.d5);
    expect(result.available).toBe(true);
  });

  it('applique le tampon de préparation configurable', async () => {
    await insertReservation(db, { from: T.d1, to: T.d2 });

    const withoutBuffer = await check(T.d2b, T.d4);
    expect(withoutBuffer.available).toBe(true);

    await db.query(
      "UPDATE rental_locations SET turnaround_minutes = 180 WHERE id = $1",
      [ID.locationA],
    );
    const withBuffer = await check(T.d2b, T.d4);
    expect(withBuffer.available).toBe(false);
    expect(withBuffer.reason).toBe('conflict');
  });

  it('ignore une réservation annulée', async () => {
    await insertReservation(db, { from: T.d1, to: T.d3, status: 'cancelled' });
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(true);
  });

  it('ignore une réservation rejetée ou expirée', async () => {
    await insertReservation(db, { from: T.d1, to: T.d3, status: 'rejected' });
    await insertReservation(db, { from: T.d1, to: T.d3, status: 'expired' });
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(true);
  });

  it('bloque pendant une location active (même sans réservation bloquante)', async () => {
    // Réservation annulée : elle ne bloque pas par elle-même, mais la
    // location active qui y est rattachée rend bien le véhicule indisponible.
    const reservation = await insertReservation(db, {
      vehicleId: ID.vehicleThree,
      from: T.d1,
      to: T.d3,
      status: 'cancelled',
    });
    await db.query(
      `INSERT INTO rentals (reservation_id, status, started_at, expected_return_at, opened_by)
       VALUES ($1, 'active', $2, $3, $4)`,
      [reservation.id, T.d1, T.d3, ID.staffUser],
    );
    const result = await service.check({
      vehicleId: ID.vehicleThree,
      pickupLocationId: ID.locationA,
      pickupAt: T.d1,
      returnAt: T.d3,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('conflict');
  });

  it('keeps an overdue active rental blocked after its planned return', async () => {
    const reservation = await insertReservation(db, {
      vehicleId: ID.vehicleThree,
      from: '2020-01-01T09:00:00.000Z',
      to: '2020-01-03T09:00:00.000Z',
      status: 'cancelled',
    });
    await db.query(
      `INSERT INTO rentals (reservation_id, status, started_at, expected_return_at, opened_by)
       VALUES ($1, 'active', $2, $3, $4)`,
      [reservation.id, '2020-01-01T09:00:00.000Z', '2020-01-03T09:00:00.000Z', ID.staffUser],
    );
    const result = await service.check({
      vehicleId: ID.vehicleThree,
      pickupLocationId: ID.locationA,
      pickupAt: T.d3,
      returnAt: T.d4,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('conflict');
  });

  it('automatically marks an overdue confirmed reservation no-show and releases its future block', async () => {
    const oldPickup = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const reservation = await insertReservation(db, {
      from: oldPickup,
      to: T.d5,
      status: 'confirmed',
    });
    const inbox = new InboxService(applicationDb);
    const config = new ConfigService({
      NO_SHOW_GRACE_PERIOD_MINUTES: 120,
      DEFAULT_RENTAL_AGENCY_CODE: 'ITEST-A',
    });
    const noShow = new NoShowService(
      applicationDb,
      config,
      inbox,
    );
    const concurrentNoShow = new NoShowService(applicationDb, config, inbox);
    const rentalService = new RentalsService(applicationDb, config);
    const booking = await db.query<{reservation_number: string}>(
      'SELECT reservation_number FROM reservations WHERE id = $1',
      [reservation.id],
    );
    await db.query(
      `INSERT INTO reservation_preferences
         (reservation_id, pickup_location_id, dropoff_location_id)
       VALUES ($1, $2, $2)`,
      [reservation.id, ID.locationA],
    );
    await db.query(
      `INSERT INTO reservation_checkin_credentials
         (reservation_id, customer_id, agency_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        reservation.id,
        ID.customerUser,
        ID.locationA,
        checkInCodeHash('12345678'),
        '2035-06-05T09:00:00.000Z',
      ],
    );

    const attempts = await Promise.allSettled([
      noShow.scanExpiredReservations(),
      concurrentNoShow.scanExpiredReservations(),
      rentalService.startRental(ID.staffUser, {
        reservationNumber: booking.rows[0].reservation_number,
        code: '12345678',
        identityVerified: true,
      }),
    ]);

    const stored = await db.query<{status: string; no_show_at: Date; no_show_reason: string; reservation_number: string}>(
      `SELECT status, no_show_at, no_show_reason, reservation_number FROM reservations WHERE id = $1`,
      [reservation.id],
    );
    expect(stored.rows[0].status).toBe('no_show');
    expect(stored.rows[0].no_show_at).toBeTruthy();
    expect(stored.rows[0].no_show_reason).toContain('handover');
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled' && attempt.value === 1)).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === 'rejected')).toBeDefined();

    const audit = await db.query<{id: string; new_values: {noShowAt: string | null}}>(
      `SELECT id, new_values FROM audit_logs WHERE entity_type = 'reservation' AND entity_id = $1
       AND action = 'RESERVATION_NO_SHOW'`,
      [reservation.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].new_values.noShowAt).toBeTruthy();
    const notices = await db.query(
      `SELECT id FROM user_notifications
       WHERE entity_type = 'reservation' AND entity_id = $1
         AND event_key = $2`,
      [reservation.id, `reservation:${reservation.id}:no_show:customer`],
    );
    expect(notices.rows).toHaveLength(1);

    const availability = await service.check({
      vehicleId: ID.vehicleOne,
      pickupLocationId: ID.locationA,
      pickupAt: T.d3,
      returnAt: T.d4,
    });
    expect(availability.available).toBe(true);
    await expect(noShow.scanExpiredReservations()).resolves.toBe(0);
  });

  it('runs the automatic scheduler idempotently using the assigned agency timezone and allows rebooking', async () => {
    const overduePickup = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const expiredBooking = await insertReservation(db, {
      vehicleId: ID.vehicleOne,
      from: overduePickup,
      to: T.d3,
      status: 'confirmed',
    });

    // Even without reservation_preferences, NoShowService resolves the assigned
    // showroom (locationA, Europe/Budapest) via vehicle_rental_locations.
    const inbox = new InboxService(applicationDb);
    const config = new ConfigService({
      NO_SHOW_GRACE_PERIOD_MINUTES: 120,
      NO_SHOW_SCAN_INTERVAL_MS: 1_000,
      DEFAULT_RENTAL_AGENCY_CODE: 'ITEST-A',
    });
    const noShow = new NoShowService(applicationDb, config, inbox);

    try {
      noShow.startScheduler(50);
      await new Promise((resolve) => setTimeout(resolve, 180));
    } finally {
      await noShow.stopScheduler();
    }

    const stored = await db.query<{status: string; no_show_at: Date | null}>(
      `SELECT status, no_show_at FROM reservations WHERE id = $1`,
      [expiredBooking.id],
    );
    expect(stored.rows[0].status).toBe('no_show');
    expect(stored.rows[0].no_show_at).toBeTruthy();

    // Multiple scheduler ticks must remain strictly idempotent (1 audit row, 1 notice).
    const audits = await db.query(
      `SELECT id FROM audit_logs
       WHERE entity_type = 'reservation' AND entity_id = $1 AND action = 'RESERVATION_NO_SHOW'`,
      [expiredBooking.id],
    );
    expect(audits.rows).toHaveLength(1);
    const notices = await db.query(
      `SELECT id FROM user_notifications
       WHERE entity_type = 'reservation' AND entity_id = $1`,
      [expiredBooking.id],
    );
    expect(notices.rows).toHaveLength(1);

    // Vehicle is immediately available for a new reservation on the freed window.
    const replacement = await reservations.createReservation(ID.customerUser, {
      vehicleId: ID.vehicleOne,
      pickupAt: T.d1,
      returnAt: T.d3,
    });
    expect(replacement.id).toBeTruthy();
    expect(replacement.status).toBe('pending');
  });

  it('activates a rental through an agency-bound one-time code and keeps it out of no-show processing', async () => {
    await db.query(
      `UPDATE rental_locations SET closes_at = '23:59:00' WHERE id = $1`,
      [ID.locationA],
    );
    const pickupAt = new Date(Date.now() - 60_000).toISOString();
    const returnAt = new Date(Date.now() + 86_400_000).toISOString();
    const reservation = await insertReservation(db, {
      from: pickupAt,
      to: returnAt,
      status: 'confirmed',
    });
    await db.query(
      `INSERT INTO reservation_preferences
         (reservation_id, pickup_location_id, dropoff_location_id)
       VALUES ($1, $2, $2)`,
      [reservation.id, ID.locationA],
    );
    await db.query(
      `INSERT INTO reservation_checkin_credentials
         (reservation_id, customer_id, agency_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        reservation.id,
        ID.customerUser,
        ID.locationA,
        checkInCodeHash('12345678'),
        returnAt,
      ],
    );
    await db.query(
      `INSERT INTO agency_staff_assignments (user_id, agency_id, assigned_by)
       VALUES ($1, $2, $1)`,
      [ID.staffUser, ID.locationA],
    );
    const booking = await db.query<{reservation_number: string}>(
      'SELECT reservation_number FROM reservations WHERE id = $1',
      [reservation.id],
    );

    const rentalService = new RentalsService(applicationDb, new ConfigService({
      NO_SHOW_GRACE_PERIOD_MINUTES: 120,
      DEFAULT_RENTAL_AGENCY_CODE: 'ITEST-A',
    }));
    const rental = await rentalService.startRental(ID.staffUser, {
      reservationNumber: booking.rows[0].reservation_number,
      code: '12345678',
      identityVerified: true,
    });

    expect(rental.status).toBe('active');
    const stored = await db.query<{status: string}>(
      'SELECT status FROM reservations WHERE id = $1',
      [reservation.id],
    );
    expect(stored.rows[0].status).toBe('converted');
    const credential = await db.query<{consumed_at: Date | null}>(
      'SELECT consumed_at FROM reservation_checkin_credentials WHERE reservation_id = $1',
      [reservation.id],
    );
    expect(credential.rows[0].consumed_at).toBeTruthy();

    const inbox = new InboxService(applicationDb);
    const noShow = new NoShowService(
      applicationDb,
      new ConfigService({NO_SHOW_GRACE_PERIOD_MINUTES: 120}),
      inbox,
    );
    await expect(noShow.scanExpiredReservations()).resolves.toBe(0);
  });

  it('provisions a hashed one-time code for a previously confirmed reservation', async () => {
    const reservation = await insertReservation(db, {
      from: T.d1,
      to: T.d3,
      status: 'confirmed',
    });
    await db.query(
      `INSERT INTO reservation_preferences
         (reservation_id, pickup_location_id, dropoff_location_id)
       VALUES ($1, $2, $2)`,
      [reservation.id, ID.locationA],
    );
    const booking = await db.query<{reservation_number: string}>(
      'SELECT reservation_number FROM reservations WHERE id = $1',
      [reservation.id],
    );

    const credential = await reservations.issueMyCheckInCode(
      ID.customerUser,
      booking.rows[0].reservation_number,
    );
    const stored = await db.query<{code_hash: string; customer_id: string; agency_id: string}>(
      `SELECT code_hash, customer_id, agency_id
       FROM reservation_checkin_credentials WHERE reservation_id = $1`,
      [reservation.id],
    );

    expect(checkInCodeMatches(credential.code, stored.rows[0].code_hash)).toBe(true);
    expect(stored.rows[0].code_hash).not.toContain(credential.code);
    expect(stored.rows[0].customer_id).toBe(ID.customerUser);
    expect(stored.rows[0].agency_id).toBe(ID.locationA);
  });

  it('bloque pendant une immobilisation technique', async () => {
    await db.query(
      `INSERT INTO vehicle_unavailability (vehicle_id, starts_at, ends_at, reason, created_by)
       VALUES ($1, $2, $3, 'maintenance', $4)`,
      [ID.vehicleOne, T.d1, T.d3, ID.staffUser],
    );
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('conflict');
  });

  it('refuse un véhicule inactif', async () => {
    await db.query("UPDATE vehicles SET status = 'retired' WHERE id = $1", [ID.vehicleOne]);
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('vehicle_inactive');
  });

  it('uses the physical vehicle assigned agency for availability and calendar', async () => {
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(true);
    expect(result.details?.pickupLocationId).toBe(ID.locationA);

    const calendar = await service.calendar(ID.vehicleOne, '2035-06');
    expect(calendar.locationId).toBe(ID.locationA);
    expect(calendar.location.id).toBe(ID.locationA);
  });

  it('rejects customer-supplied locations that differ from the assigned agency', async () => {
    await expect(check(T.d1, T.d3, {
      pickupLocationId: ID.locationB,
      dropoffLocationId: ID.locationB,
    })).rejects.toThrow('determined by the assigned vehicle');
  });

  it('uses the default only for unassigned vehicles and rejects multiple agencies', async () => {
    await db.query('DELETE FROM vehicle_rental_locations WHERE vehicle_id = $1', [ID.vehicleOne]);
    const result = await check(T.d1, T.d3);
    expect(result.available).toBe(true);
    expect(result.details?.pickupLocationId).toBe(ID.locationA);

    await db.query(
      'INSERT INTO vehicle_rental_locations (vehicle_id, location_id) VALUES ($1, $2)',
      [ID.vehicleOne, ID.locationA],
    );
    await db.query(
      'INSERT INTO vehicle_rental_locations (vehicle_id, location_id) VALUES ($1, $2)',
      [ID.vehicleOne, ID.locationForeign],
    );
    await expect(check(T.d1, T.d3)).rejects.toThrow('exactly one agency');
  });

  it('quotes an unassigned physical vehicle at the configured agency with no transport fees', async () => {
    await db.query('DELETE FROM vehicle_rental_locations WHERE vehicle_id = $1', [ID.vehicleOne]);
    const quote = await quotes.quote({
      vehicleId: ID.vehicleOne,
      pickupAt: T.d1,
      returnAt: T.d3,
    });

    expect(quote.rentalDays).toBe(2);
    expect(quote.baseAmount).toBe('640.00');
    expect(quote.totalAmount).toBe('640.00');
    expect(quote.deliveryAmount).toBe('0.00');
    expect(quote.pickupLocationId).toBe(ID.locationA);
    expect(quote.dropoffLocationId).toBe(ID.locationA);
  });

  it('persists an agency-only reservation for an unassigned vehicle', async () => {
    await db.query('DELETE FROM vehicle_rental_locations WHERE vehicle_id = $1', [ID.vehicleOne]);
    const created = await reservations.createReservation(ID.customerUser, {
      vehicleId: ID.vehicleOne,
      pickupAt: T.d1,
      returnAt: T.d3,
    });
    const savedRows = await db.query<{
      vehicle_id: string;
      status: string;
      delivery_amount: string;
      total_amount: string;
    }>(
      `SELECT vehicle_id, status, delivery_amount, total_amount
       FROM reservations WHERE id = $1`,
      [created.id],
    );
    const servicePoints = await db.query<{ direction: string; location_id: string }>(
      `SELECT direction, location_id FROM reservation_service_points
       WHERE reservation_id = $1 ORDER BY direction`,
      [created.id],
    );

    expect(created.reservationNumber).toBeTruthy();
    expect(savedRows.rows[0]).toMatchObject({
      vehicle_id: ID.vehicleOne,
      status: 'pending',
      delivery_amount: '0.00',
      total_amount: '640.00',
    });
    expect(servicePoints.rows).toEqual([
      { direction: 'dropoff', location_id: ID.locationA },
      { direction: 'pickup', location_id: ID.locationA },
    ]);
  });

  it('uses the assigned agency opening hours for both rental handover dates', async () => {
    const outsideOpeningHours = await check('2035-06-01T06:30:00.000Z', T.d3);
    expect(outsideOpeningHours.available).toBe(false);
    expect(outsideOpeningHours.reason).toBe('outside_pickup_hours');

    const outsideReturnHours = await check(T.d1, '2035-06-03T17:30:00.000Z');
    expect(outsideReturnHours.available).toBe(false);
    expect(outsideReturnHours.reason).toBe('outside_return_hours');
  });

  it('admin agency assignment moves a vehicle to one agency and stays synchronized', async () => {
    const assignedLocations = new LocationsService(
      makeTransactionalDataSource(db),
      new ConfigService({ DEFAULT_RENTAL_AGENCY_CODE: 'ITEST-A' }),
    );
    await assignedLocations.setAssignedVehicles(ID.locationForeign, [ID.vehicleOne]);

    const agency = await assignedLocations.assignedAgencyForVehicle(ID.vehicleOne);
    expect(agency.id).toBe(ID.locationForeign);
    const mappings = await db.query<{ location_id: string }>(
      'SELECT location_id FROM vehicle_rental_locations WHERE vehicle_id = $1',
      [ID.vehicleOne],
    );
    expect(mappings.rows.map((row) => row.location_id)).toEqual([ID.locationForeign]);
    const home = await db.query<{ home_location_id: string }>(
      'SELECT home_location_id FROM vehicles WHERE id = $1',
      [ID.vehicleOne],
    );
    expect(home.rows[0].home_location_id).toBe(ID.locationForeign);
  });

  it('exclut la réservation en cours de modification (workflow admin)', async () => {
    const reservation = await insertReservation(db, { from: T.d1, to: T.d3 });
    const result = await check(T.d1b, T.d2, { excludeReservationId: reservation.id });
    expect(result.available).toBe(true);
  });

  it('reflète les vraies réservations dans le calendrier', async () => {
    await insertReservation(db, { from: T.d1, to: T.d3 });
    const calendar = await service.calendar(ID.vehicleOne, '2035-06');
    const day1 = calendar.days.find((day) => day.date === '2035-06-01');
    const day4 = calendar.days.find((day) => day.date === '2035-06-04');
    expect(day1?.status).not.toBe('available');
    expect(day4?.slots.length).toBeGreaterThan(0);
  });

  it('propose la prochaine période libre et des véhicules réellement disponibles', async () => {
    await insertReservation(db, { from: T.d1, to: T.d3 });
    const result = await service.getAlternatives({
      vehicleId: ID.vehicleOne,
      pickupAt: T.d1,
      returnAt: T.d3,
    });

    expect(result.available).toBe(false);
    expect(result.message).toBeTruthy();
    expect(result.nextAvailable).not.toBeNull();

    const next = result.nextAvailable;
    if (next) {
      // La période suggérée ne doit jamais être fictive : on la revalide.
      const revalidated = await service.check({
        vehicleId: ID.vehicleOne,
        pickupAt: next.pickupAt,
        returnAt: next.returnAt,
      });
      expect(revalidated.available).toBe(true);
      expect(new Date(next.pickupAt).getTime()).toBeGreaterThanOrEqual(new Date(T.d3).getTime());
    }

    const ids = result.alternatives.map((vehicle) => vehicle.vehicleId);
    expect(ids).toContain(ID.vehicleTwo);
    expect(ids).not.toContain(ID.vehicleOne);
  });

  it('fait évoluer la disponibilité après la confirmation d’un autre client', async () => {
    const first = await check(T.d1, T.d3);
    expect(first.available).toBe(true);

    // Un autre client confirme une réservation sur le même véhicule.
    await insertReservation(db, { from: T.d1, to: T.d3, status: 'confirmed' });

    const second = await check(T.d1, T.d3);
    expect(second.available).toBe(false);
    expect(second.reason).toBe('conflict');
  });

  it('empêche deux réservations simultanées sur le même véhicule', async () => {
    // Reproduit exactement le chemin applicatif : verrou de la ligne
    // véhicule (FOR UPDATE ... SKIP LOCKED) puis insertion.
    const attempt = async (): Promise<boolean> => {
      const client = clientFor(TEST_DB);
      await client.connect();
      try {
        await client.query('BEGIN');
        const available = await client.query(
          `SELECT v.id
             FROM vehicles v
             WHERE v.id = $1::uuid
               AND v.status = 'active'
               AND v.id IN (
                 SELECT available.id FROM find_available_vehicles($2::timestamptz, $3::timestamptz) AS available
               )
             LIMIT 1
             FOR UPDATE OF v SKIP LOCKED`,
          [ID.vehicleOne, T.d1, T.d3],
        );
        if (available.rowCount === 0) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(
          `INSERT INTO reservations
             (customer_id, vehicle_id, pickup_at, return_at, rental_days, daily_price, deposit_amount, total_amount, status)
           VALUES ($1, $2, $3, $4, 2, 100.00, 1000.00, 200.00, 'confirmed')`,
          [ID.customerUser, ID.vehicleOne, T.d1, T.d3],
        );
        await client.query('COMMIT');
        return true;
      } catch {
        await client.query('ROLLBACK');
        return false;
      } finally {
        await client.end();
      }
    };

    const outcomes = await Promise.all([attempt(), attempt()]);
    expect(outcomes.filter(Boolean).length).toBe(1);

    const stored = await db.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM reservations WHERE vehicle_id = $1 AND status = \'confirmed\'',
      [ID.vehicleOne],
    );
    expect(stored.rows[0].total).toBe('1');
  });

  it('garantit au niveau base deux insertions concurrentes (contrainte EXCLUDE)', async () => {
    // Même en contournant le verrou applicatif, la contrainte
    // d'exclusion PostgreSQL doit refuser la seconde insertion.
    const directInsert = async (): Promise<boolean> => {
      const client = clientFor(TEST_DB);
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO reservations
             (customer_id, vehicle_id, pickup_at, return_at, rental_days, daily_price, deposit_amount, total_amount, status)
           VALUES ($1, $2, $3, $4, 2, 100.00, 1000.00, 200.00, 'confirmed')`,
          [ID.customerUser, ID.vehicleOne, T.d1, T.d3],
        );
        await client.query('COMMIT');
        return true;
      } catch {
        await client.query('ROLLBACK');
        return false;
      } finally {
        await client.end();
      }
    };

    const outcomes = await Promise.all([directInsert(), directInsert()]);
    expect(outcomes.filter(Boolean).length).toBe(1);
  });

  it('enqueues, deduplicates, retries, and delivers transactional emails for confirmation, check-in, return, and cancellation', async () => {
    await db.query('DELETE FROM customer_email_outbox WHERE customer_id = $1::uuid', [
      ID.customerUser,
    ]);
    const emailOutbox = new EmailOutboxService(
      applicationDb,
      new ConfigService({
        NODE_ENV: 'test',
        EMAIL_OUTBOX_MAX_ATTEMPTS: 3,
        EMAIL_OUTBOX_BASE_DELAY_MS: 100,
      }),
    );
    const inbox = new InboxService(applicationDb, emailOutbox);
    const delivered: { subject: string; templateType: string | null }[] = [];

    emailOutbox.setTransport({
      sendMail: async (payload) => {
        delivered.push({
          subject: payload.subject,
          templateType: payload.templateType,
        });
        return { messageId: `<${payload.outboxId}@luxuar.e2e>` };
      },
    });

    const pickupAt = '2035-06-10T10:00:00.000Z';
    const returnAt = '2035-06-12T10:00:00.000Z';
    const resInsert = await db.query<{ id: string; reservation_number: string }>(
      `INSERT INTO reservations
         (customer_id, vehicle_id, pickup_at, return_at, rental_days, daily_price, deposit_amount, total_amount, status)
       VALUES ($1, $2, $3, $4, 2, 100.00, 1000.00, 200.00, 'confirmed')
       RETURNING id, reservation_number`,
      [ID.customerUser, ID.vehicleOne, pickupAt, returnAt],
    );
    const reservationId = resInsert.rows[0].id;
    const reservationNumber = resInsert.rows[0].reservation_number;

    const reservationObj = {
      id: reservationId,
      customerId: ID.customerUser,
      reservationNumber,
      decisionReason: null,
    } as Reservation;

    // 1. Booking confirmation (trigger twice to verify DB deduplication)
    await inbox.safelyNotify('confirmed', reservationObj);
    await inbox.safelyNotify('confirmed', reservationObj);

    // 2. Check-in code + Check-in completed (active rental)
    await inbox.safelyCheckInCodeIssued({
      customerId: ID.customerUser,
      reservationId,
      reservationNumber,
      code: '12345678',
      expiresAt: '2035-06-10T12:00:00.000Z',
    });

    const rentalInsert = await db.query<{ id: string }>(
      `INSERT INTO rentals (reservation_id, expected_return_at, opened_by, status)
       VALUES ($1::uuid, $2::timestamptz, $3::uuid, 'active')
       RETURNING id`,
      [reservationId, returnAt, ID.staffUser],
    );
    const rentalId = rentalInsert.rows[0].id;
    await emailOutbox.safelyNotifyCheckInCompleted(rentalId);
    await emailOutbox.safelyNotifyCheckInCompleted(rentalId);

    // 3. Vehicle return
    await db.query(
      `UPDATE rentals SET status = 'returned', returned_at = now() WHERE id = $1::uuid`,
      [rentalId],
    );
    await emailOutbox.safelyNotifyVehicleReturned(rentalId, {
      returnReference: 'RET-2035-000001',
      automaticChargesEur: '0.00',
      estimatedDamageAmountEur: '0.00',
    });

    // 4. Cancellation (with simulated transient failure then retry recovery)
    let failNext = true;
    emailOutbox.setTransport({
      sendMail: async (payload) => {
        if (failNext) {
          failNext = false;
          throw new Error('451 Temporary local problem — try again');
        }
        delivered.push({
          subject: payload.subject,
          templateType: payload.templateType,
        });
        return { messageId: `<${payload.outboxId}@luxuar.e2e>` };
      },
    });

    await inbox.safelyNotify('cancelled', reservationObj);

    const pendingRetry = await db.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM customer_email_outbox
       WHERE customer_id = $1::uuid AND event_key = $2`,
      [ID.customerUser, `reservation:${reservationId}:cancelled`],
    );
    expect(pendingRetry.rows[0]).toEqual({
      status: 'pending',
      attempt_count: 1,
    });

    // Fast-forward next_attempt_at so the retry batch processes immediately
    await db.query(
      `UPDATE customer_email_outbox SET next_attempt_at = now() - interval '1 second'
       WHERE customer_id = $1::uuid AND event_key = $2`,
      [ID.customerUser, `reservation:${reservationId}:cancelled`],
    );
    const retryBatch = await emailOutbox.processOutboxBatch();
    expect(retryBatch.sent).toBe(1);

    const allOutbox = await db.query<{
      event_key: string;
      status: string;
      attempt_count: number;
    }>(
      `SELECT event_key, status, attempt_count
       FROM customer_email_outbox
       WHERE customer_id = $1::uuid
       ORDER BY created_at ASC`,
      [ID.customerUser],
    );
    expect(allOutbox.rows).toHaveLength(5);
    expect(allOutbox.rows.every((r) => r.status === 'sent')).toBe(true);
    expect(delivered.map((d) => d.templateType)).toEqual([
      'booking_confirmed',
      'check_in_code',
      'check_in_completed',
      'vehicle_returned',
      'booking_cancelled',
    ]);
  });
});
