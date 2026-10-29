
import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';

import {
    InjectRepository,
} from '@nestjs/typeorm';

import {
    DataSource,
    EntityManager,
    IsNull,
    QueryFailedError,
    Repository,
} from 'typeorm';

// Entité et statuts des réservations.
import {
    Reservation,
    ReservationStatus,
} from './entities/reservation.entity.js';

// Profil et permis de conduire du client.
import {
    CustomerProfile,
} from '../customer-profiles/entities/customer-profile.entity.js';

// Entité et statut des voitures.
import {
    Vehicle,
    VehicleStatus,
} from '../vehicles/entities/vehicle.entity.js';

import {
    UserRole,
} from '../users/entities/user.entity.js';

// DTOs de gestion des blocs de maintenance.
import {
    CreateVehicleBlockDto,
    UpdateVehicleBlockDto,
} from './dto/vehicle-block.dto.js';

// DTO de modification d'une réservation.
import type {
    UpdateReservationDto,
} from './dto/update-reservation.dto.js';

// Devis autoritaire (prix recalculés côté serveur).
import {
    PremiumService,
} from '../premium/premium.service.js';

// Service canonique de disponibilité (lieux, horaires, conflits).
import {
    AvailabilityService,
} from '../availability/availability.service.js';
import { StripePaymentService } from '../finance/stripe-payment.service.js';
import { zonedParts } from '../zones/zones.queries.js';
import {checkInCodeHash, newCheckInCode} from '../rentals/check-in-code.js';
import {noShowDeadlineExpression} from './no-show-deadline.js';

@Injectable()
export class ReservationsAdminService {
    constructor(
        // Accès à la table reservations.
        @InjectRepository(Reservation)
        private readonly reservationsRepository:
            Repository<Reservation>,

        // Connexion PostgreSQL pour les transactions.
        private readonly dataSource: DataSource,

        // Devis canonique : jamais de montant fourni par le navigateur.
        private readonly premium: PremiumService,

        // Évaluation canonique de la disponibilité.
        private readonly availability: AvailabilityService,

        @Optional()
        private readonly stripePaymentService?: StripePaymentService,
    ) { }

    // ==========================================
    // 1. CONSULTER LES RÉSERVATIONS EN ATTENTE
    // ==========================================

    async findPendingReservations():
        Promise<Reservation[]> {

        // Récupérer uniquement les réservations
        // dont le statut est pending, en excluant
        // celles déjà archivées par l'administration.
        const rows=await this.reservationsRepository.find({
            where: {
                status: ReservationStatus.PENDING,
                archivedAt: IsNull(),
            },

            // Afficher les plus anciennes en premier.
            order: {
                createdAt: 'ASC',
            },
        });
        return this.withLocationDetails(rows);
    }

    // Afficher tous les statuts pour une administration complète (avec isolation stricte pour le personnel d'agence).
    async findAllReservations(user?: { id: string; role?: string }): Promise<Reservation[]> {
        if (user?.role === UserRole.STAFF) {
            const rows = await this.reservationsRepository
                .createQueryBuilder('r')
                .leftJoin('reservation_preferences', 'p', 'p.reservation_id = r.id')
                .leftJoin('reservation_checkin_credentials', 'c', 'c.reservation_id = r.id')
                .leftJoin('vehicles', 'v', 'v.id = r.vehicle_id')
                .where(`(
                    p.pickup_location_id IN (SELECT agency_id FROM agency_staff_assignments WHERE user_id = :userId)
                    OR c.agency_id IN (SELECT agency_id FROM agency_staff_assignments WHERE user_id = :userId)
                    OR v.home_location_id IN (SELECT agency_id FROM agency_staff_assignments WHERE user_id = :userId)
                )`, { userId: user.id })
                .orderBy('r.createdAt', 'DESC')
                .getMany();
            return this.withLocationDetails(rows);
        }
        const rows = await this.reservationsRepository.find({
            order: { createdAt: 'DESC' },
        });
        return this.withLocationDetails(rows);
    }

    // Enrichissement de lecture : libellés figés, sans altérer le schéma Reservation.
    private async withLocationDetails(rows:Reservation[]):Promise<Reservation[]> {
        if(!rows.length)return rows;
        const details:{
            reservationId:string;
            pickupLocation:string|null;
            dropoffLocation:string|null;
            customerName:string;
            vehicleName:string;
            licensePlate:string;
        }[]=
          await this.dataSource.query(`SELECT reservation_id AS "reservationId",
            p.pickup_location_snapshot AS "pickupLocation",
            p.dropoff_location_snapshot AS "dropoffLocation",
            concat_ws(' ',u.first_name,u.last_name) AS "customerName",
            concat_ws(' ',b.name,m.name) AS "vehicleName",
            v.license_plate AS "licensePlate"
            FROM reservation_preferences p
            JOIN reservations r ON r.id=p.reservation_id
            JOIN users u ON u.id=r.customer_id
            JOIN vehicles v ON v.id=r.vehicle_id
            JOIN vehicle_models m ON m.id=v.model_id
            JOIN brands b ON b.id=m.brand_id
            WHERE p.reservation_id=ANY($1::uuid[])`,[rows.map(r=>r.id)]);
        const map=new Map(details.map(x=>[x.reservationId,x]));
        for(const r of rows)Object.assign(r,{
            pickupLocation:map.get(r.id)?.pickupLocation??null,
            dropoffLocation:map.get(r.id)?.dropoffLocation??null,
            customerName:map.get(r.id)?.customerName??null,
            vehicleName:map.get(r.id)?.vehicleName??null,
            licensePlate:map.get(r.id)?.licensePlate??null,
        });
        return rows;
    }

    // Récupérer les périodes d'indisponibilité pour le calendrier.
    async getUnavailability(month: string): Promise<unknown[]> {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            throw new BadRequestException('Invalid month. Expected YYYY-MM.');
        }
        const [year, index] = month.split('-').map(Number);
        const start = new Date(Date.UTC(year, index - 1, 1));
        const end = new Date(Date.UTC(year, index, 1));
        return this.dataSource.query(
            `SELECT u.id AS "id", u.vehicle_id AS "vehicleId", u.starts_at AS "startsAt",
                    u.ends_at AS "endsAt", u.reason, u.notes,
                    u.created_at AS "createdAt"
             FROM vehicle_unavailability u
             WHERE u.starts_at < $2::timestamptz
               AND u.ends_at > $1::timestamptz
             ORDER BY u.starts_at ASC`,
            [start.toISOString(), end.toISOString()],
        );
    }

    // ==========================================
    // 1.b BLOQUER UN VÉHICULE (MAINTENANCE/RÉPARATION)
    // ==========================================

    async createUnavailability(
        adminId: string,
        dto: CreateVehicleBlockDto,
    ): Promise<unknown> {
        const startsAt = new Date(dto.startsAt);
        const endsAt = new Date(dto.endsAt);
        if (
            Number.isNaN(startsAt.getTime()) ||
            Number.isNaN(endsAt.getTime())
        ) {
            throw new BadRequestException('Invalid maintenance period');
        }
        if (endsAt <= startsAt) {
            throw new BadRequestException('The end must be after the start');
        }

        const vehicles: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM vehicles WHERE id = $1::uuid`,
            [dto.vehicleId],
        );
        if (!vehicles[0]) {
            throw new NotFoundException('Vehicle not found');
        }

        try {
            const rows = await this.dataSource.query(
                `INSERT INTO vehicle_unavailability
                   (vehicle_id, starts_at, ends_at, reason, notes, created_by)
                 VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4::unavailability_reason, $5, $6::uuid)
                 RETURNING id, vehicle_id AS "vehicleId", starts_at AS "startsAt",
                           ends_at AS "endsAt", reason, notes`,
                [
                    dto.vehicleId,
                    startsAt.toISOString(),
                    endsAt.toISOString(),
                    dto.reason,
                    dto.notes?.trim() || null,
                    adminId,
                ],
            );
            return rows[0];
        } catch (error) {
            this.rethrowBlockConflict(error);
        }
    }

    // ==========================================
    // 1.c MODIFIER UN BLOC DE MAINTENANCE
    // ==========================================

    async updateUnavailability(
        id: string,
        dto: UpdateVehicleBlockDto,
    ): Promise<unknown> {
        const existing: {
            id: string;
            startsAt: Date;
            endsAt: Date;
        }[] = await this.dataSource.query(
            `SELECT id, starts_at AS "startsAt", ends_at AS "endsAt"
             FROM vehicle_unavailability WHERE id = $1::uuid`,
            [id],
        );
        if (!existing[0]) {
            throw new NotFoundException('Maintenance block not found');
        }

        const startsAt = dto.startsAt
            ? new Date(dto.startsAt)
            : new Date(existing[0].startsAt);
        const endsAt = dto.endsAt
            ? new Date(dto.endsAt)
            : new Date(existing[0].endsAt);
        if (
            Number.isNaN(startsAt.getTime()) ||
            Number.isNaN(endsAt.getTime())
        ) {
            throw new BadRequestException('Invalid maintenance period');
        }
        if (endsAt <= startsAt) {
            throw new BadRequestException('The end must be after the start');
        }

        try {
            // Sémantique PATCH : un champ absent est conservé ; un champ
            // fourni (texte, chaîne vide ou null) est appliqué. Le drapeau
            // booléen distingue « absent » de « volontairement vidé ».
            const notesProvided = dto.notes !== undefined;
            const notesValue =
                typeof dto.notes === 'string'
                    ? dto.notes.trim() || null
                    : null;
            const result = await this.dataSource.query(
                `UPDATE vehicle_unavailability
                 SET starts_at = $2::timestamptz,
                     ends_at = $3::timestamptz,
                     reason = COALESCE($4::unavailability_reason, reason),
                     notes = CASE WHEN $6::boolean THEN $5 ELSE notes END
                 WHERE id = $1::uuid
                 RETURNING id, vehicle_id AS "vehicleId", starts_at AS "startsAt",
                           ends_at AS "endsAt", reason, notes`,
                [
                    id,
                    startsAt.toISOString(),
                    endsAt.toISOString(),
                    dto.reason ?? null,
                    notesValue,
                    notesProvided,
                ],
            );
            // TypeORM 1.x : UPDATE ... RETURNING renvoie [lignes, nombre].
            const rows: {
                id: string;
                vehicleId: string;
                startsAt: Date;
                endsAt: Date;
                reason: string;
                notes: string | null;
            }[] = Array.isArray(result?.[0]) ? result[0] : result;
            if (!rows[0]) {
                throw new NotFoundException('Maintenance block not found');
            }
            return rows[0];
        } catch (error) {
            this.rethrowBlockConflict(error);
        }
    }

    // ==========================================
    // 1.d LIBÉRER UN BLOC DE MAINTENANCE
    // ==========================================

    // Retire le bloc : le véhicule redevient planifiable. Aucune
    // réservation n'est supprimée et aucun client n'est affecté.
    //
    // La libération est NON DESTRUCTIVE pour la traçabilité : le
    // contenu du bloc est d'abord copié dans le journal d'audit
    // `vehicle_unavailability_audit`, puis le bloc actif est supprimé,
    // le tout dans UNE SEULE transaction. La ligne est verrouillée
    // (FOR UPDATE) pour éviter toute incohérence concurrente. Si
    // l'insertion d'audit échoue, la suppression est annulée.
    async releaseUnavailability(
        id: string,
        adminId: string,
        reason?: string,
    ): Promise<{ released: number }> {
        return this.dataSource.transaction(async (manager) => {
            const rows: {
                id: string;
                vehicleId: string;
                startsAt: Date;
                endsAt: Date;
                reason: string;
                notes: string | null;
                createdBy: string | null;
                createdAt: Date | null;
            }[] = await manager.query(
                `SELECT id,
                        vehicle_id AS "vehicleId",
                        starts_at AS "startsAt",
                        ends_at AS "endsAt",
                        reason,
                        notes,
                        created_by AS "createdBy",
                        created_at AS "createdAt"
                 FROM vehicle_unavailability
                 WHERE id = $1::uuid
                 FOR UPDATE`,
                [id],
            );
            const block = rows[0];
            if (!block) {
                throw new NotFoundException(
                    'Maintenance block not found',
                );
            }

            // 1) Copier la trace AVANT toute suppression. ON CONFLICT
            //    neutralise tout doublon (libération répétée / rejeu)
            //    sans jamais écraser l'historique existant.
            await manager.query(
                `INSERT INTO vehicle_unavailability_audit
                   (unavailability_id, vehicle_id, starts_at, ends_at,
                    reason, notes, created_by, created_at,
                    released_by, release_reason)
                 VALUES ($1::uuid, $2::uuid, $3::timestamptz,
                         $4::timestamptz, $5::unavailability_reason,
                         $6, $7::uuid, $8::timestamptz, $9::uuid, $10)
                 ON CONFLICT (unavailability_id) DO NOTHING`,
                [
                    block.id,
                    block.vehicleId,
                    block.startsAt,
                    block.endsAt,
                    block.reason,
                    block.notes,
                    block.createdBy,
                    block.createdAt,
                    adminId,
                    reason?.trim() || null,
                ],
            );

            // 2) Retirer le bloc actif : le véhicule redevient
            //    planifiable dès la validation de la transaction.
            const deletedResult = await manager.query(
                `DELETE FROM vehicle_unavailability
                 WHERE id = $1::uuid
                 RETURNING id`,
                [id],
            );
            // TypeORM 1.x : DELETE ... RETURNING renvoie [lignes, nombre].
            const deleted: { id: string }[] =
                Array.isArray(deletedResult?.[0])
                    ? deletedResult[0]
                    : deletedResult;
            if (!deleted[0]) {
                // Course concurrente : le bloc a déjà été libéré.
                throw new NotFoundException(
                    'Maintenance block not found',
                );
            }
            return { released: 1 };
        });
    }

    // ==========================================
    // 1.e HISTORIQUE DES BLOCS LIBÉRÉS (AUDIT)
    // ==========================================

    // Liste des blocs de maintenance libérés, lue dans le journal
    // d'audit immuable. Filtrage facultatif par mois (chevauchement).
    // Réservée aux administrateurs par le contrôleur.
    async getUnavailabilityHistory(
        month?: string,
    ): Promise<unknown[]> {
        let start: string | null = null;
        let end: string | null = null;

        if (month !== undefined && month !== null && month !== '') {
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
                throw new BadRequestException(
                    'Invalid month. Expected YYYY-MM.',
                );
            }
            const [year, index] = month.split('-').map(Number);
            start = new Date(Date.UTC(year, index - 1, 1)).toISOString();
            end = new Date(Date.UTC(year, index, 1)).toISOString();
        }

        const params: string[] = start && end ? [start, end] : [];
        const overlap = start && end
            ? `WHERE a.starts_at < $2::timestamptz
                 AND a.ends_at > $1::timestamptz`
            : '';

        return this.dataSource.query(
            `SELECT a.id AS "id",
                    a.unavailability_id AS "unavailabilityId",
                    a.vehicle_id AS "vehicleId",
                    a.starts_at AS "startsAt",
                    a.ends_at AS "endsAt",
                    a.reason,
                    a.notes,
                    a.created_at AS "createdAt",
                    a.released_at AS "releasedAt",
                    a.release_reason AS "releaseReason",
                    TRIM(CONCAT(u.first_name, ' ', u.last_name))
                        AS "releasedByName"
             FROM vehicle_unavailability_audit a
             LEFT JOIN users u ON u.id = a.released_by
             ${overlap}
             ORDER BY a.released_at DESC
             LIMIT 200`,
            params,
        );
    }

    // Traduire les conflits PostgreSQL (exclusion GiST et trigger
    // réservation) en erreurs HTTP explicites, jamais en 500.
    private rethrowBlockConflict(error: unknown): never {
        if (error instanceof QueryFailedError) {
            const code = (
                error.driverError as { code?: string } | undefined
            )?.code;
            if (code === '23P01') {
                throw new ConflictException(
                    'This period overlaps an existing reservation or another maintenance block.',
                );
            }
        }
        throw error;
    }

    // ==========================================
    // 2. REFUSER UNE RÉSERVATION
    // ==========================================

    async rejectReservation(
        reservationNumber: string,
        adminId: string,
        reason: string,
    ): Promise<Reservation> {

        // Nettoyer le numéro commercial.
        const number =
            reservationNumber.trim().toUpperCase();

        // Exécuter l'opération dans une transaction.
        return this.dataSource.transaction(
            async (manager) => {

                const repository =
                    manager.getRepository(Reservation);

                // Chercher et verrouiller la réservation
                // pendant la décision administrative.
                const reservation =
                    await repository.findOne({
                        where: {
                            reservationNumber: number,
                        },

                        lock: {
                            mode: 'pessimistic_write',
                        },
                    });

                // La réservation doit exister.
                if (!reservation) {
                    throw new NotFoundException(
                        'Reservation not found',
                    );
                }

                // Seule une réservation en attente
                // peut être refusée.
                if (
                    reservation.status !==
                    ReservationStatus.PENDING
                ) {
                    throw new ConflictException(
                        'Only pending reservations can be rejected',
                    );
                }

                // Enregistrer la décision.
                reservation.status =
                    ReservationStatus.REJECTED;

                reservation.decidedBy =
                    adminId;

                reservation.decidedAt =
                    new Date();

                reservation.decisionReason =
                    reason.trim();

                // Conserver la réservation et son historique.
                return repository.save(
                    reservation,
                );
            },
        );
    }

    // ==========================================
    // 3. APPROUVER / CONFIRMER UNE RÉSERVATION
    // ==========================================
    // Obsolete direct-confirmation path removed: admin approval strictly moves
    // the reservation to AWAITING_PAYMENT with a 24-hour Stripe payment deadline.
    // Reservations can ONLY become CONFIRMED through verified Stripe payment.
    async confirmReservation(
        reservationNumber: string,
        adminId: string,
    ): Promise<Reservation> {
        return this.approveReservation(reservationNumber, adminId);
    }

    // ==========================================
    // 3.a APPROUVER UNE RÉSERVATION (AWAITING_PAYMENT + STRIPE)
    // ==========================================

    async approveReservation(
        reservationNumber: string,
        adminId: string,
    ): Promise<Reservation> {
        const number = reservationNumber.trim().toUpperCase();

        return this.dataSource.transaction(async (manager) => {
            const reservationRepository = manager.getRepository(Reservation);

            const reservation = await reservationRepository.findOne({
                where: { reservationNumber: number },
                lock: { mode: 'pessimistic_write' },
            });

            if (!reservation) {
                throw new NotFoundException('Reservation not found');
            }

            if (reservation.status !== ReservationStatus.PENDING) {
                throw new ConflictException('Only pending reservations can be approved');
            }

            if (reservation.pickupAt <= new Date()) {
                throw new ConflictException('Pickup date has already passed');
            }

            // Customer profile check
            const profileRepository = manager.getRepository(CustomerProfile);
            const profile = await profileRepository.findOne({
                where: { userId: reservation.customerId },
            });

            if (!profile) {
                throw new ConflictException('Customer profile is missing');
            }

            if (
                !profile.licenseNumber?.trim() ||
                !profile.licenseCountry?.trim() ||
                !profile.licenseIssuedOn ||
                !profile.licenseExpiresOn
            ) {
                throw new ConflictException('Customer driving license information is incomplete');
            }

            const returnDate = reservation.returnAt.toISOString().slice(0, 10);
            if (profile.licenseExpiresOn < returnDate) {
                throw new ConflictException('Driving license expires before the return date');
            }

            // Vehicle check
            const vehicle = await manager.getRepository(Vehicle).findOne({
                where: { id: reservation.vehicleId },
            });

            if (!vehicle) {
                throw new NotFoundException('Reserved vehicle not found');
            }

            if (vehicle.status !== VehicleStatus.ACTIVE) {
                throw new ConflictException('Vehicle is not active');
            }

            // 24 hours deadline
            const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);

            reservation.status = ReservationStatus.AWAITING_PAYMENT;
            reservation.decidedBy = adminId;
            reservation.decidedAt = new Date();
            reservation.decisionReason = null;
            reservation.paymentDeadlineAt = deadline;

            // Generate Stripe Checkout session
            if (this.stripePaymentService) {
                const vehicleRows: { vehicleName: string }[] = await manager.query(
                    `SELECT concat_ws(' ', b.name, m.name) AS "vehicleName"
                     FROM vehicles v
                     JOIN vehicle_models m ON m.id = v.model_id
                     JOIN brands b ON b.id = m.brand_id
                     WHERE v.id = $1::uuid`,
                    [reservation.vehicleId],
                );
                const userRows: { email: string }[] = await manager.query(
                    `SELECT email FROM users WHERE id = $1::uuid`,
                    [reservation.customerId],
                );
                const session = await this.stripePaymentService.createCheckoutSession(
                    reservation,
                    userRows[0]?.email,
                    vehicleRows[0]?.vehicleName || 'Luxury Vehicle',
                    false, // Do not persist outside transaction; approveReservation saves reservation
                );
                reservation.stripeSessionId = session.sessionId;
                reservation.paymentUrl = session.paymentUrl;
                reservation.paymentDeadlineAt = session.paymentDeadlineAt;
            } else {
                reservation.stripeSessionId = `cs_test_${reservation.reservationNumber}`;
                reservation.paymentUrl = `/reservations/${reservation.reservationNumber}`;
            }

            const agencyDeadline = noShowDeadlineExpression('$2');
            const agencies: { agencyId: string; expiresAt: Date }[] =
                await manager.query(`
                    SELECT loc.id AS "agencyId",
                           ${agencyDeadline} AS "expiresAt"
                    FROM reservations r
                    JOIN vehicles v ON v.id = r.vehicle_id
                    JOIN reservation_preferences p ON p.reservation_id = r.id
                    JOIN rental_locations loc ON loc.id = p.pickup_location_id
                    WHERE r.id = $1::uuid
                      AND p.pickup_location_id = p.dropoff_location_id
                      AND loc.enabled = true
                      AND loc.can_pickup = true
                `, [
                    reservation.id,
                    Number(process.env.NO_SHOW_GRACE_PERIOD_MINUTES ?? 120),
                ]);

            if (agencies[0]) {
                const credential = newCheckInCode();
                await manager.query(`
                    INSERT INTO reservation_checkin_credentials
                        (reservation_id, customer_id, agency_id, code_hash, expires_at)
                    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)
                    ON CONFLICT (reservation_id) DO UPDATE
                    SET customer_id = EXCLUDED.customer_id,
                        agency_id = EXCLUDED.agency_id,
                        code_hash = EXCLUDED.code_hash,
                        expires_at = EXCLUDED.expires_at,
                        created_at = now()
                `, [
                    reservation.id,
                    reservation.customerId,
                    agencies[0].agencyId,
                    checkInCodeHash(credential),
                    agencies[0].expiresAt,
                ]);
            }

            return reservationRepository.save(reservation);
        });
    }

    async cancelUnpaidReservation(
        reservationNumber: string,
        adminId?: string,
    ): Promise<Reservation> {
        const number = reservationNumber.trim().toUpperCase();

        return this.dataSource.transaction(async (manager) => {
            const reservationRepository = manager.getRepository(Reservation);
            const reservation = await reservationRepository.findOne({
                where: { reservationNumber: number },
                lock: { mode: 'pessimistic_write' },
            });

            if (!reservation) {
                throw new NotFoundException('Reservation not found');
            }

            if (reservation.status !== ReservationStatus.AWAITING_PAYMENT) {
                throw new ConflictException(
                    `Only awaiting payment reservations can be cancelled as unpaid. Current status: ${reservation.status}`,
                );
            }

            reservation.status = ReservationStatus.CANCELLED_UNPAID;
            reservation.decisionReason = 'Payment window expired (unpaid)';
            if (adminId) reservation.decidedBy = adminId;

            return reservationRepository.save(reservation);
        });
    }

    // ==========================================
    // 3.b MODIFIER UNE RÉSERVATION PLANIFIABLE
    // ==========================================

    // L'administration peut corriger une réservation en attente ou
    // confirmée tant que la location n'a pas commencé. Toutes les
    // règles de réservation restent appliquées (véhicule actif, agence
    // attribuée, horaires d'ouverture, validité du permis,
    // chevauchements et délai de remise en service) et les prix sont
    // recalculés par le devis canonique. Aucun montant client n'est
    // accepté et aucun historique financier n'est modifié.
    async updateReservation(
        reservationNumber: string,
        dto: UpdateReservationDto,
    ): Promise<{
        reservation: Reservation;
        priceDifference: string;
    }> {
        const number = reservationNumber.trim().toUpperCase();

        // --------------------------------------
        // A. CHARGER ET QUALIFIER LA RÉSERVATION
        // --------------------------------------
        const current = await this.reservationsRepository.findOne({
            where: { reservationNumber: number },
        });
        if (!current) throw new NotFoundException('Reservation not found');

        // Seules les réservations encore planifiables sont modifiables.
        if (
            current.status !== ReservationStatus.PENDING &&
            current.status !== ReservationStatus.CONFIRMED
        ) {
            throw new ConflictException(
                'Only pending or confirmed reservations can be modified',
            );
        }
        if (current.pickupAt <= new Date()) {
            throw new ConflictException(
                'A reservation whose rental has started cannot be modified',
            );
        }

        // Une réservation déjà convertie en contrat de location relève du
        // workflow location/prolongation : jamais de modification ici, afin
        // de ne jamais altérer un historique financier engagé.
        const rentals: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM rentals WHERE reservation_id = $1::uuid LIMIT 1`,
            [current.id],
        );
        if (rentals[0]) {
            throw new ConflictException(
                'This reservation already has a rental contract and must be handled from the rental workflow',
            );
        }

        // Options déjà souscrites : conservées telles quelles.
        const extraRows: { extraId: string }[] = await this.dataSource.query(
            `SELECT extra_id AS "extraId" FROM reservation_extras WHERE reservation_id = $1::uuid`,
            [current.id],
        );

        // --------------------------------------
        // B. FUSIONNER ET VALIDER LES NOUVELLES VALEURS
        // --------------------------------------
        const vehicleId = dto.vehicleId ?? current.vehicleId;
        const pickupAt = dto.pickupAt
            ? new Date(dto.pickupAt)
            : new Date(current.pickupAt);
        const returnAt = dto.returnAt
            ? new Date(dto.returnAt)
            : new Date(current.returnAt);
        if (
            Number.isNaN(pickupAt.getTime()) ||
            Number.isNaN(returnAt.getTime())
        ) {
            throw new BadRequestException('Invalid new rental period');
        }
        if (returnAt.getTime() <= pickupAt.getTime()) {
            throw new BadRequestException(
                'The return must be after the pickup',
            );
        }
        if (pickupAt.getTime() <= Date.now()) {
            throw new BadRequestException(
                'The pickup must remain in the future',
            );
        }

        // Le permis doit rester valide pendant toute la nouvelle période.
        const profiles: { licenseExpiresOn: string | null }[] =
            await this.dataSource.query(
                `SELECT license_expires_on AS "licenseExpiresOn"
                 FROM customer_profiles WHERE user_id = $1::uuid`,
                [current.customerId],
            );
        const licenceExpiry = profiles[0]?.licenseExpiresOn ?? null;
        if (
            licenceExpiry &&
            licenceExpiry < returnAt.toISOString().slice(0, 10)
        ) {
            throw new ConflictException(
                'The customer driving license expires before the new return date',
            );
        }

        // --------------------------------------
        // C. RÉÉVALUER LA DISPONIBILITÉ (hors réservation courante)
        // --------------------------------------
        const availability = await this.availability.check({
            vehicleId,
            pickupAt: pickupAt.toISOString(),
            returnAt: returnAt.toISOString(),
            excludeReservationId: current.id,
        });
        if (!availability.available) {
            throw new ConflictException(
                availability.message ??
                    'The new period is unavailable for this vehicle',
            );
        }

        // --------------------------------------
        // D. RECALCULER LE DEVIS AUTORITAIRE
        // --------------------------------------
        const quote = await this.premium.quote({
            vehicleId,
            pickupAt: pickupAt.toISOString(),
            returnAt: returnAt.toISOString(),
            extraIds: extraRows.map((row) => row.extraId),
            promotionCode: current.promotionCode ?? undefined,
        });

        const priceDifference = (
            Number(quote.totalAmount) - Number(current.totalAmount)
        ).toFixed(2);

        // --------------------------------------
        // E. APPLIQUER DANS UNE TRANSACTION VERROUILLÉE
        // --------------------------------------
        try {
            const reservation = await this.dataSource.transaction(
                async (manager) => {
                    const repository = manager.getRepository(Reservation);

                    // Verrou : empêche deux modifications simultanées.
                    const locked = await repository.findOne({
                        where: { reservationNumber: number },
                        lock: { mode: 'pessimistic_write' },
                    });
                    if (!locked) {
                        throw new NotFoundException('Reservation not found');
                    }
                    if (
                        locked.status !== ReservationStatus.PENDING &&
                        locked.status !== ReservationStatus.CONFIRMED
                    ) {
                        throw new ConflictException(
                            'Only pending or confirmed reservations can be modified',
                        );
                    }
                    if (locked.pickupAt <= new Date()) {
                        throw new ConflictException(
                            'A reservation whose rental has started cannot be modified',
                        );
                    }

                    const financialEntries: { id: string }[] =
                        await manager.query(
                            `SELECT id FROM payments
                             WHERE reservation_id = $1::uuid
                             LIMIT 1`,
                            [locked.id],
                        );
                    if (
                        financialEntries.length > 0 &&
                        (
                            Number(quote.totalAmount) !==
                                Number(locked.totalAmount) ||
                            Number(quote.depositAmount) !==
                                Number(locked.depositAmount)
                        )
                    ) {
                        throw new ConflictException(
                            'The agreed price and security deposit cannot change after a financial record exists',
                        );
                    }

                    const vehicles: {
                        daily_price: string;
                        security_deposit: string;
                    }[] = await manager.query(
                        `SELECT daily_price, security_deposit FROM vehicles
                         WHERE id = $1::uuid AND status = 'active'`,
                        [vehicleId],
                    );
                    if (!vehicles[0]) {
                        throw new ConflictException(
                            'Selected vehicle is not active',
                        );
                    }

                    // Valeurs figées recalculées, jamais fournies client.
                    locked.vehicleId = vehicleId;
                    locked.pickupAt = pickupAt;
                    locked.returnAt = returnAt;
                    locked.rentalDays = quote.rentalDays;
                    locked.dailyPrice = quote.dailyPrice;
                    locked.depositAmount = quote.depositAmount;
                    locked.totalAmount = quote.totalAmount;
                    locked.extrasAmount = quote.extrasAmount;
                    locked.deliveryAmount = quote.deliveryAmount;
                    locked.discountAmount = quote.discountAmount;
                    locked.promotionCode = quote.promotionCode;
                    await repository.save(locked);

                    if (
                        !quote.pickupLocationId ||
                        quote.dropoffLocationId !== quote.pickupLocationId
                    ) {
                        throw new ConflictException(
                            'The selected vehicle must use its assigned agency for both handovers',
                        );
                    }

                    // Update agency references without erasing legacy preference history.
                    await manager.query(
                        `INSERT INTO reservation_preferences
                           (reservation_id, pickup_method, delivery_address,
                            pickup_location_id, dropoff_location_id,
                            pickup_location_snapshot, dropoff_location_snapshot,
                            pickup_address, dropoff_address)
                         VALUES ($1::uuid, 'branch', NULL, $2::uuid, $3::uuid,
                                 $4, $5, NULL, NULL)
                         ON CONFLICT (reservation_id) DO UPDATE SET
                           pickup_location_id = EXCLUDED.pickup_location_id,
                           dropoff_location_id = EXCLUDED.dropoff_location_id,
                           pickup_location_snapshot = EXCLUDED.pickup_location_snapshot,
                           dropoff_location_snapshot = EXCLUDED.dropoff_location_snapshot`,
                        [
                            locked.id,
                            quote.pickupLocationId,
                            quote.dropoffLocationId,
                            quote.pickupLocationName,
                            quote.dropoffLocationName,
                        ],
                    );
                    await this.updateAgencyHandoverPoints(
                        manager,
                        locked.id,
                        quote.pickupLocationId,
                        pickupAt,
                        returnAt,
                    );
                    if (locked.status === ReservationStatus.CONFIRMED) {
                        const updatedDeadline = noShowDeadlineExpression('$3');
                        await manager.query(
                            `UPDATE reservation_checkin_credentials c
                             SET agency_id = $2::uuid,
                                 expires_at = ${updatedDeadline}
                             FROM reservations r
                             LEFT JOIN rental_locations loc ON loc.id = $2::uuid
                             WHERE c.reservation_id = r.id
                               AND r.id = $1::uuid
                               AND c.consumed_at IS NULL
                               AND c.revoked_at IS NULL`,
                            [
                                locked.id,
                                quote.pickupLocationId,
                                Number(process.env.NO_SHOW_GRACE_PERIOD_MINUTES ?? 120),
                            ],
                        );
                    }

                    // Rafraîchir les montants d'options sur la nouvelle durée.
                    await manager.query(
                        `DELETE FROM reservation_extras WHERE reservation_id = $1::uuid`,
                        [locked.id],
                    );
                    for (const extra of quote.extras) {
                        await manager.query(
                            `INSERT INTO reservation_extras
                               (reservation_id,extra_id,name_snapshot,amount_snapshot,pricing_snapshot,unit_price_snapshot)
                             VALUES($1,$2,$3,$4,$5,$6)`,
                            [
                                locked.id,
                                extra.id,
                                extra.name,
                                extra.total,
                                extra.pricing,
                                extra.unitPrice,
                            ],
                        );
                    }

                    const updated = await repository.findOne({
                        where: { id: locked.id },
                    });
                    if (!updated) {
                        throw new NotFoundException('Reservation not found');
                    }
                    return updated;
                },
            );

            return { reservation, priceDifference };
        } catch (error) {
            this.rethrowBlockConflict(error);
        }
    }

    // ==========================================
    // 3.c PRÉVISUALISER UNE MODIFICATION
    // ==========================================

    // Mêmes règles serveur que la modification réelle, mais sans
    // aucune écriture : le front affiche la disponibilité et l'écart
    // de prix avant que l'administrateur confirme.
    async previewReservationEdit(
        reservationNumber: string,
        dto: UpdateReservationDto,
    ): Promise<{
        available: boolean;
        message: string | null;
        currentTotal: string;
        newTotal: string;
        priceDifference: string;
        rentalDays: number;
        dailyPrice: string;
        depositAmount: string;
        pickupLocationName: string | null;
        dropoffLocationName: string | null;
    }> {
        const number = reservationNumber.trim().toUpperCase();
        const current = await this.reservationsRepository.findOne({
            where: { reservationNumber: number },
        });
        if (!current) throw new NotFoundException('Reservation not found');
        if (
            current.status !== ReservationStatus.PENDING &&
            current.status !== ReservationStatus.CONFIRMED
        ) {
            throw new ConflictException(
                'Only pending or confirmed reservations can be modified',
            );
        }
        if (current.pickupAt <= new Date()) {
            throw new ConflictException(
                'A reservation whose rental has started cannot be modified',
            );
        }
        const rentals: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM rentals WHERE reservation_id = $1::uuid LIMIT 1`,
            [current.id],
        );
        if (rentals[0]) {
            throw new ConflictException(
                'This reservation already has a rental contract and must be handled from the rental workflow',
            );
        }

        const extraRows: { extraId: string }[] = await this.dataSource.query(
            `SELECT extra_id AS "extraId" FROM reservation_extras WHERE reservation_id = $1::uuid`,
            [current.id],
        );

        const vehicleId = dto.vehicleId ?? current.vehicleId;
        const pickupAt = dto.pickupAt
            ? new Date(dto.pickupAt)
            : new Date(current.pickupAt);
        const returnAt = dto.returnAt
            ? new Date(dto.returnAt)
            : new Date(current.returnAt);
        if (
            Number.isNaN(pickupAt.getTime()) ||
            Number.isNaN(returnAt.getTime())
        ) {
            throw new BadRequestException('Invalid new rental period');
        }
        if (returnAt.getTime() <= pickupAt.getTime()) {
            throw new BadRequestException('The return must be after the pickup');
        }
        if (pickupAt.getTime() <= Date.now()) {
            throw new BadRequestException('The pickup must remain in the future');
        }

        const availability = await this.availability.check({
            vehicleId,
            pickupAt: pickupAt.toISOString(),
            returnAt: returnAt.toISOString(),
            excludeReservationId: current.id,
        });

        // Le devis reste calculé même si la période est indisponible,
        // afin d'afficher un écart de prix informatif.
        const quote = await this.premium.quote({
            vehicleId,
            pickupAt: pickupAt.toISOString(),
            returnAt: returnAt.toISOString(),
            extraIds: extraRows.map((row) => row.extraId),
            promotionCode: current.promotionCode ?? undefined,
        });

        return {
            available: availability.available,
            message: availability.message,
            currentTotal: current.totalAmount,
            newTotal: quote.totalAmount,
            priceDifference: (
                Number(quote.totalAmount) - Number(current.totalAmount)
            ).toFixed(2),
            rentalDays: quote.rentalDays,
            dailyPrice: quote.dailyPrice,
            depositAmount: quote.depositAmount,
            pickupLocationName: quote.pickupLocationName,
            dropoffLocationName: quote.dropoffLocationName,
        };
    }

    private async updateAgencyHandoverPoints(
        manager: EntityManager,
        reservationId: string,
        agencyId: string,
        pickupAt: Date,
        returnAt: Date,
    ): Promise<void> {
        const agencies: { name: string; city: string; timezone: string }[] =
            await manager.query(
                `SELECT name, city, timezone FROM rental_locations
                 WHERE id = $1::uuid AND enabled = true AND category = 'showroom'
                   AND can_pickup = true AND can_dropoff = true`,
                [agencyId],
            );
        const agency = agencies[0];
        if (!agency) {
            throw new ConflictException('The selected vehicle has no active assigned agency');
        }

        const currentPoints: { direction: string; frozen: boolean }[] =
            await manager.query(
                `SELECT direction, frozen FROM reservation_service_points
                 WHERE reservation_id = $1::uuid FOR UPDATE`,
                [reservationId],
            );
        if (currentPoints.some((point) => point.frozen)) {
            throw new ConflictException(
                'Frozen agency handover records cannot be changed',
            );
        }

        await manager.query(
            `INSERT INTO reservation_service_point_revisions
               (reservation_id, direction, revision, snapshot, reason)
             SELECT point.reservation_id,
                    point.direction,
                    COALESCE((
                      SELECT MAX(revision.revision)
                      FROM reservation_service_point_revisions revision
                      WHERE revision.reservation_id = point.reservation_id
                        AND revision.direction = point.direction
                    ), 0) + 1,
                    to_jsonb(point),
                    'Administrative agency-only reservation edit'
             FROM reservation_service_points point
             WHERE point.reservation_id = $1::uuid`,
            [reservationId],
        );

        const timezone = agency.timezone || 'Europe/Paris';
        const canonical = `${agency.name} \u2014 ${agency.city}`;
        for (const { direction, scheduledAt } of [
            { direction: 'pickup', scheduledAt: pickupAt },
            { direction: 'dropoff', scheduledAt: returnAt },
        ] as const) {
            const parts = zonedParts(scheduledAt, timezone);
            const localTime = `${String(Math.floor(parts.minutes / 60)).padStart(2, '0')}:${String(parts.minutes % 60).padStart(2, '0')}`;
            await manager.query(
                `INSERT INTO reservation_service_points
                   (reservation_id, direction, method, location_id, address,
                    scheduled_at, local_date, local_time, timezone, canonical)
                 VALUES ($1, $2, 'APPROVED_POINT', $3::uuid, NULL, $4, $5, $6, $7, $8)
                 ON CONFLICT (reservation_id, direction) DO UPDATE SET
                   method = 'APPROVED_POINT',
                   location_id = EXCLUDED.location_id,
                   address = NULL,
                   scheduled_at = EXCLUDED.scheduled_at,
                   local_date = EXCLUDED.local_date,
                   local_time = EXCLUDED.local_time,
                   timezone = EXCLUDED.timezone,
                   meeting_instructions = NULL,
                   entry_notes = NULL,
                   canonical = EXCLUDED.canonical`,
                [
                    reservationId,
                    direction,
                    agencyId,
                    scheduledAt.toISOString(),
                    parts.date,
                    localTime,
                    timezone,
                    canonical,
                ],
            );
        }
    }

    // ==========================================
    // 4. ARCHIVER UNE RÉSERVATION
    // ==========================================

    // L'archive est purement organisationnelle : elle retire la
    // réservation de la liste de travail sans changer son statut
    // ni la supprimer. L'opération est réversible.
    async archiveReservation(
        reservationNumber: string,
        adminId: string,
    ): Promise<Reservation> {
        return this.setArchived(
            reservationNumber,
            new Date(),
            adminId,
        );
    }

    // ==========================================
    // 5. RESTAURER UNE RÉSERVATION ARCHIVÉE
    // ==========================================

    async restoreReservation(
        reservationNumber: string,
    ): Promise<Reservation> {
        return this.setArchived(
            reservationNumber,
            null,
            null,
        );
    }

    // Bascule commune : archive (date + administrateur) ou
    // restauration (NULL). Opération idempotente et atomique.
    private async setArchived(
        reservationNumber: string,
        archivedAt: Date | null,
        adminId: string | null,
    ): Promise<Reservation> {
        const number =
            reservationNumber.trim().toUpperCase();

        return this.dataSource.transaction(
            async (manager) => {
                const repository =
                    manager.getRepository(Reservation);

                // Verrouiller la ligne le temps de la bascule.
                const reservation =
                    await repository.findOne({
                        where: {
                            reservationNumber: number,
                        },

                        lock: {
                            mode: 'pessimistic_write',
                        },
                    });

                if (!reservation) {
                    throw new NotFoundException(
                        'Reservation not found',
                    );
                }

                // Idempotence : déjà dans l'état demandé,
                // on renvoie la réservation inchangée.
                const alreadyArchived =
                    Boolean(reservation.archivedAt);

                if (archivedAt && alreadyArchived) {
                    return reservation;
                }

                if (!archivedAt && !alreadyArchived) {
                    return reservation;
                }

                // Seules les réservations confirmées ou rejetées
                // peuvent être archivées. Les réservations encore
                // en attente, annulées, expirées ou converties
                // restent visibles dans la liste de travail.
                if (
                    archivedAt &&
                    reservation.status !==
                        ReservationStatus.CONFIRMED &&
                    reservation.status !==
                        ReservationStatus.REJECTED
                ) {
                    throw new BadRequestException(
                        'Only confirmed or rejected reservations can be archived',
                    );
                }

                // --------------------------------------
                // RÈGLE MÉTIER — PAS D'ARCHIVAGE ANTICIPÉ
                // --------------------------------------
                //
                // Une réservation confirmée continue de bloquer la
                // disponibilité du véhicule jusqu'à sa date de retour.
                // L'archiver avant l'échéance la retirerait de la liste
                // de travail alors qu'elle est encore opérationnelle :
                // l'opération est donc refusée côté serveur (jamais
                // seulement dans l'interface React).
                if (
                    archivedAt &&
                    reservation.status === ReservationStatus.CONFIRMED
                ) {
                    // 1) Le retour planifié doit être passé.
                    if (reservation.returnAt > new Date()) {
                        throw new ConflictException(
                            'A confirmed reservation cannot be archived before its scheduled return date.',
                        );
                    }

                    // 2) Aucun contrat de location ne doit être encore
                    //    actif : tant que le véhicule est réellement en
                    //    cours de location, l'archivage reste interdit.
                    const activeRentals: { id: string }[] =
                        await manager.query(
                            `SELECT id FROM rentals
                             WHERE reservation_id = $1::uuid
                               AND status = 'active'
                             LIMIT 1`,
                            [reservation.id],
                        );
                    if (activeRentals[0]) {
                        throw new ConflictException(
                            'This reservation still has an active rental and cannot be archived.',
                        );
                    }
                }

                reservation.archivedAt = archivedAt;
                reservation.archivedBy = archivedAt
                    ? adminId
                    : null;

                return repository.save(reservation);
            },
        );
    }

    // ==========================================
    // 6. SUPPRIMER DÉFINITIVEMENT UNE RÉSERVATION
    // ==========================================

    // Réservé aux réservations annulées : une annulation n'a plus
    // d'utilité opérationnelle et peut être effacée. Les lignes
    // rattachées (préférences, extras, avis) sont retirées en
    // cascade par la base. En revanche, si un contrat de location
    // (rentals) référence encore la réservation, la suppression
    // est refusée afin de préserver l'historique financier.
    async deleteReservation(
        reservationNumber: string,
    ): Promise<{ deleted: true }> {
        const number =
            reservationNumber.trim().toUpperCase();

        return this.dataSource.transaction(
            async (manager) => {
                const repository =
                    manager.getRepository(Reservation);

                // Verrouiller la ligne le temps de la suppression.
                const reservation =
                    await repository.findOne({
                        where: {
                            reservationNumber: number,
                        },

                        lock: {
                            mode: 'pessimistic_write',
                        },
                    });

                if (!reservation) {
                    throw new NotFoundException(
                        'Reservation not found',
                    );
                }

                // Seules les réservations annulées peuvent
                // être supprimées définitivement.
                if (
                    reservation.status !==
                    ReservationStatus.CANCELLED
                ) {
                    throw new ConflictException(
                        'Only cancelled reservations can be deleted',
                    );
                }

                try {
                    await repository.remove(reservation);
                } catch (error) {
                    if (this.isForeignKeyViolation(error)) {
                        throw new ConflictException(
                            'This reservation is linked to a rental contract and cannot be deleted.',
                        );
                    }

                    throw error;
                }

                return { deleted: true };
            },
        );
    }

    // Détecte une violation de clé étrangère PostgreSQL
    // (code 23503) remontée par TypeORM.
    private isForeignKeyViolation(error: unknown): boolean {
        return (
            error instanceof QueryFailedError &&
            (
                error as QueryFailedError & {
                    driverError?: { code?: string };
                }
            ).driverError?.code === '23503'
        );
    }
}
