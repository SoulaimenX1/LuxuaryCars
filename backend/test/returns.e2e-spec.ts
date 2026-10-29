import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import dotenv from 'dotenv';
import { ReturnsService } from '../src/returns/returns.service.js';
import { VehicleCondition } from '../src/rentals/dto/vehicle-condition.js';

dotenv.config();

const DB_HOST = process.env.DB_HOST ?? 'localhost';
const DB_PORT = Number(process.env.DB_PORT ?? 5432);
const DB_USER = process.env.DB_USERNAME ?? 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD ?? '';
const TEST_DB = `luxury_car_rental_returns_${process.pid}_${randomUUID().slice(0, 8)}`;
const BACKEND_ROOT = join(__dirname, '..');

const ID = {
    admin: '00000000-0000-4000-8000-000000000021',
    staff: '00000000-0000-4000-8000-000000000022',
    customer: '00000000-0000-4000-8000-000000000023',
    brand: 'f0000000-0000-4000-8000-000000000021',
    category: 'c0000000-0000-4000-8000-000000000021',
    model: 'd0000000-0000-4000-8000-000000000021',
    vehicle: 'a0000000-0000-4000-8000-000000000021',
    agency: 'b0000000-0000-4000-8000-000000000021',
    otherAgency: 'b0000000-0000-4000-8000-000000000022',
};

let admin: Client | undefined;
let db: Client | undefined;
let databaseCreated = false;
let service: ReturnsService;
let rentalId: string;
let reservationId: string;
let privatePhotoDir: string | undefined;
const previousPhotoDir = process.env.INSPECTION_IMAGES_DIR;

function clientFor(database: string) {
    return new Client({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database,
    });
}

async function applyBaseline(target: Client) {
    await target.query(readFileSync(join(BACKEND_ROOT, 'database', 'schema.sql'), 'utf8'));
    const patchDir = join(BACKEND_ROOT, 'database', 'patches');
    for (const patch of readdirSync(patchDir).filter(name => name.endsWith('.sql')).sort()) {
        await target.query(readFileSync(join(patchDir, patch), 'utf8'));
    }
}

function serviceFor(target: Client) {
    const query = async (sql: string, parameters: unknown[] = []) =>
        (await target!.query(sql, parameters)).rows;
    return new ReturnsService({
        query,
        transaction: async <T>(work: (manager: { query: typeof query }) => Promise<T>) => {
            await target!.query('BEGIN');
            try {
                const result = await work({ query });
                await target!.query('COMMIT');
                return result;
            } catch (error) {
                await target!.query('ROLLBACK');
                throw error;
            }
        },
    } as never);
}

async function seed(target: Client) {
    await target.query(
        `INSERT INTO users (id, email, password_hash, role, first_name, last_name)
         VALUES
           ($1, 'returns.admin@example.test', 'x', 'admin', 'Returns', 'Admin'),
           ($2, 'returns.staff@example.test', 'x', 'staff', 'Returns', 'Staff'),
           ($3, 'returns.customer@example.test', 'x', 'customer', 'Returns', 'Customer')`,
        [ID.admin, ID.staff, ID.customer],
    );
    await target.query(
        `INSERT INTO customer_profiles
           (user_id, date_of_birth, license_number, license_country,
            license_issued_on, license_expires_on)
         VALUES ($1, '1990-01-01', 'RETURNS-ITEST', 'HU',
                 '2015-01-01', '2040-01-01')`,
        [ID.customer],
    );
    await target.query(
        `INSERT INTO rental_locations
           (id, code, name, category, city, country, address,
            can_pickup, can_dropoff, enabled)
         VALUES
           ($1, 'RETURNS-AGENCY', 'Return Test Agency', 'showroom',
            'Budapest', 'Hungary', 'Test street 1', true, true, true),
           ($2, 'RETURNS-OTHER', 'Other Test Agency', 'showroom',
            'Budapest', 'Hungary', 'Test street 2', true, true, true)`,
        [ID.agency, ID.otherAgency],
    );
    await target.query(
        `INSERT INTO brands (id, name) VALUES ($1, 'Returns Integration Motors')`,
        [ID.brand],
    );
    await target.query(
        `INSERT INTO categories (id, name) VALUES ($1, 'Returns Integration GT')`,
        [ID.category],
    );
    await target.query(
        `INSERT INTO vehicle_models (id, brand_id, category_id, name)
         VALUES ($1, $2, $3, 'Return Ledger One')`,
        [ID.model, ID.brand, ID.category],
    );
    await target.query(
        `INSERT INTO vehicles
           (id, model_id, manufacture_year, license_plate, vin, transmission,
            fuel_type, daily_price, security_deposit, vehicle_value, status,
            home_location_id, current_location_id)
         VALUES ($1, $2, 2025, 'RET-ITEST', 'RETURNS0000000001',
                 'automatic', 'petrol', 100.00, 500.00, 150000.00,
                 'active', $3, $3)`,
        [ID.vehicle, ID.model, ID.agency],
    );
    const reservation = await target.query(
        `INSERT INTO reservations
           (customer_id, vehicle_id, pickup_at, return_at, rental_days,
            daily_price, deposit_amount, total_amount, status)
         VALUES ($1, $2, now() - interval '13 days',
                 now() - interval '10 days', 3, 100.00, 500.00, 300.00,
                 'converted')
         RETURNING id`,
        [ID.customer, ID.vehicle],
    );
    reservationId = reservation.rows[0].id as string;
    await target.query(
        `INSERT INTO reservation_service_points
           (reservation_id, direction, method, location_id, scheduled_at,
            local_date, local_time, timezone, canonical)
         VALUES ($1, 'dropoff', 'APPROVED_POINT', $2,
                 now() - interval '10 days', current_date, localtime,
                 'Europe/Budapest', 'Return Test Agency — Budapest')`,
        [reservationId, ID.agency],
    );
    const rental = await target.query(
        `INSERT INTO rentals
           (reservation_id, status, started_at, expected_return_at, opened_by,
            return_fee_policy_snapshot)
         VALUES ($1, 'active', now() - interval '13 days',
                 now() - interval '10 days', $2, $3::jsonb)
         RETURNING id`,
        [reservationId, ID.admin, JSON.stringify({
            lateFeePerDay: '10.00',
            fuelFeePerPercent: '2.00',
            mileageAllowancePerDay: 200,
            excessMileageFee: '0.50',
        })],
    );
    rentalId = rental.rows[0].id as string;
    await target.query(
        `INSERT INTO inspections
           (rental_id, type, performed_by, mileage_km, fuel_level_pct,
            overall_condition, notes)
         VALUES ($1, 'handover', $2, NULL, NULL, 'good',
                 'Baseline mileage and fuel were not measured')`,
        [rentalId, ID.admin],
    );
}

describe('ReturnsService isolated PostgreSQL lifecycle', () => {
    beforeAll(async () => {
        admin = clientFor('postgres');
        await admin.connect();
        await admin.query(`CREATE DATABASE ${TEST_DB}`);
        databaseCreated = true;
        db = clientFor(TEST_DB);
        await db.connect();
        await applyBaseline(db);
        await seed(db);
        service = serviceFor(db);
        privatePhotoDir = await mkdtemp(join(tmpdir(), 'lux-return-evidence-'));
        process.env.INSPECTION_IMAGES_DIR = privatePhotoDir;
    }, 120_000);

    afterAll(async () => {
        if (db) await db.end();
        if (admin) {
            if (databaseCreated) await admin.query(`DROP DATABASE ${TEST_DB} WITH (FORCE)`);
            await admin.end();
        }
        if (privatePhotoDir) await rm(privatePhotoDir, { recursive: true, force: true });
        if (previousPhotoDir === undefined) delete process.env.INSPECTION_IMAGES_DIR;
        else process.env.INSPECTION_IMAGES_DIR = previousPhotoDir;
    }, 120_000);

    it('rejects incorrect agency and unassigned staff before recording the return', async () => {
        await db!.query(
            `UPDATE reservation_service_points SET location_id = $2
             WHERE reservation_id = $1 AND direction = 'dropoff'`,
            [reservationId, ID.otherAgency],
        );
        await expect(service.registerReturn(ID.admin, rentalId, {
            condition: VehicleCondition.GOOD,
        })).rejects.toBeInstanceOf(ConflictException);
        await db!.query(
            `UPDATE reservation_service_points SET location_id = $2
             WHERE reservation_id = $1 AND direction = 'dropoff'`,
            [reservationId, ID.agency],
        );
        await expect(service.registerReturn(ID.staff, rentalId, {
            condition: VehicleCondition.GOOD,
        })).rejects.toBeInstanceOf(ForbiddenException);
        const rows = await db!.query('SELECT id FROM vehicle_returns');
        expect(rows.rows).toHaveLength(0);
    });

    it('records an agency return, keeps unknown baselines unknown, and gates release on preparation', async () => {
        const result = await service.registerReturn(ID.admin, rentalId, {
            condition: VehicleCondition.GOOD,
            keysReturned: false,
            damages: [{
                zone: 'front bumper',
                description: 'Return inspection paint scratch',
                severity: 'minor',
                estimatedCost: 42.50,
            }],
        });

        expect(result).toMatchObject({
            rentalId,
            status: 'returned',
            travelledKm: null,
            excessKm: null,
            fuelShortfallPct: null,
            estimatedDamageAmountEur: '42.50',
        });
        const state = await db!.query(
            `SELECT l.status AS "rentalStatus", v.status AS "vehicleStatus",
                    ri.mileage_km AS "returnMileage",
                    ri.fuel_level_pct AS "returnFuel",
                    ri.keys_returned AS "keysReturned",
                    vr.status AS "returnStatus",
                    prep.status AS "preparationStatus",
                    prep.maintenance_required AS "maintenanceRequired"
             FROM rentals l
             JOIN reservations r ON r.id = l.reservation_id
             JOIN vehicles v ON v.id = r.vehicle_id
             JOIN vehicle_returns vr ON vr.rental_id = l.id
             JOIN return_inspections ri ON ri.return_id = vr.id
             JOIN vehicle_preparations prep ON prep.return_id = vr.id
             WHERE l.id = $1`,
            [rentalId],
        );
        expect(state.rows[0]).toMatchObject({
            rentalStatus: 'returned',
            vehicleStatus: 'maintenance',
            returnMileage: null,
            returnFuel: null,
            keysReturned: false,
            returnStatus: 'inspection_completed',
            preparationStatus: 'awaiting_preparation',
            maintenanceRequired: true,
        });
        const charges = await db!.query(
            `SELECT type, amount FROM additional_charges WHERE rental_id = $1`,
            [rentalId],
        );
        expect(charges.rows.length).toBeGreaterThan(0);
        expect(charges.rows.every(row => row.type === 'late_return')).toBe(true);

        const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        const photo = await service.uploadReturnPhoto(ID.admin, rentalId, {
            size: pngSignature.length,
            mimetype: 'image/png',
            buffer: pngSignature,
            originalname: 'return-evidence.png',
        });
        expect(await service.returnPhotos(ID.admin, rentalId)).toHaveLength(1);
        const savedPhoto = await service.returnPhoto(ID.admin, photo.id);
        expect(savedPhoto.mime).toBe('image/png');
        expect(savedPhoto.content).toEqual(pngSignature);
        await expect(service.returnPhoto(ID.staff, photo.id))
            .rejects.toBeInstanceOf(ForbiddenException);

        await expect(service.registerReturn(ID.admin, rentalId, {
            condition: VehicleCondition.GOOD,
        })).rejects.toBeInstanceOf(ConflictException);
        await expect(service.releaseVehicle(ID.admin, rentalId, {
            cleaningCompleted: true,
            maintenanceCompleted: false,
            qualityApproved: true,
        })).rejects.toBeInstanceOf(ConflictException);

        await expect(service.releaseVehicle(ID.admin, rentalId, {
            cleaningCompleted: true,
            maintenanceCompleted: true,
            qualityApproved: true,
            qualityNotes: 'Preparation and final quality inspection completed',
        })).resolves.toMatchObject({
            rentalId,
            status: 'ready_for_service',
            vehicleStatus: 'active',
        });
        const finalState = await db!.query(
            `SELECT l.status AS "rentalStatus", v.status AS "vehicleStatus",
                    vr.status AS "returnStatus", prep.operational_ready AS "operationalReady"
             FROM rentals l
             JOIN reservations r ON r.id = l.reservation_id
             JOIN vehicles v ON v.id = r.vehicle_id
             JOIN vehicle_returns vr ON vr.rental_id = l.id
             JOIN vehicle_preparations prep ON prep.return_id = vr.id
             WHERE l.id = $1`,
            [rentalId],
        );
        expect(finalState.rows[0]).toMatchObject({
            rentalStatus: 'returned',
            vehicleStatus: 'active',
            returnStatus: 'validated',
            operationalReady: true,
        });
        const returns = await db!.query(
            'SELECT count(*)::int AS count FROM vehicle_returns WHERE rental_id = $1',
            [rentalId],
        );
        expect(returns.rows[0].count).toBe(1);
    });
});
