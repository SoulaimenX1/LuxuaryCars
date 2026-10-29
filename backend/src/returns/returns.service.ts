import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { ReturnRentalDto } from './dto/return-rental.dto.js';
import type { FeePolicyDto } from './dto/fee-policy.dto.js';
import type { ReleaseVehicleDto } from './dto/release-vehicle.dto.js';
import type { PrivateUpload } from './private-photos.js';
import {
    deletePrivatePhoto,
    readPrivatePhoto,
    savePrivatePhoto,
} from './private-photos.js';
import { recordVehicleLocation } from '../vehicle-movements/vehicle-location.js';
import { resolveServicePointDestination } from '../vehicle-movements/service-point-destination.js';
import { EmailOutboxService } from '../notifications/email-outbox.service.js';

type Policy = {
    lateFeePerDay: string;
    fuelFeePerPercent: string;
    mileageAllowancePerDay: number;
    excessMileageFee: string;
};

type ReturnRental = {
    id: string;
    status: string;
    expectedReturnAt: Date;
    vehicleId: string;
    vehicleStatus: string;
    reservationId: string;
    customerId: string;
    rentalDays: number;
    startedAt: Date;
    pickupMileage: number | null;
    pickupFuel: number | null;
    pickupCondition: string | null;
    pickupInspectionId: string | null;
    currentLocationId: string | null;
    assignedAgencyId: string | null;
    assignedAgencyName: string | null;
    agencyEnabled: boolean | null;
    agencyCanDropoff: boolean | null;
    actorRole: string;
    feePolicySnapshot: Policy | null;
};

type ReturnAccess = {
    returnId: string;
    inspectionId: string;
    agencyId: string;
    role: string;
};

const cents = (value: string | number): number =>
    Math.round(Number(value) * 100);

@Injectable()
export class ReturnsService {
    constructor(
        private readonly dataSource: DataSource,
        @Optional()
        private readonly emailOutbox?: EmailOutboxService,
    ) {}

    async getPolicy(): Promise<Policy> {
        const rows: Policy[] = await this.dataSource.query(
            `SELECT late_fee_per_day AS "lateFeePerDay",
                    fuel_fee_per_percent AS "fuelFeePerPercent",
                    mileage_allowance_per_day AS "mileageAllowancePerDay",
                    excess_mileage_fee AS "excessMileageFee"
             FROM rental_fee_policy WHERE id = 1`,
        );
        if (!rows[0]) {
            throw new NotFoundException('Rental fee policy not configured');
        }
        return rows[0];
    }

    async updatePolicy(input: FeePolicyDto) {
        await this.dataSource.query(
            `UPDATE rental_fee_policy
             SET late_fee_per_day = $1, fuel_fee_per_percent = $2,
                 mileage_allowance_per_day = $3, excess_mileage_fee = $4,
                 updated_at = now()
             WHERE id = 1`,
            [
                input.lateFeePerDay,
                input.fuelFeePerPercent,
                input.mileageAllowancePerDay,
                input.excessMileageFee,
            ],
        );
        return this.getPolicy();
    }

    private async requireAgencyAccess(
        db: DataSource | EntityManager,
        actorId: string,
        rentalId: string,
        lock = false,
    ): Promise<ReturnRental> {
        const rows: ReturnRental[] = await db.query(
            `SELECT l.id, l.status, l.expected_return_at AS "expectedReturnAt",
                    l.started_at AS "startedAt",
                    l.return_fee_policy_snapshot AS "feePolicySnapshot",
                    v.id AS "vehicleId", v.status AS "vehicleStatus",
                    v.current_location_id AS "currentLocationId",
                    r.id AS "reservationId", r.customer_id AS "customerId",
                    r.rental_days AS "rentalDays",
                    handover.mileage_km AS "pickupMileage",
                    handover.fuel_level_pct AS "pickupFuel",
                    handover.overall_condition AS "pickupCondition",
                    handover.id AS "pickupInspectionId",
                    assigned.id AS "assignedAgencyId",
                    agency.name AS "assignedAgencyName",
                    agency.enabled AS "agencyEnabled",
                    agency.can_dropoff AS "agencyCanDropoff",
                    actor.role AS "actorRole"
             FROM rentals l
             JOIN reservations r ON r.id = l.reservation_id
             JOIN vehicles v ON v.id = r.vehicle_id
             JOIN users actor ON actor.id = $2::uuid AND actor.status = 'active'
             LEFT JOIN reservation_checkin_credentials credential
                    ON credential.reservation_id = r.id
             LEFT JOIN reservation_preferences prefs
                    ON prefs.reservation_id = r.id
             LEFT JOIN inspections handover
                    ON handover.rental_id = l.id AND handover.type = 'handover'
             LEFT JOIN LATERAL (
                SELECT CASE
                    WHEN count(*) = 1 THEN (array_agg(mapped.location_id))[1]
                    ELSE NULL
                END AS id
                FROM (
                    SELECT v.home_location_id AS location_id
                    WHERE v.home_location_id IS NOT NULL
                    UNION
                    SELECT vrl.location_id
                    FROM vehicle_rental_locations vrl
                    WHERE vrl.vehicle_id = v.id
                ) mapped
             ) assigned ON true
             LEFT JOIN rental_locations agency
                    ON agency.id = COALESCE(credential.agency_id, assigned.id)
             WHERE l.id = $1::uuid
               AND COALESCE(credential.agency_id, assigned.id) IS NOT NULL
             ${lock ? 'FOR UPDATE OF l, v' : ''}`,
            [rentalId, actorId],
        );
        if (!rows[0]) {
            throw new NotFoundException('Rental or assigned return agency not found');
        }

        const rental = rows[0];
        const staff = await db.query(
            `SELECT role FROM users WHERE id = $1::uuid AND status = 'active'`,
            [actorId],
        ) as { role: string }[];
        if (staff[0]?.role === 'staff') {
            const assignments = await db.query(
                `SELECT 1 FROM agency_staff_assignments
                 WHERE user_id = $1::uuid AND agency_id = $2::uuid`,
                [actorId, rental.assignedAgencyId],
            );
            if (!assignments.length) {
                throw new ForbiddenException(
                    'Staff member is not assigned to this return agency',
                );
            }
        } else if (staff[0]?.role !== 'admin') {
            throw new ForbiddenException(
                'Only authorized agency staff can process vehicle returns',
            );
        }
        return rental;
    }

    async registerReturn(
        actorId: string,
        rentalId: string,
        input: ReturnRentalDto,
    ) {
        const result = await this.dataSource.transaction(async manager => {
            const rental = await this.requireAgencyAccess(
                manager,
                actorId,
                rentalId,
                true,
            );
            if (rental.status !== 'active') {
                throw new ConflictException(
                    'Only an active rental can be returned',
                );
            }
            if (
                !rental.assignedAgencyId ||
                rental.agencyEnabled !== true ||
                rental.agencyCanDropoff !== true
            ) {
                throw new ConflictException(
                    'The assigned rental agency cannot accept vehicle returns',
                );
            }

            const dropoff = await resolveServicePointDestination(
                manager,
                rental.reservationId,
                'dropoff',
            );
            if (dropoff.locationId !== rental.assignedAgencyId) {
                throw new ConflictException(
                    'Vehicles must be returned to their assigned rental agency',
                );
            }

            const existingReturn = await manager.query(
                `SELECT id FROM vehicle_returns WHERE rental_id = $1::uuid`,
                [rentalId],
            );
            if (existingReturn.length) {
                throw new ConflictException(
                    'A return record already exists for this rental',
                );
            }

            const activePreparation = await manager.query(
                `SELECT id FROM vehicle_preparations
                 WHERE vehicle_id = $1::uuid
                   AND status NOT IN ('ready_for_service', 'cancelled')
                 FOR UPDATE`,
                [rental.vehicleId],
            );
            if (activePreparation.length) {
                throw new ConflictException(
                    'This vehicle already has an active preparation record',
                );
            }

            if (
                input.mileageKm !== undefined &&
                rental.pickupMileage !== null &&
                input.mileageKm < Number(rental.pickupMileage)
            ) {
                throw new BadRequestException(
                    'Return mileage cannot be lower than recorded pickup mileage',
                );
            }

            const returnedAt = new Date();
            const overdueMs = Math.max(
                0,
                returnedAt.getTime() -
                    new Date(rental.expectedReturnAt).getTime(),
            );
            const overdueMinutes = Math.ceil(overdueMs / 60_000);
            const lateDays = Math.ceil(overdueMinutes / 1_440);
            const fuelShortfall =
                rental.pickupFuel !== null && input.fuelLevelPct !== undefined
                    ? Math.max(
                          0,
                          Number(rental.pickupFuel) - input.fuelLevelPct,
                      )
                    : null;
            const travelledKm =
                rental.pickupMileage !== null &&
                input.mileageKm !== undefined
                    ? input.mileageKm - Number(rental.pickupMileage)
                    : null;

            const policy = rental.feePolicySnapshot;
            const includedKm = policy
                ? Number(rental.rentalDays) *
                  Number(policy.mileageAllowancePerDay)
                : null;
            const excessKm =
                travelledKm !== null && includedKm !== null
                    ? Math.max(0, travelledKm - includedKm)
                    : null;

            const fees = policy
                ? [
                      {
                          kind: 'late_return',
                          amount: lateDays * cents(policy.lateFeePerDay),
                          description: `Late return: ${lateDays} day(s)`,
                      },
                      {
                          kind: 'fuel',
                          amount:
                              fuelShortfall === null
                                  ? 0
                                  : fuelShortfall *
                                    cents(policy.fuelFeePerPercent),
                          description:
                              fuelShortfall === null
                                  ? 'Fuel fee not assessed: baseline or return fuel level is unknown'
                                  : `Fuel difference: ${fuelShortfall}%`,
                      },
                      {
                          kind: 'mileage',
                          amount:
                              excessKm === null
                                  ? 0
                                  : excessKm * cents(policy.excessMileageFee),
                          description:
                              excessKm === null
                                  ? 'Mileage fee not assessed: baseline or return mileage is unknown'
                                  : `Additional mileage: ${excessKm} km`,
                      },
                  ]
                : [];

            const returnInspection: { id: string }[] = await manager.query(
                `INSERT INTO inspections
                    (rental_id, type, performed_by, mileage_km,
                     fuel_level_pct, overall_condition, notes)
                 VALUES ($1::uuid, 'return', $2::uuid, $3, $4, $5, $6)
                 RETURNING id`,
                [
                    rentalId,
                    actorId,
                    input.mileageKm ?? null,
                    input.fuelLevelPct ?? null,
                    input.condition,
                    input.notes?.trim() || null,
                ],
            );
            const inspectionId = returnInspection[0]?.id;
            if (!inspectionId) {
                throw new ConflictException(
                    'Return inspection could not be recorded',
                );
            }

            const damageIds: string[] = [];
            for (const damage of input.damages ?? []) {
                const inserted: { id: string }[] = await manager.query(
                    `INSERT INTO inspection_damages
                        (inspection_id, vehicle_zone, description,
                         severity, estimated_repair_cost)
                     VALUES ($1::uuid, $2, $3, $4, $5)
                     RETURNING id`,
                    [
                        inspectionId,
                        damage.zone.trim(),
                        damage.description.trim(),
                        damage.severity,
                        damage.estimatedCost,
                    ],
                );
                damageIds.push(inserted[0].id);
            }

            const conditionComparison = {
                pickup: {
                    mileageKm: rental.pickupMileage,
                    fuelLevelPct: rental.pickupFuel,
                    condition: rental.pickupCondition,
                },
                returned: {
                    mileageKm: input.mileageKm ?? null,
                    fuelLevelPct: input.fuelLevelPct ?? null,
                    condition: input.condition,
                },
                travelledKm,
                fuelShortfallPct: fuelShortfall,
                excessKm,
                feePolicySnapshotAvailable: policy !== null,
            };
            const returnRecords: { id: string; reference: string }[] =
                await manager.query(
                    `INSERT INTO vehicle_returns
                        (rental_id, reservation_id, vehicle_id, customer_id,
                         scenario, scheduled_return_at, actual_return_at,
                         return_location_id, status, inspection_id,
                         condition_comparison, new_damage_found, is_late,
                         overdue_minutes, financial_review_flag,
                         awaiting_preparation, created_by)
                     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                         'AGENCY', $5, $6, $7::uuid, 'inspection_completed',
                         $8::uuid, $9::jsonb, $10, $11, $12, $13, true, $14::uuid)
                     RETURNING id, reference`,
                    [
                        rentalId,
                        rental.reservationId,
                        rental.vehicleId,
                        rental.customerId,
                        rental.expectedReturnAt,
                        returnedAt,
                        rental.assignedAgencyId,
                        inspectionId,
                        JSON.stringify(conditionComparison),
                        damageIds.length > 0,
                        overdueMinutes > 0,
                        overdueMinutes,
                        damageIds.length > 0 || !policy,
                        actorId,
                    ],
                );
            const returnRecord = returnRecords[0];

            const submitted: { id: string }[] = await manager.query(
                `INSERT INTO return_inspections
                    (return_id, rental_id, inspection_id, mileage_km,
                     fuel_level_pct, exterior_condition, keys_returned, inspector_notes,
                     submitted_at, submitted_by)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
                         $9, $10::uuid)
                 RETURNING id`,
                [
                    returnRecord.id,
                    rentalId,
                    inspectionId,
                    input.mileageKm ?? null,
                    input.fuelLevelPct ?? null,
                    input.condition,
                    input.keysReturned ?? false,
                    input.notes?.trim() || null,
                    returnedAt,
                    actorId,
                ],
            );

            for (let index = 0; index < (input.damages ?? []).length; index++) {
                const damage = input.damages![index];
                await manager.query(
                    `INSERT INTO return_damages
                        (return_id, vehicle_zone, description, severity,
                         pre_existing, reference_inspection_id)
                     VALUES ($1::uuid, $2, $3, $4, false, $5::uuid)`,
                    [
                        returnRecord.id,
                        damage.zone.trim(),
                        damage.description.trim(),
                        damage.severity,
                        rental.pickupInspectionId,
                    ],
                );
            }

            for (const fee of fees) {
                if (fee.amount <= 0) continue;
                await manager.query(
                    `INSERT INTO additional_charges
                        (rental_id, type, description, amount, created_by)
                     VALUES ($1::uuid, $2, $3, $4, $5::uuid)`,
                    [
                        rentalId,
                        fee.kind,
                        fee.description,
                        (fee.amount / 100).toFixed(2),
                        actorId,
                    ],
                );
            }

            const preparations: { id: string; reference: string }[] =
                await manager.query(
                    `INSERT INTO vehicle_preparations
                        (vehicle_id, return_id, rental_id, reservation_id,
                         return_inspection_id, status, cleaning_completed,
                         maintenance_required, maintenance_completed,
                         quality_approved, operational_ready, block_reason,
                         created_by)
                     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                         'awaiting_preparation', false, $6, false, false, false,
                         $7, $8::uuid)
                     RETURNING id, reference`,
                    [
                        rental.vehicleId,
                        returnRecord.id,
                        rentalId,
                        rental.reservationId,
                        submitted[0].id,
                        damageIds.length > 0,
                        damageIds.length
                            ? 'New damage requires maintenance review'
                            : 'Cleaning and quality release required',
                        actorId,
                    ],
                );
            const preparation = preparations[0];
            await manager.query(
                `INSERT INTO preparation_cleaning_tasks
                    (preparation_id, task_key, required)
                 VALUES ($1::uuid, 'return_cleaning', true)
                 ON CONFLICT (preparation_id, task_key) DO NOTHING`,
                [preparation.id],
            );
            await manager.query(
                `INSERT INTO preparation_events
                    (preparation_id, seq, event_type, to_status, actor_id,
                     actor_role, reason, evidence)
                 VALUES ($1::uuid, 1, 'RETURN_RECEIVED',
                         'awaiting_preparation', $2::uuid, $3,
                         'Vehicle received at assigned agency',
                         jsonb_build_array(jsonb_build_object(
                             'returnId', $4::uuid, 'inspectionId', $5::uuid
                         )))`,
                [preparation.id, actorId, rental.actorRole, returnRecord.id, inspectionId],
            );

            await manager.query(
                `UPDATE rentals SET status = 'returned', returned_at = $2
                 WHERE id = $1::uuid AND status = 'active'`,
                [rentalId, returnedAt],
            );
            if (input.mileageKm !== undefined) {
                await manager.query(
                    `UPDATE vehicles
                     SET mileage_km = $2, status = 'maintenance'
                     WHERE id = $1::uuid`,
                    [rental.vehicleId, input.mileageKm],
                );
            } else {
                await manager.query(
                    `UPDATE vehicles SET status = 'maintenance'
                     WHERE id = $1::uuid`,
                    [rental.vehicleId],
                );
            }

            await recordVehicleLocation(manager, {
                vehicleId: rental.vehicleId,
                eventKind: 'reservation_return',
                fromLocationId: rental.currentLocationId,
                toLocationId: rental.assignedAgencyId,
                reservationId: rental.reservationId,
                rentalId,
                actorId,
                source: 'admin',
                note: 'Vehicle returned to assigned rental agency',
            });

            await manager.query(
                `INSERT INTO audit_logs
                    (actor_id, action, entity_type, entity_id, new_values)
                 VALUES ($1::uuid, 'RENTAL_RETURNED', 'rental', $2::uuid,
                         $3::jsonb)`,
                [
                    actorId,
                    rentalId,
                    JSON.stringify({
                        returnId: returnRecord.id,
                        returnReference: returnRecord.reference,
                        inspectionId,
                        returnedAt: returnedAt.toISOString(),
                        mileageKm: input.mileageKm ?? null,
                        fuelLevelPct: input.fuelLevelPct ?? null,
                        lateDays,
                        travelledKm,
                        excessKm,
                        fuelShortfallPct: fuelShortfall,
                        feePolicySnapshotAvailable: policy !== null,
                        unverifiedDamageCount: damageIds.length,
                        preparationId: preparation.id,
                    }),
                ],
            );

            return {
                rentalId,
                returnId: returnRecord.id,
                returnReference: returnRecord.reference,
                inspectionId,
                preparationId: preparation.id,
                status: 'returned',
                returnedAt,
                lateDays,
                overdueMinutes,
                travelledKm,
                excessKm,
                fuelShortfallPct: fuelShortfall,
                automaticChargesEur: (
                    fees.reduce((sum, fee) => sum + fee.amount, 0) / 100
                ).toFixed(2),
                feePolicySnapshotAvailable: policy !== null,
                estimatedDamageAmountEur: (
                    (input.damages ?? []).reduce(
                        (sum, damage) => sum + cents(damage.estimatedCost),
                        0,
                    ) / 100
                ).toFixed(2),
                damageIds,
                preparationStatus: 'awaiting_preparation',
            };
        });

        await this.emailOutbox?.safelyNotifyVehicleReturned(rentalId, {
            returnReference: result.returnReference,
            automaticChargesEur: result.automaticChargesEur,
            estimatedDamageAmountEur: result.estimatedDamageAmountEur,
            lateDays: result.lateDays,
            excessKm: result.excessKm ?? undefined,
            fuelShortfallPct: result.fuelShortfallPct ?? undefined,
        });

        return result;
    }

    async damages(rentalId: string, actorId?: string) {
        if (actorId) {
            const staff = (await this.dataSource.query(
                `SELECT role FROM users WHERE id = $1::uuid AND status = 'active'`,
                [actorId],
            )) as { role: string }[];
            if (staff[0]?.role === 'staff') {
                await this.requireAgencyAccess(this.dataSource, actorId, rentalId);
            }
        }
        return this.dataSource.query(
            `SELECT d.id, d.vehicle_zone AS "zone", d.description, d.severity,
                    d.estimated_repair_cost AS "estimatedCost",
                    d.photo_path IS NOT NULL AS "hasPhoto",
                    i.type AS "inspectionType"
             FROM inspection_damages d
             JOIN inspections i ON i.id = d.inspection_id
             WHERE i.rental_id = $1::uuid
             ORDER BY i.performed_at, d.id`,
            [rentalId],
        );
    }

    async uploadDamagePhoto(damageId: string, file: PrivateUpload) {
        const found: { id: string; photo_path: string | null }[] =
            await this.dataSource.query(
                `SELECT id, photo_path FROM inspection_damages
                 WHERE id = $1::uuid`,
                [damageId],
            );
        if (!found[0]) {
            throw new NotFoundException('Damage record not found');
        }
        const name = await savePrivatePhoto(file);
        try {
            await this.dataSource.query(
                `UPDATE inspection_damages SET photo_path = $2
                 WHERE id = $1::uuid`,
                [damageId, name],
            );
        } catch (error) {
            await deletePrivatePhoto(name);
            throw error;
        }
        if (found[0].photo_path) {
            await deletePrivatePhoto(found[0].photo_path);
        }
        return { uploaded: true, damageId };
    }

    async damagePhoto(damageId: string) {
        const rows: { photo_path: string | null }[] =
            await this.dataSource.query(
                `SELECT photo_path FROM inspection_damages
                 WHERE id = $1::uuid`,
                [damageId],
            );
        if (!rows[0]?.photo_path) {
            throw new NotFoundException('Photo not found');
        }
        return readPrivatePhoto(rows[0].photo_path);
    }

    private async returnAccess(
        actorId: string,
        rentalId: string,
    ): Promise<ReturnAccess> {
        const rows: ReturnAccess[] = await this.dataSource.query(
            `SELECT vr.id AS "returnId", vr.inspection_id AS "inspectionId",
                    vr.return_location_id AS "agencyId", actor.role
             FROM vehicle_returns vr
             JOIN rentals l ON l.id = vr.rental_id
             JOIN users actor ON actor.id = $2::uuid
                 AND actor.status = 'active'
             WHERE l.id = $1::uuid`,
            [rentalId, actorId],
        );
        if (!rows[0]) {
            throw new NotFoundException('Return inspection not found');
        }
        if (rows[0].role === 'staff') {
            const assignments = await this.dataSource.query(
                `SELECT 1 FROM agency_staff_assignments
                 WHERE user_id = $1::uuid AND agency_id = $2::uuid`,
                [actorId, rows[0].agencyId],
            );
            if (!assignments.length) {
                throw new ForbiddenException(
                    'Staff member is not assigned to this return agency',
                );
            }
        } else if (rows[0].role !== 'admin') {
            throw new ForbiddenException(
                'Only authorized agency staff can view return evidence',
            );
        }
        return rows[0];
    }

    async returnPhotos(actorId: string, rentalId: string) {
        const access = await this.returnAccess(actorId, rentalId);
        return this.dataSource.query(
            `SELECT id, caption, created_at AS "createdAt"
             FROM return_evidence
             WHERE return_id = $1::uuid AND kind = 'photo'
             ORDER BY created_at, id`,
            [access.returnId],
        );
    }

    async uploadReturnPhoto(
        actorId: string,
        rentalId: string,
        file: PrivateUpload,
    ) {
        const access = await this.returnAccess(actorId, rentalId);
        const photoPath = await savePrivatePhoto(file);
        try {
            return await this.dataSource.transaction(async manager => {
                await manager.query(
                    `SELECT id FROM vehicle_returns
                     WHERE id = $1::uuid FOR UPDATE`,
                    [access.returnId],
                );
                const counts: { count: number }[] = await manager.query(
                    `SELECT count(*)::int AS count FROM return_evidence
                     WHERE return_id = $1::uuid AND kind = 'photo'`,
                    [access.returnId],
                );
                if ((counts[0]?.count ?? 0) >= 5) {
                    throw new BadRequestException(
                        'A return inspection can contain at most five photos',
                    );
                }
                const inserted: { id: string; createdAt: Date }[] =
                    await manager.query(
                        `INSERT INTO return_evidence
                            (return_id, inspection_id, kind, storage_path,
                             uploaded_by)
                         VALUES ($1::uuid, $2::uuid, 'photo', $3, $4::uuid)
                         RETURNING id, created_at AS "createdAt"`,
                        [
                            access.returnId,
                            access.inspectionId,
                            photoPath,
                            actorId,
                        ],
                    );
                await manager.query(
                    `INSERT INTO audit_logs
                        (actor_id, action, entity_type, entity_id, new_values)
                     VALUES ($1::uuid, 'RETURN_EVIDENCE_ADDED',
                             'vehicle_return', $2::uuid, $3::jsonb)`,
                    [
                        actorId,
                        access.returnId,
                        JSON.stringify({ evidenceId: inserted[0].id }),
                    ],
                );
                return inserted[0];
            });
        } catch (error) {
            await deletePrivatePhoto(photoPath);
            throw error;
        }
    }

    async returnPhoto(actorId: string, photoId: string) {
        const rows: { storagePath: string; agencyId: string; role: string }[] =
            await this.dataSource.query(
                `SELECT evidence.storage_path AS "storagePath",
                        vr.return_location_id AS "agencyId", actor.role
                 FROM return_evidence evidence
                 JOIN vehicle_returns vr ON vr.id = evidence.return_id
                 JOIN rentals l ON l.id = vr.rental_id
                 JOIN users actor ON actor.id = $2::uuid
                     AND actor.status = 'active'
                 WHERE evidence.id = $1::uuid AND evidence.kind = 'photo'`,
                [photoId, actorId],
            );
        if (!rows[0]) {
            throw new NotFoundException('Return photo not found');
        }
        if (rows[0].role === 'staff') {
            const assignments = await this.dataSource.query(
                `SELECT 1 FROM agency_staff_assignments
                 WHERE user_id = $1::uuid AND agency_id = $2::uuid`,
                [actorId, rows[0].agencyId],
            );
            if (!assignments.length) {
                throw new ForbiddenException(
                    'Staff member is not assigned to this return agency',
                );
            }
        } else if (rows[0].role !== 'admin') {
            throw new ForbiddenException(
                'Only authorized agency staff can view return evidence',
            );
        }
        return readPrivatePhoto(rows[0].storagePath);
    }

    async releaseVehicle(
        adminId: string,
        rentalId: string,
        input: ReleaseVehicleDto,
    ) {
        return this.dataSource.transaction(async manager => {
            const rows: {
                rentalId: string;
                status: string;
                vehicleId: string;
                vehicleStatus: string;
                returnId: string;
                preparationId: string;
                preparationStatus: string;
                maintenanceRequired: boolean;
                returnStatus: string;
            }[] = await manager.query(
                `SELECT l.id AS "rentalId", l.status, v.id AS "vehicleId",
                        v.status AS "vehicleStatus",
                        vr.id AS "returnId", vr.status AS "returnStatus",
                        prep.id AS "preparationId",
                        prep.status AS "preparationStatus",
                        prep.maintenance_required AS "maintenanceRequired"
                 FROM rentals l
                 JOIN reservations r ON r.id = l.reservation_id
                 JOIN vehicles v ON v.id = r.vehicle_id
                 JOIN vehicle_returns vr ON vr.rental_id = l.id
                 JOIN vehicle_preparations prep ON prep.return_id = vr.id
                 WHERE l.id = $1::uuid
                 FOR UPDATE OF l, v, vr, prep`,
                [rentalId],
            );
            if (!rows[0]) {
                throw new NotFoundException(
                    'Returned rental preparation record not found',
                );
            }
            const state = rows[0];
            if (state.status !== 'returned') {
                throw new ConflictException(
                    'The rental must be physically returned before preparation release',
                );
            }
            if (
                state.preparationStatus === 'ready_for_service' ||
                state.returnStatus === 'closed'
            ) {
                throw new ConflictException(
                    'This vehicle has already been released',
                );
            }
            if (!input.cleaningCompleted || !input.qualityApproved) {
                throw new ConflictException(
                    'Cleaning and final quality approval are required before release',
                );
            }
            if (
                state.maintenanceRequired &&
                !input.maintenanceCompleted
            ) {
                throw new ConflictException(
                    'Documented damage requires completed maintenance before release',
                );
            }
            if (state.vehicleStatus !== 'maintenance') {
                throw new ConflictException(
                    'Vehicle status changed unexpectedly; review fleet availability before release',
                );
            }

            const tasks: { id: string }[] = await manager.query(
                `SELECT id FROM preparation_cleaning_tasks
                 WHERE preparation_id = $1::uuid
                   AND task_key = 'return_cleaning'
                 FOR UPDATE`,
                [state.preparationId],
            );
            if (!tasks[0]) {
                throw new ConflictException(
                    'Required return cleaning task is missing',
                );
            }
            await manager.query(
                `UPDATE preparation_cleaning_tasks
                 SET completed = true, completed_by = $2::uuid,
                     completed_at = now(), notes = $3
                 WHERE id = $1::uuid`,
                [tasks[0].id, adminId, input.qualityNotes?.trim() || null],
            );
            await manager.query(
                `UPDATE vehicle_preparations
                 SET status = 'ready_for_service',
                     cleaning_completed = true,
                     maintenance_completed = $2,
                     quality_approved = true,
                     operational_ready = true,
                     quality_notes = $3,
                     ready_at = now(), reintegrated_at = now(),
                     reintegrated_by = $4::uuid, block_reason = NULL
                 WHERE id = $1::uuid`,
                [
                    state.preparationId,
                    input.maintenanceCompleted,
                    input.qualityNotes?.trim() || null,
                    adminId,
                ],
            );
            await manager.query(
                `UPDATE vehicle_returns
                 SET awaiting_preparation = false,
                     preparation_released_at = now(),
                     status = 'validated'
                 WHERE id = $1::uuid`,
                [state.returnId],
            );
            await manager.query(
                `UPDATE vehicles SET status = 'active'
                 WHERE id = $1::uuid AND status = 'maintenance'`,
                [state.vehicleId],
            );
            await manager.query(
                `INSERT INTO preparation_events
                    (preparation_id, seq, event_type, from_status, to_status,
                     actor_id, actor_role, reason)
                 SELECT $1::uuid,
                        COALESCE(max(seq), 0) + 1,
                        'RELEASED_TO_SERVICE',
                        $2, 'ready_for_service', $3::uuid, 'admin', $4
                 FROM preparation_events
                 WHERE preparation_id = $1::uuid`,
                [
                    state.preparationId,
                    state.preparationStatus,
                    adminId,
                    input.qualityNotes?.trim() ||
                        'Cleaning, maintenance and quality checks completed',
                ],
            );
            await manager.query(
                `INSERT INTO audit_logs
                    (actor_id, action, entity_type, entity_id, new_values)
                 VALUES ($1::uuid, 'VEHICLE_RETURN_RELEASED',
                         'vehicle_preparation', $2::uuid, $3::jsonb)`,
                [
                    adminId,
                    state.preparationId,
                    JSON.stringify({
                        rentalId,
                        vehicleId: state.vehicleId,
                        cleaningCompleted: true,
                        maintenanceRequired: state.maintenanceRequired,
                        maintenanceCompleted: input.maintenanceCompleted,
                        qualityApproved: true,
                    }),
                ],
            );
            return {
                rentalId,
                preparationId: state.preparationId,
                status: 'ready_for_service',
                vehicleStatus: 'active',
            };
        });
    }

    async close(adminId: string, rentalId: string) {
        const result = await this.dataSource.transaction(async manager => {
            const rows: { id: string; status: string }[] =
                await manager.query(
                    `SELECT id, status FROM rentals
                     WHERE id = $1::uuid FOR UPDATE`,
                    [rentalId],
                );
            if (!rows[0]) {
                throw new NotFoundException('Rental not found');
            }
            if (rows[0].status !== 'returned') {
                throw new ConflictException(
                    'Return inspection required before closure',
                );
            }
            const holds: { status: string }[] = await manager.query(
                `SELECT status FROM security_deposits WHERE rental_id = $1`,
                [rentalId],
            );
            if (
                holds[0] &&
                ['held', 'pending'].includes(holds[0].status)
            ) {
                throw new ConflictException(
                    'Resolve security deposit before closing rental',
                );
            }
            const issued: { id: string }[] = await manager.query(
                `SELECT id FROM invoices
                 WHERE rental_id = $1 AND status = 'issued' LIMIT 1`,
                [rentalId],
            );
            if (!issued[0]) {
                throw new ConflictException(
                    'Issue final invoice before closing rental',
                );
            }
            const balances: {
                total: string;
                charges: string;
                paid: string;
            }[] = await manager.query(
                `SELECT r.total_amount::text AS total,
                        COALESCE((SELECT sum(amount)
                                  FROM additional_charges
                                  WHERE rental_id = l.id), 0)::text AS charges,
                        COALESCE((SELECT sum(
                            CASE WHEN type = 'refund' THEN -amount
                                 WHEN type IN ('rental_payment', 'charge_payment')
                                 THEN amount ELSE 0 END)
                                  FROM payments WHERE rental_id = l.id), 0)::text AS paid
                 FROM rentals l
                 JOIN reservations r ON r.id = l.reservation_id
                 WHERE l.id = $1::uuid`,
                [rentalId],
            );
            const due =
                cents(balances[0].total) +
                cents(balances[0].charges) -
                cents(balances[0].paid);
            if (due !== 0) {
                throw new ConflictException(
                    'Balance is not settled: record outstanding payment or refund before closure',
                );
            }
            await manager.query(
                `UPDATE rentals
                 SET status = 'closed', closed_at = now(), closed_by = $2::uuid
                 WHERE id = $1::uuid`,
                [rentalId, adminId],
            );
            await manager.query(
                `INSERT INTO audit_logs
                    (actor_id, action, entity_type, entity_id)
                 VALUES ($1::uuid, 'RENTAL_CLOSED', 'rental', $2::uuid)`,
                [adminId, rentalId],
            );
            return { rentalId, status: 'closed' };
        });

        await this.emailOutbox?.safelyNotifyRentalClosed(rentalId);

        return result;
    }
}
