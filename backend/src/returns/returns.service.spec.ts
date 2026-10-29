import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { VehicleCondition } from '../rentals/dto/vehicle-condition.js';
import { ReturnsService } from './returns.service.js';

const feePolicy = {
    lateFeePerDay: '25.00',
    fuelFeePerPercent: '1.50',
    mileageAllowancePerDay: 200,
    excessMileageFee: '0.50',
};

function setup(options: {
    existingReturn?: boolean;
    role?: string;
    assigned?: boolean;
    feePolicySnapshot?: typeof feePolicy | null;
    pickupMileage?: number | null;
    pickupFuel?: number | null;
    expectedReturnAt?: Date;
} = {}) {
    const rental = {
        id: 'rental-id',
        status: 'active',
        expectedReturnAt: options.expectedReturnAt ?? new Date(Date.now() + 86_400_000),
        vehicleId: 'vehicle-id',
        vehicleStatus: 'active',
        reservationId: 'reservation-id',
        customerId: 'customer-id',
        rentalDays: 2,
        startedAt: new Date(Date.now() - 86_400_000),
        pickupMileage: options.pickupMileage ?? null,
        pickupFuel: options.pickupFuel ?? null,
        pickupCondition: null,
        pickupInspectionId: 'handover-inspection-id',
        currentLocationId: 'agency-id',
        assignedAgencyId: 'agency-id',
        assignedAgencyName: 'Test Agency',
        agencyEnabled: true,
        agencyCanDropoff: true,
        actorRole: options.role ?? 'admin',
        feePolicySnapshot: options.feePolicySnapshot === undefined
            ? feePolicy
            : options.feePolicySnapshot,
    };
    const calls: { sql: string; parameters: unknown[] }[] = [];
    const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
        calls.push({ sql, parameters });
        if (sql.includes('SELECT l.id, l.status')) return [rental];
        if (sql.includes('SELECT role FROM users')) {
            return [{ role: options.role ?? 'admin' }];
        }
        if (sql.includes('FROM agency_staff_assignments')) {
            return options.assigned ? [{ user_id: 'staff-id' }] : [];
        }
        if (sql.includes('FROM reservation_service_points')) {
            return [{ method: 'SERVICE_POINT', location_id: 'agency-id' }];
        }
        if (sql.includes('SELECT id FROM vehicle_returns WHERE rental_id')) {
            return options.existingReturn ? [{ id: 'existing-return-id' }] : [];
        }
        if (sql.includes('FROM vehicle_preparations')) return [];
        if (sql.includes('INSERT INTO inspections')) {
            return [{ id: 'return-inspection-id' }];
        }
        if (sql.includes('INSERT INTO inspection_damages')) {
            return [{ id: 'damage-id' }];
        }
        if (sql.includes('INSERT INTO vehicle_returns')) {
            return [{ id: 'return-id', reference: 'RET-2026-000001' }];
        }
        if (sql.includes('INSERT INTO return_inspections')) {
            return [{ id: 'submitted-inspection-id' }];
        }
        if (sql.includes('INSERT INTO vehicle_preparations')) {
            return [{ id: 'preparation-id', reference: 'PRP-2026-000001' }];
        }
        if (sql.includes('RETURNING id') && sql.includes('INSERT INTO preparation_cleaning_tasks')) {
            return [{ id: 'cleaning-task-id' }];
        }
        if (sql.includes('INSERT INTO additional_charges')) return [{ id: 'charge-id' }];
        if (sql.includes('INSERT INTO preparation_events')) return [{ id: 'event-id' }];
        if (sql.includes('WITH ev AS')) return [{ id: 'location-event-id' }];
        return [];
    });
    const manager = { query };
    const dataSource = {
        query,
        transaction: vi.fn(async (work: (executor: typeof manager) => unknown) =>
            work(manager),
        ),
    };
    return { service: new ReturnsService(dataSource as never), calls, query };
}

const validInput = {
    condition: VehicleCondition.GOOD,
    keysReturned: true,
};

describe('ReturnsService.registerReturn', () => {
    it('rejects duplicate physical return records before writing a new inspection', async () => {
        const { service, calls } = setup({ existingReturn: true });

        await expect(
            service.registerReturn('admin-id', 'rental-id', validInput),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(calls.some(call => call.sql.includes('INSERT INTO inspections'))).toBe(false);
    });

    it('rejects staff who are not assigned to the physical return agency', async () => {
        const { service, calls } = setup({ role: 'staff', assigned: false });

        await expect(
            service.registerReturn('staff-id', 'rental-id', validInput),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(calls.some(call => call.sql.includes('INSERT INTO inspections'))).toBe(false);
    });

    it('accepts unknown measurements without inventing values or mileage/fuel charges', async () => {
        const { service, calls } = setup({
            pickupMileage: null,
            pickupFuel: null,
            expectedReturnAt: new Date(Date.now() + 86_400_000),
        });

        const result = await service.registerReturn('admin-id', 'rental-id', validInput);

        expect(result).toMatchObject({
            status: 'returned',
            travelledKm: null,
            excessKm: null,
            fuelShortfallPct: null,
            automaticChargesEur: '0.00',
        });
        const inspection = calls.find(call =>
            call.sql.includes('INSERT INTO inspections'),
        );
        expect(inspection?.parameters.slice(2, 4)).toEqual([null, null]);
        expect(calls.some(call => call.sql.includes('INSERT INTO additional_charges'))).toBe(false);
    });

    it('calculates the saved late fee in cents and leaves damage estimates uncharged', async () => {
        const { service, calls } = setup({
            expectedReturnAt: new Date(Date.now() - 60_000),
        });
        const input = {
            ...validInput,
            damages: [{
                zone: 'front bumper',
                description: 'Paint scratch documented during return',
                severity: 'minor' as const,
                estimatedCost: 12.34,
            }],
        };

        const result = await service.registerReturn('admin-id', 'rental-id', input);

        expect(result.automaticChargesEur).toBe('25.00');
        expect(result.estimatedDamageAmountEur).toBe('12.34');
        const fee = calls.find(call => call.sql.includes('INSERT INTO additional_charges'));
        expect(fee?.parameters).toContain('late_return');
        expect(fee?.parameters).toContain('25.00');
        const damage = calls.find(call => call.sql.includes('INSERT INTO return_damages'));
        expect(damage?.parameters[4]).toBe('handover-inspection-id');
    });
});
