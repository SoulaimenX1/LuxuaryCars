import { PremiumService } from '../premium/premium.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {checkInCodeHash, newCheckInCode} from '../rentals/check-in-code.js';

import {
    InjectRepository,
} from '@nestjs/typeorm';

import {
    DataSource,
    EntityManager,
    QueryFailedError,
    Repository,
} from 'typeorm';

// Devis de livraison persistés (additionnel) : revalidation et
// réclamation atomique à la réservation.
import {
    assertQuoteMatchesFreshTotal,
    buildSideFingerprint,
    markQuoteAccepted,
    validateQuoteForBooking,
} from '../delivery/delivery.queries.js';

// Local contract time for agency handovers.
import { zonedParts } from '../zones/zones.queries.js';
import {noShowDeadlineExpression} from './no-show-deadline.js';

// Entité du profil client.
import {
    CustomerProfile,
} from '../customer-profiles/entities/customer-profile.entity.js';

// Entité et statuts des réservations.
import {
    Reservation,
    ReservationStatus,
} from './entities/reservation.entity.js';

// DTO de création d'une réservation.
import {
    CreateReservationDto,
} from './dto/create-reservation.dto.js';

// Informations renvoyées par PostgreSQL
// lors de la recherche d'une voiture disponible.
interface AvailableVehicleRow {
    id: string;
    daily_price: string;
    security_deposit: string;
}

@Injectable()
export class ReservationsService {
    constructor(
        // Repository de la table customer_profiles.
        @InjectRepository(CustomerProfile)
        private readonly profilesRepository:
            Repository<CustomerProfile>,

        // Repository de la table reservations.
        @InjectRepository(Reservation)
        private readonly reservationsRepository:
            Repository<Reservation>,

        // Connexion utilisée pour les transactions.
        private readonly dataSource: DataSource,
        private readonly premiumService: PremiumService,
        private readonly availability: AvailabilityService,
        @Optional() private readonly config?: ConfigService,
    ) { }

    // ==========================================
    // 1. CONVERTIR ET VÉRIFIER UNE DATE
    // ==========================================

    private parseDate(
        value: string,
        fieldName: string,
    ): Date {
        // Convertir la date en minuit UTC.
        const date = new Date(
            `${value}T00:00:00.000Z`,
        );

        // Refuser les dates qui n'existent pas.
        if (
            Number.isNaN(date.getTime()) ||
            date.toISOString().slice(0, 10) !== value
        ) {
            throw new BadRequestException(
                `${fieldName} must be a valid date`,
            );
        }

        return date;
    }

    // ==========================================
    // 2. CRÉER UNE RÉSERVATION
    // ==========================================

    async createReservation(
        userId: string,
        dto: CreateReservationDto,
    ): Promise<Reservation> {

        // ------------------------------------------
        // A. VÉRIFIER L'EMAIL VÉRIFIÉ DU CLIENT
        // ------------------------------------------
        const userRows = await this.dataSource.query(
            `SELECT id, email, email_verified_at, status FROM users WHERE id = $1`,
            [userId],
        );
        const user = userRows?.[0];
        if (!user || !user.email_verified_at) {
            throw new ForbiddenException({
                statusCode: 403,
                error: 'Forbidden',
                code: 'EMAIL_VERIFICATION_REQUIRED',
                message: 'Email verification is mandatory before creating reservations. Please verify your email or request a new verification link.',
                email: user?.email,
            });
        }

        // ------------------------------------------
        // B. VÉRIFIER LE PROFIL CLIENT
        // ------------------------------------------

        const profile =
            await this.profilesRepository.findOne({
                where: {
                    userId,
                },
            });

        if (!profile) {
            throw new BadRequestException(
                'Complete your customer profile before booking',
            );
        }

        // ------------------------------------------
        // B. RÉSOUDRE LES DATES ET HEURES
        // ------------------------------------------

        // Le nouveau parcours envoie des instants précis (date + heure).
        // L'ancien contrat n'envoyait que des dates (à minuit UTC).
        const pickupAt = dto.pickupAt
            ? new Date(dto.pickupAt)
            : dto.pickupDate
              ? this.parseDate(dto.pickupDate, 'pickupDate')
              : null;

        const returnAt = dto.returnAt
            ? new Date(dto.returnAt)
            : dto.returnDate
              ? this.parseDate(dto.returnDate, 'returnDate')
              : null;

        // Precise timestamps are mandatory: a date-only request must
        // never silently become midnight UTC and bypass operational checks.
        if (!dto.pickupAt || !pickupAt || Number.isNaN(pickupAt.getTime())) {
            throw new BadRequestException(
                'A precise pickupAt timestamp is required',
            );
        }

        if (!dto.returnAt || !returnAt || Number.isNaN(returnAt.getTime())) {
            throw new BadRequestException(
                'A precise returnAt timestamp is required',
            );
        }

        // Le départ doit être dans le futur.
        if (pickupAt.getTime() <= Date.now()) {
            throw new BadRequestException(
                'Pickup date must be in the future',
            );
        }

        // Le retour doit être après le départ.
        if (returnAt.getTime() <= pickupAt.getTime()) {
            throw new BadRequestException(
                'Return date must be after pickup date',
            );
        }

        // Le permis doit être valide jusqu'à la date de retour.
        const returnDate = returnAt.toISOString().slice(0, 10);
        if (profile.licenseExpiresOn < returnDate) {
            throw new BadRequestException(
                'Driving license expires before the return date',
            );
        }

        if (
            dto.pickupServiceMode === 'DOOR_TO_DOOR' ||
            dto.dropoffServiceMode === 'DOOR_TO_DOOR' ||
            dto.pickupMethod && dto.pickupMethod !== 'branch' ||
            dto.deliveryAddress?.trim() ||
            dto.pickupAddress?.trim() ||
            dto.dropoffAddress?.trim() ||
            dto.pickupDoor ||
            dto.dropoffDoor
        ) {
            throw new BadRequestException(
                'Pick-up and return are only available at an agency',
            );
        }

        const pickupLocationId = dto.pickupLocationId ?? undefined;
        const dropoffLocationId = dto.dropoffLocationId ?? undefined;
        const pickupServiceMode = 'APPROVED_POINT' as const;
        const dropoffServiceMode = 'APPROVED_POINT' as const;

        // L'agence est résolue à partir du véhicule, pas de la demande.
        const availability = await this.availability.check({
            vehicleId: dto.vehicleId,
            pickupLocationId,
            dropoffLocationId,
            pickupAt: pickupAt.toISOString(),
            returnAt: returnAt.toISOString(),
        });

        if (!availability.available) {
            throw new ConflictException(
                availability.message ??
                    'Selected period is unavailable for this vehicle',
            );
        }
        const assignedAgencyId = availability.details?.pickupLocationId;
        if (!assignedAgencyId) {
            throw new ConflictException('The selected vehicle has no assigned agency');
        }
        const resolvedPickupLocationId = assignedAgencyId;
        const resolvedDropoffLocationId = assignedAgencyId;

        // Un devis persisté (optionnel) doit appartenir au client,
        // être encore valide et correspondre exactement à cette
        // réservation — revalidation complète avant toute écriture.
        if (dto.quoteId) {
            await validateQuoteForBooking(this.dataSource, {
                quoteId: dto.quoteId,
                userId,
                expected: {
                    vehicleId: dto.vehicleId,
                    pickupAt,
                    returnAt,
                    pickupPoint: buildSideFingerprint({
                        mode: pickupServiceMode,
                        locationId: resolvedPickupLocationId,
                        address: null,
                    }),
                    dropoffPoint: buildSideFingerprint({
                        mode: dropoffServiceMode,
                        locationId: resolvedDropoffLocationId,
                        address: null,
                    }),
                },
            });
        }

        // ------------------------------------------
        // C. DÉMARRER UNE TRANSACTION
        // ------------------------------------------

        try {
            return await this.dataSource.transaction(
                async (manager) => {

                    // ------------------------------------
                    // D. CHERCHER UNE VOITURE DISPONIBLE
                    // ------------------------------------

                    // La fonction PostgreSQL vérifie
                    // les réservations, les maintenances
                    // et le statut du véhicule.
                    //
                    // Le verrou FOR UPDATE protège
                    // la voiture sélectionnée.
                    //
                    // SKIP LOCKED évite de sélectionner
                    // une voiture déjà verrouillée.

                    // Sélectionner exclusivement la voiture choisie.
                    // Le verrou et la fonction PostgreSQL conservent
                    // les protections contre les conflits simultanés.
                    const vehicles = await manager.query(
                        `
                        SELECT v.id, v.daily_price, v.security_deposit
                        FROM vehicles v
                        WHERE v.id = $1::uuid
                          AND v.status = 'active'
                          AND v.id IN (
                            SELECT available.id
                            FROM find_available_vehicles(
                              $2::timestamptz,
                              $3::timestamptz
                            ) AS available
                          )
                        LIMIT 1
                        FOR UPDATE OF v SKIP LOCKED
                        `,
                        [dto.vehicleId, pickupAt.toISOString(), returnAt.toISOString()],
                    ) as AvailableVehicleRow[];

                    // Refuser la demande si aucune
                    // voiture n'est disponible.
                    if (vehicles.length === 0) {
                        throw new ConflictException(
                            'Selected vehicle is unavailable for this period',
                        );
                    }

                    const vehicle = vehicles[0];

                    // ------------------------------------
                    // E. CALCULER LE PRIX TOTAL AUTORITAIRE
                    // ------------------------------------

                    // Le devis NestJS calcule les extras
                    // et les éventuelles remises. Tous les montants sont EUR.
                    // Il fixe aussi la durée facturée (jour entamé = jour dû).
                    const quote = await this.premiumService.quote({
                        vehicleId: dto.vehicleId,
                        pickupAt: pickupAt.toISOString(),
                        returnAt: returnAt.toISOString(),
                        extraIds: dto.extraIds,
                        promotionCode: dto.promotionCode,
                        pickupLocationId: resolvedPickupLocationId,
                        dropoffLocationId: resolvedDropoffLocationId,
                    }, manager, true);
                    const totalAmount = quote.totalAmount;

                    // Revalider le devis persisté DANS la transaction :
                    // le prix recalculé par le serveur doit coïncider
                    // avec le total du devis accepté (sinon : nouveau
                    // devis, jamais une surprise tarifaire).
                    if (dto.quoteId) {
                        const persisted = await validateQuoteForBooking(
                            manager,
                            {
                                quoteId: dto.quoteId,
                                userId,
                                expected: {
                                    vehicleId: dto.vehicleId,
                                    pickupAt,
                                    returnAt,
                                    pickupPoint: buildSideFingerprint({
                                        mode: pickupServiceMode,
                                        locationId: resolvedPickupLocationId,
                                        address: null,
                                    }),
                                    dropoffPoint: buildSideFingerprint({
                                        mode: dropoffServiceMode,
                                        locationId: resolvedDropoffLocationId,
                                        address: null,
                                    }),
                                },
                            },
                        );
                        assertQuoteMatchesFreshTotal(
                            persisted.breakdown,
                            quote.totalAmount,
                        );
                    }

                    // La durée stockée doit correspondre exactement au devis
                    // (contrainte PostgreSQL total = jours × prix + extras …).
                    const rentalDays = quote.rentalDays;

                    // ------------------------------------
                    // F. PRÉPARER LA RÉSERVATION
                    // ------------------------------------

                    const reservationRepository =
                        manager.getRepository(Reservation);

                    const reservation =
                        reservationRepository.create({
                            // Identifiant du client connecté.
                            customerId: userId,

                            // Voiture sélectionnée.
                            vehicleId: vehicle.id,

                            // Dates de location.
                            pickupAt,
                            returnAt,

                            // Durée calculée.
                            rentalDays,

                            // Prix conservés au moment
                            // de la réservation.
                            dailyPrice:
                                vehicle.daily_price,

                            depositAmount:
                                vehicle.security_deposit,

                            totalAmount,
                            extrasAmount: quote.extrasAmount,
                            deliveryAmount: quote.deliveryAmount,
                            discountAmount: quote.discountAmount,
                            promotionCode: quote.promotionCode,

                            // Nouvelle réservation en attente.
                            status:
                                ReservationStatus.PENDING,

                            customerNotes:
                                dto.customerNotes?.trim() ?? null,

                            // Aucune décision administrative
                            // n'a encore été prise.
                            decidedBy: null,
                            decidedAt: null,
                            decisionReason: null,
                        });

                    // ------------------------------------
                    // G. ENREGISTRER LA RÉSERVATION
                    // ------------------------------------

                    const savedReservation =
                        await reservationRepository.save(
                            reservation,
                        );

                    // Relire la réservation pour obtenir
                    // son numéro généré par PostgreSQL.
                    const completeReservation =
                        await reservationRepository.findOne({
                            where: {
                                id: savedReservation.id,
                            },
                        });

                    if (!completeReservation) {
                        throw new NotFoundException(
                            'Created reservation not found',
                        );
                    }

                    // Sauvegarder les prestations et préférences de la réservation.
                    for (const extra of quote.extras) {
                        await manager.query(`INSERT INTO reservation_extras
                          (reservation_id,extra_id,name_snapshot,amount_snapshot,pricing_snapshot,unit_price_snapshot)
                          VALUES($1,$2,$3,$4,$5,$6)`,
                          [savedReservation.id,extra.id,extra.name,extra.total,extra.pricing,extra.unitPrice]);
                    }
                    await manager.query(`INSERT INTO reservation_preferences
                      (reservation_id,pickup_method,delivery_address,pickup_location_id,dropoff_location_id,
                      pickup_location_snapshot,dropoff_location_snapshot,pickup_address,dropoff_address)
                      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                      [savedReservation.id,'branch',null,
                       resolvedPickupLocationId,resolvedDropoffLocationId,
                       quote.pickupLocationName,quote.dropoffLocationName,null,null]);
                    // Preserve the assigned agency and local handover times.
                    await this.insertServicePoints(
                        manager,
                        savedReservation.id,
                        {
                            agencyId: resolvedPickupLocationId,
                            pickupAt,
                            returnAt,
                        },
                    );

                    // Réclamer atomiquement le devis persisté (toujours
                    // dans la transaction : deux réservations ne peuvent
                    // pas accepter le même devis).
                    if (dto.quoteId) {
                        await markQuoteAccepted(
                            manager,
                            dto.quoteId,
                            savedReservation.id,
                        );
                    }

                    if (quote.promotionCode) {
                        await manager.query(`UPDATE premium_promotions SET uses=uses+1 WHERE code=$1`,
                          [quote.promotionCode]);
                    }
                    // Mettre en file un email, sans prétendre l'avoir envoyé.
                    await manager.query(`INSERT INTO customer_email_outbox(customer_id,subject,message)
                      VALUES($1,$2,$3)`,[userId,'Reservation request received',
                        `Reservation ${completeReservation.reservationNumber} received. Amount EUR ${quote.totalAmount}. Awaiting confirmation.`]);
                    return completeReservation;
                },
            );

        } catch (error) {

            // ----------------------------------------
            // H. GÉRER LES CONFLITS POSTGRESQL
            // ----------------------------------------

            // Le code 23P01 indique notamment
            // une violation de la contrainte
            // empêchant les doubles réservations.
            if (
                error instanceof QueryFailedError &&
                (error.driverError as { code?: string })
                    .code === '23P01'
            ) {
                throw new ConflictException(
                    'Vehicle is no longer available for these dates',
                );
            }

            throw error;
        }
    }

    // ==========================================
    // 2bis. Agency handover snapshots
    private async insertServicePoints(
        manager: EntityManager,
        reservationId: string,
        params: { agencyId: string; pickupAt: Date; returnAt: Date },
    ) {
        const agencies: { name: string; city: string; timezone: string }[] =
            await manager.query(
                `SELECT name, city, timezone FROM rental_locations WHERE id = $1::uuid`,
                [params.agencyId],
            );
        const agency = agencies[0];
        if (!agency) throw new NotFoundException('Assigned agency not found');
        const timezone = agency.timezone || 'Europe/Paris';
        const canonical = `${agency.name} \u2014 ${agency.city}`;

        for (const { direction, scheduledAt } of [
            { direction: 'pickup', scheduledAt: params.pickupAt },
            { direction: 'dropoff', scheduledAt: params.returnAt },
        ] as const) {
            const parts = zonedParts(scheduledAt, timezone);
            const localTime = `${String(Math.floor(parts.minutes / 60)).padStart(2, '0')}:${String(parts.minutes % 60).padStart(2, '0')}`;
            await manager.query(
                `INSERT INTO reservation_service_points
                   (reservation_id, direction, method, location_id, address,
                    scheduled_at, local_date, local_time, timezone,
                    meeting_instructions, entry_notes, canonical)
                 VALUES ($1, $2, 'APPROVED_POINT', $3, NULL, $4, $5, $6, $7, NULL, NULL, $8)`,
                [reservationId, direction, params.agencyId, scheduledAt.toISOString(), parts.date, localTime, timezone, canonical],
            );
        }
    }

    // 3. CONSULTER MES RÉSERVATIONS
    // ==========================================

    async findMyReservations(
        userId: string,
    ): Promise<Reservation[]> {

        // Le client ne voit que ses réservations.
        // L'identifiant provient du JWT.
        const rows=await this.reservationsRepository.find({
            where: {customerId:userId},
            order: {createdAt:'DESC'},
        });
        if(!rows.length)return rows;
        // Le pré-enregistrement (check-in) et la logistique sont stockés
        // dans reservation_preferences. On les expose au client pour que
        // l'interface masque immédiatement les actions devenues obsolètes
        // (ex. bouton check-in après un check-in déjà effectué).
        const gracePeriodMinutes = this.config?.get<number>(
            'NO_SHOW_GRACE_PERIOD_MINUTES',
            120,
        ) ?? 120;
        const deadline = noShowDeadlineExpression('$2');
        const details:{reservationId:string;pickupLocation:string|null;dropoffLocation:string|null;checkinAt:string|null;
            rentalStatus:string|null;noShowDeadlineAt:Date|null;agencyTimezone:string|null;
            rentalStartedAt:Date|null;inspectionMileage:number|null;inspectionFuel:number|null;
            inspectionCondition:string|null;inspectionNotes:string|null;
            returnSummary:unknown}[]=
          await this.reservationsRepository.manager.query(`SELECT r.id AS "reservationId",
            p.pickup_location_snapshot AS "pickupLocation",
            p.dropoff_location_snapshot AS "dropoffLocation",
            l.started_at AS "checkinAt",l.started_at AS "rentalStartedAt",
            l.status AS "rentalStatus",
            i.mileage_km AS "inspectionMileage",
            i.fuel_level_pct AS "inspectionFuel",
            i.overall_condition AS "inspectionCondition",
            i.notes AS "inspectionNotes",
            CASE WHEN vr.id IS NULL THEN NULL ELSE json_build_object(
              'reference', vr.reference,
              'status', vr.status,
              'actualReturnAt', vr.actual_return_at,
              'inspection', json_build_object(
                'mileageKm', ri.mileage_km,
                'fuelLevelPct', ri.fuel_level_pct,
                'condition', ri.exterior_condition,
                'notes', ri.inspector_notes,
                'submittedAt', ri.submitted_at
              ),
              'damages', COALESCE((
                SELECT json_agg(json_build_object(
                  'zone', d.vehicle_zone,
                  'description', d.description,
                  'severity', d.severity,
                  'preExisting', d.pre_existing
                ) ORDER BY d.created_at, d.id)
                FROM return_damages d WHERE d.return_id = vr.id
              ), '[]'::json),
              'charges', COALESCE((
                SELECT json_agg(json_build_object(
                  'type', ch.type,
                  'description', ch.description,
                  'amount', ch.amount
                ) ORDER BY ch.created_at, ch.id)
                FROM additional_charges ch WHERE ch.rental_id = l.id
              ), '[]'::json),
              'preparationStatus', prep.status
            ) END AS "returnSummary",
            CASE WHEN r.status='confirmed' THEN ${deadline} ELSE NULL END AS "noShowDeadlineAt",
            loc.timezone AS "agencyTimezone"
            FROM reservations r
            LEFT JOIN reservation_preferences p ON p.reservation_id=r.id
            LEFT JOIN rental_locations loc ON loc.id=p.pickup_location_id
            LEFT JOIN rentals l ON l.reservation_id=r.id
            LEFT JOIN inspections i ON i.rental_id=l.id AND i.type='handover'
            LEFT JOIN vehicle_returns vr ON vr.rental_id=l.id
            LEFT JOIN return_inspections ri ON ri.return_id=vr.id
            LEFT JOIN vehicle_preparations prep ON prep.return_id=vr.id
            WHERE r.id=ANY($1::uuid[])`,[rows.map(r=>r.id),gracePeriodMinutes]);
        const map=new Map(details.map(x=>[x.reservationId,x]));
        for(const r of rows)Object.assign(r,{
            pickupLocation:map.get(r.id)?.pickupLocation??null,
            dropoffLocation:map.get(r.id)?.dropoffLocation??null,
            checkinAt:map.get(r.id)?.checkinAt??null,
            rentalStatus:map.get(r.id)?.rentalStatus??null,
            noShowDeadlineAt:map.get(r.id)?.noShowDeadlineAt??null,
            agencyTimezone:map.get(r.id)?.agencyTimezone??null,
            rentalStartedAt:map.get(r.id)?.rentalStartedAt??null,
            inspectionMileage:map.get(r.id)?.inspectionMileage??null,
            inspectionFuel:map.get(r.id)?.inspectionFuel??null,
            inspectionCondition:map.get(r.id)?.inspectionCondition??null,
            inspectionNotes:map.get(r.id)?.inspectionNotes??null,
            returnSummary:map.get(r.id)?.returnSummary??null,
        });
        return rows;
    }

    async issueMyCheckInCode(
        userId: string,
        reservationNumber: string,
    ): Promise<{code: string; expiresAt: Date; agencyName: string}> {
        return this.dataSource.transaction(async (manager) => {
            const gracePeriodMinutes = this.config?.get<number>(
                'NO_SHOW_GRACE_PERIOD_MINUTES',
                120,
            ) ?? 120;
            const deadline = noShowDeadlineExpression('$3');
            const rows: {
                id: string;
                status: string;
                expiresAt: Date;
                agencyName: string;
                agencyId: string;
                credentialAgencyId: string | null;
                credentialReservationId: string | null;
                failedAttempts: number;
                firstViewedAt: Date | null;
                lastRotatedAt: Date | null;
            }[] = await manager.query(`
                SELECT r.id, r.status,
                       COALESCE(c.expires_at, ${deadline}) AS "expiresAt",
                       loc.name AS "agencyName",
                       loc.id AS "agencyId",
                       c.agency_id AS "credentialAgencyId",
                       c.reservation_id AS "credentialReservationId",
                       COALESCE(c.failed_attempts, 0) AS "failedAttempts",
                       c.first_viewed_at AS "firstViewedAt",
                       c.last_rotated_at AS "lastRotatedAt"
                FROM reservations r
                JOIN vehicles v ON v.id = r.vehicle_id
                JOIN reservation_preferences p ON p.reservation_id = r.id
                JOIN rental_locations loc ON loc.id = p.pickup_location_id
                LEFT JOIN reservation_checkin_credentials c
                  ON c.reservation_id = r.id AND c.customer_id = r.customer_id
                WHERE r.reservation_number = $1
                  AND r.customer_id = $2::uuid
                  AND p.pickup_location_id = p.dropoff_location_id
                  AND loc.enabled = true
                  AND loc.category = 'showroom'
                  AND loc.can_pickup = true
                  AND loc.can_dropoff = true
                  AND (
                    v.home_location_id = loc.id
                    OR EXISTS (
                      SELECT 1 FROM vehicle_rental_locations vrl
                      WHERE vrl.vehicle_id = v.id AND vrl.location_id = loc.id
                    )
                    OR (
                      v.home_location_id IS NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM vehicle_rental_locations vrl
                        WHERE vrl.vehicle_id = v.id
                      )
                      AND loc.code = $4
                    )
                  )
                FOR UPDATE OF r
            `, [
                reservationNumber.trim().toUpperCase(),
                userId,
                gracePeriodMinutes,
                this.config?.get<string>('DEFAULT_RENTAL_AGENCY_CODE', 'BUD-SHOWROOM') ??
                  'BUD-SHOWROOM',
            ]);
            const reservation = rows[0];
            if (!reservation) {
                throw new NotFoundException('Reservation check-in credential not found');
            }
            if (reservation.status !== 'confirmed' || reservation.expiresAt <= new Date()) {
                throw new ConflictException('The reservation check-in window has expired');
            }
            if (
                reservation.credentialReservationId &&
                reservation.credentialAgencyId !== reservation.agencyId
            ) {
                throw new ConflictException('The check-in credential is bound to a different agency');
            }
            if (reservation.failedAttempts >= 5) {
                throw new ConflictException('Check-in code is locked after too many failed attempts');
            }
            if (
                reservation.firstViewedAt &&
                reservation.lastRotatedAt &&
                Date.now() - new Date(reservation.lastRotatedAt).getTime() < 60_000
            ) {
                throw new HttpException(
                    'A new check-in code can be requested once per minute',
                    HttpStatus.TOO_MANY_REQUESTS,
                );
            }

            const code = newCheckInCode();
            if (reservation.credentialReservationId === null) {
                await manager.query(`
                    INSERT INTO reservation_checkin_credentials
                        (reservation_id, customer_id, agency_id, code_hash, expires_at,
                         first_viewed_at, last_rotated_at)
                    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, now(), now())
                    ON CONFLICT (reservation_id) DO NOTHING
                `, [
                    reservation.id,
                    userId,
                    reservation.agencyId,
                    checkInCodeHash(code),
                    reservation.expiresAt,
                ]);
            } else {
                await manager.query(`
                    UPDATE reservation_checkin_credentials
                    SET code_hash = $2,
                        first_viewed_at = COALESCE(first_viewed_at, now()),
                        last_rotated_at = now()
                    WHERE reservation_id = $1::uuid
                `, [reservation.id, checkInCodeHash(code)]);
            }
            return {
                code,
                expiresAt: reservation.expiresAt,
                agencyName: reservation.agencyName,
            };
        });
    }

    // ==========================================
    // 4. ANNULER MA RÉSERVATION
    // ==========================================

    async cancelMyReservation(
        userId: string,
        reservationNumber: string,
    ): Promise<Reservation> {

        // Nettoyer le numéro commercial.
        const number =
            reservationNumber.trim().toUpperCase();

        // Utiliser une transaction pour empêcher
        // une annulation simultanée à une autre
        // modification de cette réservation.
        return this.dataSource.transaction(
            async (manager) => {

                const reservationRepository =
                    manager.getRepository(Reservation);

                // --------------------------------------
                // A. RETROUVER LA RÉSERVATION
                // --------------------------------------

                // Chercher une réservation ayant :
                // - le numéro demandé ;
                // - l'identifiant du client connecté.
                //
                // Le verrou empêche qu'une autre
                // transaction la modifie en même temps.
                const reservation =
                    await reservationRepository.findOne({
                        where: {
                            reservationNumber: number,
                            customerId: userId,
                        },

                        lock: {
                            mode: 'pessimistic_write',
                        },
                    });

                // Ne pas révéler les réservations
                // appartenant à d'autres clients.
                if (!reservation) {
                    throw new NotFoundException(
                        'Reservation not found',
                    );
                }

                // --------------------------------------
                // B. VÉRIFIER LE STATUT
                // --------------------------------------

                // Le client peut annuler lui-même une réservation
                // encore en attente ou déjà confirmée, tant que la
                // prise en charge n'a pas commencé.
                if (
                    reservation.status !==
                        ReservationStatus.PENDING &&
                    reservation.status !==
                        ReservationStatus.CONFIRMED
                ) {
                    throw new ConflictException(
                        'Only pending or confirmed reservations can be cancelled',
                    );
                }

                // --------------------------------------
                // C. VÉRIFIER LA DATE DE DÉPART
                // --------------------------------------

                // Refuser une annulation si la date
                // de départ est déjà passée.
                if (
                    reservation.pickupAt <= new Date()
                ) {
                    throw new ConflictException(
                        'Cannot cancel after the pickup date',
                    );
                }

                // --------------------------------------
                // C.b VÉRIFIER L'HISTORIQUE FINANCIER
                // --------------------------------------

                // Les paiements, cautions et factures sont rattachés
                // à un contrat de location (rentals.reservation_id),
                // créé uniquement au démarrage réel de la location.
                // Une réservation annulable ici (pending/confirmée)
                // ne peut donc pas porter de mouvement financier.
                // Par prudence, si un contrat existe malgré tout,
                // l'annulation est refusée : les charges et paiements
                // existants ne doivent jamais être effacés, et aucun
                // remboursement n'est inventé automatiquement.
                const engagedRental: { id: string }[] =
                    await manager.query(
                        `SELECT id FROM rentals
                         WHERE reservation_id = $1::uuid
                         LIMIT 1`,
                        [reservation.id],
                    );

                if (engagedRental[0]) {
                    throw new ConflictException(
                        'This reservation has a rental contract with financial records. Contact the showroom so staff can settle it.',
                    );
                }

                // --------------------------------------
                // D. ANNULER LA RÉSERVATION
                // --------------------------------------

                // Nous ne supprimons pas la ligne.
                // Nous conservons son historique.
                reservation.status =
                    ReservationStatus.CANCELLED;

                // PostgreSQL actualise automatiquement
                // updated_at grâce au trigger existant.
                return reservationRepository.save(
                    reservation,
                );
            },
        );
    }

    async findOneByNumber(
        userId: string,
        reservationNumber: string,
        isAdmin = false,
    ): Promise<Reservation & Record<string, any>> {
        const num = reservationNumber.trim().toUpperCase();
        const reservation = await this.reservationsRepository.findOne({
            where: { reservationNumber: num },
        });

        if (!reservation) {
            throw new NotFoundException('Reservation not found');
        }

        if (!isAdmin && reservation.customerId !== userId) {
            throw new NotFoundException('Reservation not found');
        }

        const extras: any[] = await this.dataSource.query(
            `SELECT concat_ws(' ', b.name, m.name) AS "vehicleName",
                    b.name AS "brandName",
                    m.name AS "modelName",
                    v.license_plate AS "licensePlate",
                    img.storage_path AS "imageUrl",
                    p.pickup_location_snapshot AS "pickupLocation",
                    p.dropoff_location_snapshot AS "dropoffLocation"
             FROM reservations r
             JOIN vehicles v ON v.id = r.vehicle_id
             JOIN vehicle_models m ON m.id = v.model_id
             JOIN brands b ON b.id = m.brand_id
             LEFT JOIN LATERAL (
                 SELECT storage_path FROM vehicle_images
                 WHERE vehicle_id = v.id AND is_primary = true
                 LIMIT 1
             ) img ON true
             LEFT JOIN reservation_preferences p ON p.reservation_id = r.id
             WHERE r.id = $1::uuid`,
            [reservation.id],
        );

        return Object.assign(reservation, extras[0] || {});
    }
}
