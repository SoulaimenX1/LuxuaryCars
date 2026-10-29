import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import { DataSource, QueryFailedError } from 'typeorm';
import { StartRentalDto } from './dto/start-rental.dto.js';
import { ExtendRentalDto } from './dto/extend-rental.dto.js';
import { rentalDaysBetween } from '../availability/timezone.js';
import { recordVehicleLocation } from '../vehicle-movements/vehicle-location.js';
import { resolveServicePointDestination } from '../vehicle-movements/service-point-destination.js';
import {noShowDeadlineExpression} from '../reservations/no-show-deadline.js';
import {checkInCodeMatches} from './check-in-code.js';
import { EmailOutboxService } from '../notifications/email-outbox.service.js';
import {
  deletePrivatePhoto,
  readPrivatePhoto,
  savePrivatePhoto,
} from '../returns/private-photos.js';
import type {PrivateUpload} from '../returns/private-photos.js';

// Résultat d'une lecture PostgreSQL, avec des noms adaptés à l'API.
interface ReservationForHandover {
  id: string;
  reservationNumber: string;
  customerId: string;
  vehicleId: string;
  status: string;
  paidAt?: Date | null;
  isDemoPayment?: boolean | null;
  agencyPaymentStatus?: string | null;
  hasLedgerPayment?: boolean | null;
  totalAmount?: number | string | null;
  depositAmount?: number | string | null;
  realRentalPaid?: number | string | null;
  depositPaid?: number | string | null;
  hasHeldDeposit?: boolean | null;
  pickupAt: Date;
  returnAt: Date;
  noShowDeadlineAt: Date;
  vehicleStatus: string;
  vehicleMileage: number;
  agencyId: string;
  codeHash: string;
  failedAttempts: number;
  credentialExpiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  pickupLocationId: string | null;
  assignedAgencyId: string | null;
  agencyEnabled: boolean | null;
  agencyCategory: string | null;
  agencyCanPickup: boolean | null;
  agencyCanDropoff: boolean | null;
  returnLocationId: string | null;
  licenseIssuedOn: string;
  licenseExpiresOn: string;
  currentLocationId: string | null;
}

export interface RentalRow {
  id: string;
  contractNumber: string;
  reservationId: string;
  reservationNumber: string;
  vehicleId: string;
  customerId: string;
  customerName: string;
  vehicleName: string;
  licensePlate: string;
  status: string;
  startedAt: Date;
  expectedReturnAt: Date;
  returnedAt: Date | null;
  assignedAgencyName?: string | null;
  returnReference?: string | null;
  returnStatus?: string | null;
  returnInspectionMileageKm?: number | null;
  returnInspectionFuelLevelPct?: number | null;
  returnInspectionCondition?: string | null;
  returnInspectionNotes?: string | null;
  preparationStatus?: string | null;
  operationalReady?: boolean | null;
  pickupMileageKm: number | null;
  pickupFuelLevelPct: number | null;
  pickupCondition: string | null;
  notes: string | null;
  isOverdue: boolean;
  extensions?: unknown[];
}

interface CheckInPhotoRow {
  id: string;
  photoPath: string;
}

@Injectable()
export class RentalsService {
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly emailOutbox?: EmailOutboxService,
  ) {}

  // Liste des locations déjà démarrées, avec isolation stricte par agence pour le personnel.
  async findAll(user?: { id: string; role?: string }): Promise<RentalRow[]> {
    const isStaff = user?.role === 'staff';
    const whereClause = isStaff
      ? `WHERE COALESCE(credential.agency_id, assigned.id) IN (
           SELECT agency_id FROM agency_staff_assignments WHERE user_id = $1::uuid
         )`
      : '';
    const params = isStaff ? [user.id] : [];

    return this.dataSource.query(`
      SELECT l.id,
             l.contract_number AS "contractNumber",
             l.reservation_id AS "reservationId",
             r.reservation_number AS "reservationNumber",
             r.vehicle_id AS "vehicleId",
             r.customer_id AS "customerId",
             CONCAT(u.first_name, ' ', u.last_name) AS "customerName",
             CONCAT(b.name, ' ', m.name) AS "vehicleName",
             v.license_plate AS "licensePlate",
             l.status,
             l.started_at AS "startedAt",
             l.expected_return_at AS "expectedReturnAt",
             l.returned_at AS "returnedAt",
             i.mileage_km AS "pickupMileageKm",
             i.fuel_level_pct AS "pickupFuelLevelPct",
             i.overall_condition AS "pickupCondition",
             agency.name AS "assignedAgencyName",
             vr.reference AS "returnReference",
             vr.status AS "returnStatus",
             returnInspection.mileage_km AS "returnInspectionMileageKm",
             returnInspection.fuel_level_pct AS "returnInspectionFuelLevelPct",
             returnInspection.exterior_condition AS "returnInspectionCondition",
             returnInspection.inspector_notes AS "returnInspectionNotes",
             preparation.status AS "preparationStatus",
             preparation.operational_ready AS "operationalReady",
             l.notes,
             (SELECT COALESCE(json_agg(json_build_object(
               'id', e.id, 'oldReturnAt', e.old_return_at,
               'newReturnAt', e.new_return_at, 'additionalAmount', e.additional_amount,
               'reason', e.reason, 'createdAt', e.created_at
             ) ORDER BY e.created_at DESC), '[]'::json)
             FROM rental_extensions e WHERE e.rental_id = l.id) AS "extensions",
             (l.status = 'active' AND l.expected_return_at < NOW()) AS "isOverdue"
      FROM rentals l
      JOIN reservations r ON r.id = l.reservation_id
      JOIN users u ON u.id = r.customer_id
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      LEFT JOIN inspections i ON i.rental_id = l.id AND i.type = 'handover'
      LEFT JOIN reservation_checkin_credentials credential
             ON credential.reservation_id = r.id
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN count(*) = 1 THEN (array_agg(mapped.location_id))[1]
          ELSE NULL
        END AS id
        FROM (
          SELECT v.home_location_id AS location_id
          WHERE v.home_location_id IS NOT NULL
          UNION
          SELECT vrl.location_id FROM vehicle_rental_locations vrl
          WHERE vrl.vehicle_id = v.id
        ) mapped
      ) assigned ON true
      LEFT JOIN rental_locations agency
             ON agency.id = COALESCE(credential.agency_id, assigned.id)
      LEFT JOIN vehicle_returns vr ON vr.rental_id = l.id
      LEFT JOIN return_inspections returnInspection
             ON returnInspection.return_id = vr.id
      LEFT JOIN vehicle_preparations preparation
             ON preparation.return_id = vr.id
      ${whereClause}
      ORDER BY l.created_at DESC
    `, params);
  }

  // Les informations personnelles restent limitées aux locations du client authentifié.
  // Le filtrage s'effectue dans PostgreSQL, jamais uniquement dans l'interface.
  async findMyRentals(customerId: string): Promise<unknown[]> {
    return this.dataSource.query(`
      SELECT l.id,
             l.contract_number AS "contractNumber",
             r.reservation_number AS "reservationNumber",
             r.vehicle_id AS "vehicleId",
             CONCAT(b.name, ' ', m.name) AS "vehicleName",
             v.license_plate AS "licensePlate",
             l.status,
             l.started_at AS "startedAt",
             l.expected_return_at AS "expectedReturnAt",
             l.returned_at AS "returnedAt",
             i.mileage_km AS "pickupMileageKm",
             i.fuel_level_pct AS "pickupFuelLevelPct",
             i.overall_condition AS "pickupCondition",
             (SELECT COALESCE(json_agg(json_build_object(
               'id', e.id, 'oldReturnAt', e.old_return_at,
               'newReturnAt', e.new_return_at, 'createdAt', e.created_at
             ) ORDER BY e.created_at DESC), '[]'::json)
             FROM rental_extensions e WHERE e.rental_id = l.id) AS "extensions",
             (l.status = 'active' AND l.expected_return_at < NOW()) AS "isOverdue"
      FROM rentals l
      JOIN reservations r ON r.id = l.reservation_id
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      JOIN brands b ON b.id = m.brand_id
      LEFT JOIN inspections i ON i.rental_id = l.id AND i.type = 'handover'
      WHERE r.customer_id = $1
      ORDER BY l.started_at DESC, l.id DESC
    `, [customerId]);
  }

  // Prolonger une location existante dans une transaction unique.
  // La réservation garde les mêmes dates que la location pour bloquer
  // toute réservation concurrente dans la plage prolongée.
  async extendRental(adminId: string, rentalId: string, dto: ExtendRentalDto) {
    // Validate the requested civil date without touching the database so
    // that an invalid date never opens a transaction.
    const probe = new Date(`${dto.newReturnDate}T00:00:00.000Z`);
    if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== dto.newReturnDate) {
      throw new BadRequestException('Invalid new return date');
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Verrouiller le véhicule avant d'inspecter les réservations : même
        // verrou que les triggers PostgreSQL anti-chevauchement.
        const vehicles: { id: string; status: string }[] = await manager.query(`
          SELECT v.id, v.status
          FROM vehicles v
          JOIN reservations r ON r.vehicle_id = v.id
          JOIN rentals l ON l.reservation_id = r.id
          WHERE l.id = $1::uuid
          FOR UPDATE OF v
        `, [rentalId]);
        if (!vehicles[0]) throw new NotFoundException('Rental not found');
        if (vehicles[0].status !== 'active') {
          throw new ConflictException('This vehicle is not active');
        }

        const rows: {
          id: string; status: string; contractNumber: string;
          reservationId: string; reservationStatus: string; vehicleId: string;
          pickupAt: Date; returnAt: Date; expectedReturnAt: Date;
          dailyPrice: string; totalAmount: string; licenseExpiresOn: string;
          turnaroundMinutes: number;
        }[] = await manager.query(`
          SELECT l.id, l.status, l.contract_number AS "contractNumber",
                 r.id AS "reservationId", r.status AS "reservationStatus",
                 r.vehicle_id AS "vehicleId", r.pickup_at AS "pickupAt",
                 r.return_at AS "returnAt", l.expected_return_at AS "expectedReturnAt",
                 r.daily_price AS "dailyPrice", r.total_amount AS "totalAmount",
                 to_char(cp.license_expires_on, 'YYYY-MM-DD') AS "licenseExpiresOn",
                 COALESCE(loc.turnaround_minutes, 0) AS "turnaroundMinutes"
          FROM rentals l
          JOIN reservations r ON r.id = l.reservation_id
          JOIN customer_profiles cp ON cp.user_id = r.customer_id
          LEFT JOIN reservation_preferences p ON p.reservation_id = r.id
          LEFT JOIN rental_locations loc ON loc.id = p.pickup_location_id
          WHERE l.id = $1::uuid
          FOR UPDATE OF l, r
        `, [rentalId]);
        const rental = rows[0];
        if (!rental) throw new NotFoundException('Rental not found');
        if (rental.status !== 'active' || rental.reservationStatus !== 'converted') {
          throw new ConflictException('Only active rentals can be extended');
        }
        const oldReturnAt = new Date(rental.expectedReturnAt);
        if (oldReturnAt.getTime() !== new Date(rental.returnAt).getTime()) {
          throw new ConflictException('Reservation and rental dates are inconsistent');
        }
        // Preserve the time-of-day from the existing expected return so that
        // midnight UTC is never imposed and timezone drift is avoided.
        const rawTime = dto.newReturnTime ?? oldReturnAt.toISOString().slice(11, 19);
        const timeOfDay = /^\d{2}:\d{2}$/.test(rawTime) ? `${rawTime}:00` : rawTime;
        const newReturnAt = new Date(`${dto.newReturnDate}T${timeOfDay}.000Z`);
        if (Number.isNaN(newReturnAt.getTime())) {
          throw new BadRequestException('Invalid new return date');
        }
        if (newReturnAt <= new Date()) {
          throw new BadRequestException('The new return date must be in the future');
        }
        if (newReturnAt <= oldReturnAt) {
          throw new BadRequestException('New return date must be later than the current return date');
        }
        if (rental.licenseExpiresOn < dto.newReturnDate) {
          throw new ConflictException('Customer driving licence expires before the new return date');
        }
        // Facturation : mêmes règles que la réservation et le devis
        // (`rentalDaysBetween`) afin que les jours facturables de la période
        // d'origine et de la période prolongée restent cohérents.
        const pickupAt = new Date(rental.pickupAt);
        const originalBillableDays = rentalDaysBetween(pickupAt, oldReturnAt);
        const newBillableDays = rentalDaysBetween(pickupAt, newReturnAt);
        if (newBillableDays < originalBillableDays) {
          throw new BadRequestException('The extension produces an invalid rental duration');
        }
        // Jours supplémentaires réellement facturés = différence des jours
        // facturables. La durée écoulée ajoutée est conservée séparément.
        const additionalBillableDays = newBillableDays - originalBillableDays;
        const extensionHours = Math.max(0, (newReturnAt.getTime() - oldReturnAt.getTime()) / 3_600_000);

        // Rechercher les réservations d'autres clients et les maintenances
        // uniquement sur la période supplémentaire (borne de début incluse),
        // en respectant le délai de remise à disposition du lieu de départ.
        const turnaroundMs = Math.max(0, Number(rental.turnaroundMinutes) || 0) * 60_000;
        const rangeStart = new Date(oldReturnAt.getTime() - turnaroundMs);
        const rangeEnd = new Date(newReturnAt.getTime() + turnaroundMs);
        const conflicts: { blocked: boolean }[] = await manager.query(`
          SELECT (
            EXISTS (
              SELECT 1 FROM reservations r
              WHERE r.vehicle_id = $1::uuid AND r.id <> $2::uuid
                AND r.status IN ('pending', 'confirmed', 'converted')
                AND r.period && tstzrange($3::timestamptz, $4::timestamptz, '[)')
            ) OR EXISTS (
              SELECT 1 FROM vehicle_unavailability u
              WHERE u.vehicle_id = $1::uuid
                AND u.period && tstzrange($3::timestamptz, $4::timestamptz, '[)')
            )
          ) AS blocked
        `, [rental.vehicleId, rental.reservationId, rangeStart.toISOString(), rangeEnd.toISOString()]);
        if (conflicts[0]?.blocked) {
          throw new ConflictException('Vehicle is reserved or unavailable during the requested extension');
        }

        // Le total de la réservation reste basé sur le tarif JOURNALIER
        // figé à la réservation, pas sur le prix catalogue courant.
        // Recalculer les prestations facturées par jour avec le prix figé
        // à la réservation. Les prestations ponctuelles ne sont pas multipliées.
        const updatedResult = await manager.query(`
          WITH extras AS (
            SELECT COALESCE(SUM(CASE WHEN pricing_snapshot = 'daily'
                  THEN unit_price_snapshot * $3 ELSE amount_snapshot END), 0)::numeric AS amount
            FROM reservation_extras WHERE reservation_id = $1::uuid
          )
          UPDATE reservations r
          SET return_at = $2::timestamptz,
              rental_days = $3,
              extras_amount = extras.amount,
              total_amount = r.daily_price * $3 + extras.amount + r.delivery_amount - r.discount_amount
          FROM extras
          WHERE r.id = $1::uuid AND r.status = 'converted'
          RETURNING r.total_amount AS "totalAmount"
        `, [rental.reservationId, newReturnAt.toISOString(), newBillableDays]);
        // TypeORM 1.x : UPDATE ... RETURNING renvoie [lignes, nombre].
        const updated: { totalAmount: string }[] =
          Array.isArray(updatedResult?.[0]) ? updatedResult[0] : updatedResult;
        if (!updated[0]) {
          throw new ConflictException('The reservation could not be extended');
        }
        if (!updated[0]) throw new ConflictException('Reservation cannot be extended');
        await manager.query(`
          UPDATE rentals SET expected_return_at = $2::timestamptz
          WHERE id = $1::uuid AND status = 'active'
        `, [rentalId, newReturnAt.toISOString()]);

        // Historique immuable : identifiant admin + montant de la prolongation.
        const history: {
          id: string; additionalAmount: string; createdAt: Date;
        }[] = await manager.query(`
          INSERT INTO rental_extensions (
            rental_id, old_return_at, new_return_at, old_total_amount,
            new_total_amount, additional_amount, extended_by, reason
          ) VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4::numeric,
                    $5::numeric, $5::numeric - $4::numeric, $6::uuid, $7)
          RETURNING id, additional_amount AS "additionalAmount", created_at AS "createdAt"
        `, [rentalId, oldReturnAt.toISOString(), newReturnAt.toISOString(),
          rental.totalAmount, updated[0].totalAmount, adminId, dto.reason?.trim() || null]);

        return {
          rentalId, contractNumber: rental.contractNumber,
          previousReturnAt: oldReturnAt,
          expectedReturnAt: newReturnAt,
          previousTotalAmount: rental.totalAmount,
          newTotalAmount: updated[0].totalAmount,
          additionalAmount: history[0].additionalAmount,
          originalBillableDays,
          newBillableDays,
          additionalBillableDays,
          extensionHours,
          // Conservé pour compatibilité ascendante des consommateurs existants.
          additionalDays: additionalBillableDays,
          extensionId: history[0].id,
        };
      });
    } catch (error) {
      // L'exclusion GiST et les triggers restent l'ultime protection
      // contre les conflits qui apparaissent pendant la transaction.
      if (error instanceof QueryFailedError) {
        const code = (error.driverError as { code?: string } | undefined)?.code;
        if (code === '23P01') {
          throw new ConflictException('Vehicle is unavailable for this extension');
        }
      }
      throw error;
    }
  }

  // Remise du véhicule : une seule opération atomique dans PostgreSQL.
  async startRental(adminId: string, dto: StartRentalDto): Promise<RentalRow> {
    if (!dto.identityVerified) {
      throw new BadRequestException('Verify the customer identity at the assigned agency before check-in');
    }
    const outcome = await this.dataSource.transaction(async (manager) => {
      const gracePeriodMinutes = this.config?.get<number>(
        'NO_SHOW_GRACE_PERIOD_MINUTES',
        120,
      ) ?? 120;
      const deadline = noShowDeadlineExpression('$3');
      // Verrouiller la réservation ET le véhicule : une remise concurrente
      // ne doit jamais démarrer deux locations pour une seule voiture.
      const reservations: ReservationForHandover[] = await manager.query(`
        SELECT r.id, r.reservation_number AS "reservationNumber",
               r.customer_id AS "customerId",
               r.vehicle_id AS "vehicleId", r.status,
               r.paid_at AS "paidAt",
               r.is_demo_payment AS "isDemoPayment",
               r.agency_payment_status AS "agencyPaymentStatus",
               r.total_amount AS "totalAmount",
               r.deposit_amount AS "depositAmount",
               COALESCE((
                 SELECT SUM(p.amount) FROM payments p
                 WHERE p.reservation_id = r.id
                   AND p.type = 'rental_payment'
                   AND p.paid_at IS NOT NULL
                   AND p.is_demo = false AND p.is_simulated = false
               ), 0) AS "realRentalPaid",
                COALESCE((
                  SELECT SUM(p.amount) FROM payments p
                  WHERE p.reservation_id = r.id
                    AND p.type = 'deposit_payment'
                    AND p.paid_at IS NOT NULL
                ), 0) AS "depositPaid",
               EXISTS (
                 SELECT 1 FROM security_deposits sd
                 WHERE sd.reservation_id = r.id
                   AND sd.status = 'held'
                   AND sd.amount >= r.deposit_amount
               ) AS "hasHeldDeposit",
               r.pickup_at AS "pickupAt", r.return_at AS "returnAt",
               ${deadline} AS "noShowDeadlineAt",
               v.status AS "vehicleStatus", v.mileage_km AS "vehicleMileage",
               c.agency_id AS "agencyId",
               c.code_hash AS "codeHash",
               c.failed_attempts AS "failedAttempts",
               c.expires_at AS "credentialExpiresAt",
               c.consumed_at AS "consumedAt",
               c.revoked_at AS "revokedAt",
               p.pickup_location_id AS "pickupLocationId",
               p.dropoff_location_id AS "returnLocationId",
               agency.id AS "assignedAgencyId",
               agency.enabled AS "agencyEnabled",
               agency.category AS "agencyCategory",
               agency.can_pickup AS "agencyCanPickup",
               agency.can_dropoff AS "agencyCanDropoff",
               v.current_location_id AS "currentLocationId",
               to_char(cp.license_issued_on, 'YYYY-MM-DD') AS "licenseIssuedOn",
               to_char(cp.license_expires_on, 'YYYY-MM-DD') AS "licenseExpiresOn"
        FROM reservations r
        JOIN vehicles v ON v.id = r.vehicle_id
        JOIN customer_profiles cp ON cp.user_id = r.customer_id
        JOIN reservation_checkin_credentials c
          ON c.reservation_id = r.id AND c.customer_id = r.customer_id
        LEFT JOIN reservation_preferences p ON p.reservation_id = r.id
        LEFT JOIN rental_locations loc ON loc.id = p.pickup_location_id
        LEFT JOIN LATERAL (
          SELECT CASE
            WHEN count(*) = 0 THEN (
              SELECT fallback.id FROM rental_locations fallback
              WHERE fallback.code = $2 AND fallback.enabled = true
                AND fallback.category = 'showroom'
                AND fallback.can_pickup = true AND fallback.can_dropoff = true
            )
            WHEN count(*) = 1 THEN (array_agg(mapped.location_id))[1]
            ELSE NULL
          END AS id
          FROM (
            SELECT v.home_location_id AS location_id
            WHERE v.home_location_id IS NOT NULL
            UNION
            SELECT vrl.location_id FROM vehicle_rental_locations vrl
            WHERE vrl.vehicle_id = v.id
          ) mapped
        ) assigned ON true
        LEFT JOIN rental_locations agency ON agency.id = assigned.id
        WHERE r.reservation_number = $1
        FOR UPDATE OF r, v, c
      `, [
        dto.reservationNumber.trim().toUpperCase(),
        this.config?.get<string>('DEFAULT_RENTAL_AGENCY_CODE', 'BUD-SHOWROOM') ?? 'BUD-SHOWROOM',
        gracePeriodMinutes,
      ]);

      const reservation = reservations[0];
      if (!reservation) {
        throw new NotFoundException('Reservation not found');
      }
      if (reservation.status !== 'confirmed') {
        throw new ConflictException('Only confirmed reservations can start a rental');
      }

      const totalAmount = Number(reservation.totalAmount ?? 0);
      const depositAmount = Number(reservation.depositAmount ?? 0);
      const realRentalPaid = Number(reservation.realRentalPaid ?? 0);
      const depositPaid = Number(reservation.depositPaid ?? 0);
      const depositSatisfied = Boolean(reservation.hasHeldDeposit) || depositPaid >= depositAmount || depositAmount <= 0;

      // Real payment verification: real paid amount covers total + deposit condition satisfied
      // (Independent of whether an earlier agency request was rejected)
      const hasVerifiedRealPayment = (Boolean(reservation.paidAt) || realRentalPaid >= totalAmount) &&
                                     realRentalPaid >= totalAmount &&
                                     depositSatisfied;

      if (!hasVerifiedRealPayment) {
        throw new ConflictException(
          'Cannot start rental: reservation must have a verified payment covering rental total and security deposit',
        );
      }
      if (reservation.vehicleStatus !== 'active') {
        throw new ConflictException('The selected vehicle is not active');
      }
      if (
        !reservation.pickupLocationId ||
        reservation.pickupLocationId !== reservation.assignedAgencyId ||
        reservation.returnLocationId !== reservation.assignedAgencyId ||
        reservation.agencyId !== reservation.assignedAgencyId ||
        reservation.agencyEnabled !== true ||
        reservation.agencyCategory !== 'showroom' ||
        reservation.agencyCanPickup !== true ||
        reservation.agencyCanDropoff !== true
      ) {
        throw new ConflictException('The reservation does not match the vehicle agency');
      }

      const now = new Date();
      // Revérifier le permis au moment de la remise, sans validation manuelle.
      // Il doit être délivré et rester valable jusqu'à la fin de la location.
      const pickupDay = now.toISOString().slice(0, 10);
      const returnDay = new Date(reservation.returnAt).toISOString().slice(0, 10);
      if (!reservation.licenseIssuedOn || !reservation.licenseExpiresOn ||
          reservation.licenseIssuedOn > pickupDay ||
          reservation.licenseExpiresOn < returnDay) {
        throw new ConflictException('Customer driving licence is not valid for the rental period');
      }
      if (now < new Date(reservation.pickupAt)) {
        throw new ConflictException('The scheduled pickup date has not arrived');
      }
      if (now >= new Date(reservation.noShowDeadlineAt)) {
        throw new ConflictException('The collection deadline has passed; this reservation can no longer be handed over');
      }
      if (now >= new Date(reservation.returnAt)) {
        throw new ConflictException('The scheduled return date has already passed');
      }
      if (
        reservation.consumedAt ||
        reservation.revokedAt ||
        now >= new Date(reservation.credentialExpiresAt) ||
        reservation.failedAttempts >= 5
      ) {
        throw new ConflictException('The check-in code is expired, locked or already used');
      }

      const staff: {role: string}[] = await manager.query(`
        SELECT role FROM users WHERE id = $1::uuid AND status = 'active'
      `, [adminId]);
      if (!staff[0]) throw new UnauthorizedException('Active staff authentication is required');
      if (staff[0].role === 'staff') {
        const assignment: {userId: string}[] = await manager.query(`
          SELECT user_id AS "userId" FROM agency_staff_assignments
          WHERE user_id = $1::uuid AND agency_id = $2::uuid
        `, [adminId, reservation.assignedAgencyId]);
        if (!assignment.length) {
          throw new ForbiddenException('Staff member is not assigned to this agency');
        }
      } else if (staff[0].role !== 'admin') {
        throw new ForbiddenException('Only authorized agency staff can verify check-in');
      }

      if (!checkInCodeMatches(dto.code, reservation.codeHash)) {
        const failures: {failed_attempts: number}[] = await manager.query(`
          UPDATE reservation_checkin_credentials
          SET failed_attempts = LEAST(failed_attempts + 1, 5),
              revoked_at = CASE
                WHEN failed_attempts + 1 >= 5 THEN COALESCE(revoked_at, now())
                ELSE revoked_at
              END
          WHERE reservation_id = $1::uuid
          RETURNING failed_attempts
        `, [reservation.id]);
        return {
          invalidCode: true as const,
          failedAttempts: failures[0]?.failed_attempts ?? 0,
        };
      }

      if (dto.mileageKm !== undefined && dto.mileageKm < reservation.vehicleMileage) {
        throw new ConflictException('Pickup mileage cannot be lower than current vehicle mileage');
      }
      // Une autre location encore active ne peut pas occuper ce véhicule.
      const overlapping: { id: string }[] = await manager.query(`
        SELECT l.id FROM rentals l
        JOIN reservations r ON r.id = l.reservation_id
        WHERE r.vehicle_id = $1 AND l.status = 'active'
        LIMIT 1
      `, [reservation.vehicleId]);
      if (overlapping.length) {
        throw new ConflictException('This vehicle already has an active rental');
      }

      const consumed: {reservationId: string}[] = await manager.query(`
        UPDATE reservation_checkin_credentials
        SET consumed_at = now()
        WHERE reservation_id = $1::uuid
          AND customer_id = $2::uuid
          AND agency_id = $3::uuid
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
          AND failed_attempts < 5
        RETURNING reservation_id AS "reservationId"
      `, [reservation.id, reservation.customerId, reservation.assignedAgencyId]);
      if (!consumed.length) {
        throw new ConflictException('Check-in credential is no longer valid');
      }

      const feePolicies: {
        lateFeePerDay: string;
        fuelFeePerPercent: string;
        mileageAllowancePerDay: number;
        excessMileageFee: string;
      }[] = await manager.query(`
        SELECT late_fee_per_day AS "lateFeePerDay",
               fuel_fee_per_percent AS "fuelFeePerPercent",
               mileage_allowance_per_day AS "mileageAllowancePerDay",
               excess_mileage_fee AS "excessMileageFee"
        FROM rental_fee_policy
        WHERE id = 1
      `);
      const feePolicySnapshot = feePolicies[0] ?? null;

      const created: { id: string }[] = await manager.query(`
        INSERT INTO rentals (
          reservation_id, expected_return_at, opened_by, notes,
          return_fee_policy_snapshot
        ) VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING id
      `, [
        reservation.id,
        reservation.returnAt,
        adminId,
        dto.notes?.trim() || 'Verified agency check-in.',
        feePolicySnapshot ? JSON.stringify(feePolicySnapshot) : null,
      ]);
      const rentalId = created[0]?.id;
      if (!rentalId) {
        throw new ConflictException('The rental could not be created');
      }

      // La première inspection mémorise l'état initial avant la sortie.
      await manager.query(`
        INSERT INTO inspections (
          rental_id, type, performed_by, mileage_km,
          fuel_level_pct, overall_condition, notes
        ) VALUES ($1, 'handover', $2, $3, $4, $5, $6)
      `, [
        rentalId,
        adminId,
        dto.mileageKm ?? null,
        dto.fuelLevelPct ?? null,
        dto.overallCondition ?? null,
        dto.notes?.trim() || 'Verified agency check-in.',
      ]);

      // La réservation reste liée à la location (historique conservé).
      await manager.query(`
        UPDATE reservations SET status = 'converted'
        WHERE id = $1 AND status = 'confirmed'
      `, [reservation.id]);
      await manager.query(`
        INSERT INTO audit_logs
          (actor_id, action, entity_type, entity_id, old_values, new_values)
        VALUES ($1::uuid, 'AGENCY_CHECK_IN_VERIFIED', 'reservation', $2::uuid,
          jsonb_build_object('status', 'confirmed'),
          jsonb_build_object(
            'status', 'converted',
            'agencyId', $3::uuid,
            'rentalId', $4::uuid,
            'checkedInAt', now()
          ))
      `, [adminId, reservation.id, reservation.assignedAgencyId, rentalId]);

      // Registre physique append-only : collection is recorded at the
      // agency fixed to the vehicle and reservation.
      const pickupDestination = await resolveServicePointDestination(
        manager,
        reservation.id,
        'pickup',
      );
      await recordVehicleLocation(manager, {
        vehicleId: reservation.vehicleId,
        eventKind: 'reservation_pickup',
        fromLocationId: reservation.currentLocationId,
        toLocationId: pickupDestination.locationId,
        toAddress: pickupDestination.address ?? undefined,
        reservationId: reservation.id,
        rentalId,
        actorId: adminId,
        source: 'admin',
        note: 'Verified agency check-in — vehicle handed over',
      });
      if (dto.mileageKm !== undefined) {
        await manager.query(`
          UPDATE vehicles SET mileage_km = $2 WHERE id = $1
        `, [reservation.vehicleId, dto.mileageKm]);
      }

      const rentals: RentalRow[] = await manager.query(`
        SELECT l.id, l.contract_number AS "contractNumber",
               l.reservation_id AS "reservationId",
               r.reservation_number AS "reservationNumber",
               r.vehicle_id AS "vehicleId",
               r.customer_id AS "customerId",
               CONCAT(u.first_name, ' ', u.last_name) AS "customerName",
               CONCAT(b.name, ' ', m.name) AS "vehicleName",
               v.license_plate AS "licensePlate",
               l.status, l.started_at AS "startedAt",
               l.expected_return_at AS "expectedReturnAt",
               l.returned_at AS "returnedAt",
               i.mileage_km AS "pickupMileageKm",
               i.fuel_level_pct AS "pickupFuelLevelPct",
               i.overall_condition AS "pickupCondition",
               l.notes
        FROM rentals l
        JOIN reservations r ON r.id = l.reservation_id
        JOIN users u ON u.id = r.customer_id
        JOIN vehicles v ON v.id = r.vehicle_id
        JOIN vehicle_models m ON m.id = v.model_id
        JOIN brands b ON b.id = m.brand_id
        LEFT JOIN inspections i ON i.rental_id = l.id AND i.type = 'handover'
        WHERE l.id = $1
      `, [rentalId]);
      return {rental: rentals[0]};
    });
    if ('invalidCode' in outcome) {
      throw new ConflictException('Invalid check-in code');
    }
    await this.emailOutbox?.safelyNotifyCheckInCompleted(outcome.rental.id);
    return outcome.rental;
  }

  async uploadCheckInPhoto(
    staffId: string,
    rentalId: string,
    file: PrivateUpload,
  ): Promise<{id: string; createdAt: Date}> {
    const records: {inspectionId: string; agencyId: string; role: string}[] =
      await this.dataSource.query(`
        SELECT i.id AS "inspectionId",
               c.agency_id AS "agencyId",
               u.role
        FROM rentals l
        JOIN reservations r ON r.id = l.reservation_id
        JOIN reservation_checkin_credentials c ON c.reservation_id = r.id
        JOIN inspections i ON i.rental_id = l.id AND i.type = 'handover'
        JOIN users u ON u.id = $2::uuid AND u.status = 'active'
        WHERE l.id = $1::uuid AND l.status = 'active'
      `, [rentalId, staffId]);
    const record = records[0];
    if (!record) throw new NotFoundException('Active rental check-in not found');
    if (record.role === 'staff') {
      const assignments: {user_id: string}[] = await this.dataSource.query(`
        SELECT user_id FROM agency_staff_assignments
        WHERE user_id = $1::uuid AND agency_id = $2::uuid
      `, [staffId, record.agencyId]);
      if (!assignments.length) throw new ForbiddenException('Staff member is not assigned to this agency');
    } else if (record.role !== 'admin') {
      throw new ForbiddenException('Only authorized agency staff can upload inspection evidence');
    }

    const photoPath = await savePrivatePhoto(file);
    try {
      const inserted = await this.dataSource.transaction(async (manager) => {
        const inspections: {id: string}[] = await manager.query(`
          SELECT id FROM inspections WHERE id = $1::uuid FOR UPDATE
        `, [record.inspectionId]);
        if (!inspections.length) throw new NotFoundException('Handover inspection not found');

        const counts: {count: number}[] = await manager.query(`
          SELECT count(*)::int AS count
          FROM inspection_photos
          WHERE inspection_id = $1::uuid
        `, [record.inspectionId]);
        if ((counts[0]?.count ?? 0) >= 5) {
          throw new BadRequestException('A check-in inspection can contain at most five photos');
        }

        return manager.query<CheckInPhotoRow[]>(`
          INSERT INTO inspection_photos (inspection_id, photo_path)
          VALUES ($1::uuid, $2)
          RETURNING id, photo_path AS "photoPath"
        `, [record.inspectionId, photoPath]);
      });
      if (!inserted[0]) throw new ConflictException('Inspection photo could not be recorded');
      const timestamps: {createdAt: Date}[] = await this.dataSource.query(
        'SELECT created_at AS "createdAt" FROM inspection_photos WHERE id = $1::uuid',
        [inserted[0].id],
      );
      return {id: inserted[0].id, createdAt: timestamps[0].createdAt};
    } catch (error) {
      await deletePrivatePhoto(photoPath);
      throw error;
    }
  }

  async findCheckInPhotos(staffId: string, rentalId: string) {
    const records: {agencyId: string; role: string}[] = await this.dataSource.query(`
      SELECT c.agency_id AS "agencyId", u.role
      FROM rentals l
      JOIN reservations r ON r.id = l.reservation_id
      JOIN reservation_checkin_credentials c ON c.reservation_id = r.id
      JOIN users u ON u.id = $2::uuid AND u.status = 'active'
      WHERE l.id = $1::uuid
    `, [rentalId, staffId]);
    const record = records[0];
    if (!record) throw new NotFoundException('Rental not found');
    if (record.role === 'staff') {
      const assignments: {user_id: string}[] = await this.dataSource.query(`
        SELECT user_id FROM agency_staff_assignments
        WHERE user_id = $1::uuid AND agency_id = $2::uuid
      `, [staffId, record.agencyId]);
      if (!assignments.length) throw new ForbiddenException('Staff member is not assigned to this agency');
    } else if (record.role !== 'admin') {
      throw new ForbiddenException('Only authorized agency staff can view inspection evidence');
    }
    return this.dataSource.query(`
      SELECT p.id, p.created_at AS "createdAt"
      FROM inspection_photos p
      JOIN inspections i ON i.id = p.inspection_id
      JOIN rentals l ON l.id = i.rental_id
      WHERE l.id = $1::uuid
      ORDER BY p.created_at, p.id
    `, [rentalId]);
  }

  async checkInPhoto(staffId: string, photoId: string) {
    const records: {photoPath: string; agencyId: string; role: string}[] =
      await this.dataSource.query(`
        SELECT p.photo_path AS "photoPath",
               c.agency_id AS "agencyId",
               u.role
        FROM inspection_photos p
        JOIN inspections i ON i.id = p.inspection_id AND i.type = 'handover'
        JOIN rentals l ON l.id = i.rental_id
        JOIN reservations r ON r.id = l.reservation_id
        JOIN reservation_checkin_credentials c ON c.reservation_id = r.id
        JOIN users u ON u.id = $2::uuid AND u.status = 'active'
        WHERE p.id = $1::uuid
      `, [photoId, staffId]);
    const record = records[0];
    if (!record) throw new NotFoundException('Inspection photo not found');
    if (record.role === 'staff') {
      const assignments: {user_id: string}[] = await this.dataSource.query(`
        SELECT user_id FROM agency_staff_assignments
        WHERE user_id = $1::uuid AND agency_id = $2::uuid
      `, [staffId, record.agencyId]);
      if (!assignments.length) throw new ForbiddenException('Staff member is not assigned to this agency');
    } else if (record.role !== 'admin') {
      throw new ForbiddenException('Only authorized agency staff can view inspection evidence');
    }
    return readPrivatePhoto(record.photoPath);
  }
}
