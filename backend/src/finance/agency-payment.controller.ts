import {
    BadRequestException,
    Body,
    Controller,
    Get,
    NotFoundException,
    Param,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../users/entities/user.entity.js';
import { Reservation, ReservationStatus } from '../reservations/entities/reservation.entity.js';
import { InboxService } from '../notifications/inbox.service.js';

interface AuthorizedRequest {
    user: { id: string; role?: string; email?: string };
}

export interface RequestAgencyPaymentDto {
    agencyName?: string;
    notes?: string;
}

export interface ApproveAgencyPaymentDto {
    method?: 'cash' | 'card' | 'bank_transfer';
    notes?: string;
    recordedReference?: string;
}

export interface RejectAgencyPaymentDto {
    reason: string;
}

@Controller('finance')
export class AgencyPaymentController {
    constructor(
        private readonly dataSource: DataSource,
        private readonly inboxService: InboxService,
    ) {}

    /**
     * 1. Customer: Request Manual Payment at Agency
     * Endpoint: POST /finance/agency-payment/request/:reservationNumber
     */
    @Post('agency-payment/request/:reservationNumber')
    @UseGuards(JwtAuthGuard)
    async requestAgencyPayment(
        @Param('reservationNumber') reservationNumber: string,
        @Body() body: RequestAgencyPaymentDto,
        @Req() req: AuthorizedRequest,
    ) {
        const num = reservationNumber.trim().toUpperCase();

        return this.dataSource.transaction(async (manager) => {
            const rows: any[] = await manager.query(
                `SELECT r.*, u.email as "customerEmail",
                        CONCAT(b.name, ' ', m.name) as "vehicleName"
                 FROM reservations r
                 JOIN users u ON u.id = r.customer_id
                 JOIN vehicles v ON v.id = r.vehicle_id
                 JOIN vehicle_models m ON m.id = v.model_id
                 JOIN brands b ON b.id = m.brand_id
                 WHERE r.reservation_number = $1 FOR UPDATE OF r`,
                [num],
            );

            if (!rows[0]) throw new NotFoundException('Reservation not found');
            const res = rows[0];

            // Access check: only owner or admin
            if (req.user.role !== UserRole.ADMIN && res.customer_id !== req.user.id) {
                throw new BadRequestException('Access denied to this reservation');
            }

            if (res.status === ReservationStatus.CONFIRMED) {
                return {
                    success: false,
                    status: 'already_confirmed',
                    message: 'Reservation is already confirmed.',
                    reservationNumber: num,
                };
            }

            if (res.status !== ReservationStatus.AWAITING_PAYMENT) {
                throw new BadRequestException(
                    `Cannot request agency payment. Current reservation status is "${res.status}". Expected awaiting_payment.`,
                );
            }

            // Check if deadline has expired
            if (res.payment_deadline_at && new Date(res.payment_deadline_at) < new Date()) {
                await manager.query(
                    `UPDATE reservations SET status = 'cancelled_unpaid', updated_at = now() WHERE id = $1::uuid`,
                    [res.id],
                );
                throw new BadRequestException('Payment deadline has expired. This reservation is cancelled.');
            }

            const agency = body.agencyName?.trim() || 'LUXUAR Agence - Andrássy Avenue';

            await manager.query(
                `UPDATE reservations
                 SET agency_payment_status = 'agency_payment_requested',
                     agency_payment_requested_at = now(),
                     agency_payment_agency_name = $1,
                     agency_payment_decision_notes = $2,
                     updated_at = now()
                 WHERE id = $3::uuid`,
                [agency, body.notes?.trim() || null, res.id],
            );

            // Notify admin team in user_notifications
            try {
                const admins: { id: string }[] = await manager.query(
                    `SELECT id FROM users WHERE role = 'admin' AND status = 'active'`,
                );
                for (const a of admins) {
                    await manager.query(
                        `INSERT INTO user_notifications
                           (recipient_id, category, priority, title, message, action_url, event_key, entity_type, entity_id)
                         VALUES
                           ($1::uuid, 'payments', 'warning', $2, $3, $4, $5, 'reservation', $6::uuid)
                         ON CONFLICT DO NOTHING`,
                        [
                            a.id,
                            `Manual Payment Requested — ${num}`,
                            `Customer requested manual payment at agency "${agency}" for reservation ${num} (Total: €${res.total_amount} + €${res.deposit_amount} deposit).`,
                            `/admin/finance`,
                            `agency_payment_request:${res.id}:${Date.now()}`,
                            res.id,
                        ],
                    );
                }
            } catch {
                // ignore non-critical notification error
            }

            return {
                success: true,
                status: 'agency_payment_requested',
                agencyPaymentStatus: 'agency_payment_requested',
                agencyName: agency,
                reservationNumber: num,
                message: 'Agency manual payment request registered. Awaiting Admin verification.',
            };
        });
    }

    /**
     * 2. Admin: List all manual payment requests
     * Endpoint: GET /finance/admin/agency-payments/requests
     */
    @Get('admin/agency-payments/requests')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async listAgencyPaymentRequests() {
        const rows = await this.dataSource.query(`
            SELECT 
                r.id,
                r.reservation_number AS "reservationNumber",
                r.status,
                r.agency_payment_status AS "agencyPaymentStatus",
                r.agency_payment_requested_at AS "agencyPaymentRequestedAt",
                r.agency_payment_agency_name AS "agencyPaymentAgencyName",
                r.agency_payment_decided_at AS "agencyPaymentDecidedAt",
                r.agency_payment_decided_by AS "agencyPaymentDecidedBy",
                r.agency_payment_decision_notes AS "agencyPaymentDecisionNotes",
                r.is_demo_payment AS "isDemoPayment",
                r.manual_payment_method AS "manualPaymentMethod",
                r.total_amount AS "totalAmount",
                r.deposit_amount AS "depositAmount",
                (r.total_amount + r.deposit_amount) AS "totalDue",
                r.pickup_at AS "pickupAt",
                r.return_at AS "returnAt",
                r.rental_days AS "rentalDays",
                r.payment_deadline_at AS "paymentDeadlineAt",
                r.created_at AS "createdAt",
                u.email AS "customerEmail",
                CONCAT(u.first_name, ' ', u.last_name) AS "customerName",
                u.phone AS "customerPhone",
                CONCAT(b.name, ' ', m.name) AS "vehicleName",
                v.license_plate AS "licensePlate"
            FROM reservations r
            JOIN users u ON u.id = r.customer_id
            JOIN vehicles v ON v.id = r.vehicle_id
            JOIN vehicle_models m ON m.id = v.model_id
            JOIN brands b ON b.id = m.brand_id
            WHERE r.agency_payment_status != 'none' 
               OR r.agency_payment_requested_at IS NOT NULL
               OR r.manual_payment_method IS NOT NULL
            ORDER BY 
              CASE WHEN r.agency_payment_status = 'agency_payment_requested' THEN 0 ELSE 1 END,
              r.agency_payment_requested_at DESC NULLS LAST,
              r.created_at DESC;
        `);

        return rows;
    }

    /**
     * 3. Admin: Approve manual agency payment
     * Endpoint: POST /finance/admin/agency-payments/:reservationNumber/approve
     */
    @Post('admin/agency-payments/:reservationNumber/approve')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async approveAgencyPayment(
        @Param('reservationNumber') reservationNumber: string,
        @Body() body: ApproveAgencyPaymentDto,
        @Req() req: AuthorizedRequest,
    ) {
        const num = reservationNumber.trim().toUpperCase();

        return this.dataSource.transaction(async (manager) => {
            const rows: any[] = await manager.query(
                `SELECT r.*, u.email as "customerEmail",
                        CONCAT(u.first_name, ' ', u.last_name) as "customerName",
                        CONCAT(b.name, ' ', m.name) as "vehicleName"
                 FROM reservations r
                 JOIN users u ON u.id = r.customer_id
                 JOIN vehicles v ON v.id = r.vehicle_id
                 JOIN vehicle_models m ON m.id = v.model_id
                 JOIN brands b ON b.id = m.brand_id
                 WHERE r.reservation_number = $1 FOR UPDATE OF r`,
                [num],
            );

            if (!rows[0]) throw new NotFoundException('Reservation not found');
            const res = rows[0];

            if (res.status === ReservationStatus.CONFIRMED) {
                return {
                    success: true,
                    status: 'confirmed',
                    message: 'Reservation was already confirmed.',
                    reservationNumber: num,
                };
            }

            if (res.status !== ReservationStatus.AWAITING_PAYMENT) {
                throw new BadRequestException(
                    `Cannot approve payment. Reservation status is "${res.status}". Expected awaiting_payment.`,
                );
            }

            // Expiration check
            if (res.payment_deadline_at && new Date(res.payment_deadline_at) < new Date()) {
                await manager.query(
                    `UPDATE reservations SET status = 'cancelled_unpaid', updated_at = now() WHERE id = $1::uuid`,
                    [res.id],
                );
                throw new BadRequestException('Payment window has expired. Reservation has been cancelled.');
            }

            const paymentMethod = body.method || 'cash';
            const refPrefix = 'MANUAL-AGENCY';
            const rentalRef = body.recordedReference || `${refPrefix}-${num}`;
            const depositRef = `${rentalRef}-DEP`;
            const noteText = body.notes || 'Verified manual payment collected at counter';

            // 1. Update reservation to CONFIRMED
            await manager.query(
                `UPDATE reservations
                 SET status = 'confirmed',
                     paid_at = now(),
                     agency_payment_status = 'approved',
                     agency_payment_decided_at = now(),
                     agency_payment_decided_by = $1::uuid,
                     agency_payment_decision_notes = $2,
                     is_demo_payment = false,
                     manual_payment_method = 'PAID_MANUALLY',
                     stripe_payment_intent_id = $3,
                     updated_at = now()
                 WHERE id = $4::uuid`,
                [
                    req.user.id,
                    noteText,
                    `manual-agency_${num}`,
                    res.id,
                ],
            );

            // 2. Record rental payment in payments table
            await manager.query(
                `INSERT INTO payments 
                   (reservation_id, type, method, amount, currency, reference, recorded_by, notes, provider, is_simulated, is_demo)
                 VALUES ($1::uuid, 'rental_payment', $2, $3, 'EUR', $4, $5::uuid, $6, 'manual_agency', false, false)
                 ON CONFLICT DO NOTHING`,
                [
                    res.id,
                    paymentMethod,
                    res.total_amount,
                    rentalRef,
                    req.user.id,
                    noteText,
                ],
            );

            // 3. Record deposit payment in payments table
            await manager.query(
                `INSERT INTO payments 
                   (reservation_id, type, method, amount, currency, reference, recorded_by, notes, provider, is_simulated, is_demo)
                 VALUES ($1::uuid, 'deposit_payment', $2, $3, 'EUR', $4, $5::uuid, $6, 'manual_agency', false, false)
                 ON CONFLICT DO NOTHING`,
                [
                    res.id,
                    paymentMethod,
                    res.deposit_amount,
                    depositRef,
                    req.user.id,
                    'Security deposit authorized at counter',
                ],
            );

            // 4. Record/hold security deposit
            await manager.query(
                `INSERT INTO security_deposits 
                   (reservation_id, amount, status, held_at, retained_amount)
                 VALUES ($1::uuid, $2, 'held', now(), 0)
                 ON CONFLICT (reservation_id) 
                 DO UPDATE SET status = 'held', held_at = now(), retained_amount = 0, updated_at = now()`,
                [res.id, res.deposit_amount],
            );

            // 5. Send customer notification
            try {
                const updatedRes = await manager.getRepository(Reservation).findOneOrFail({ where: { id: res.id } });
                await this.inboxService.reservationEvent('confirmed', updatedRes);
            } catch {
                // ignore
            }

            return {
                success: true,
                status: 'confirmed',
                reservationNumber: num,
                paymentMethod: 'PAID_MANUALLY',
                rentalAmount: res.total_amount,
                depositAmount: res.deposit_amount,
                message: 'Manual agency payment approved and recorded. Reservation confirmed.',
            };
        });
    }

    /**
     * 4. Admin: Reject manual agency payment
     * Endpoint: POST /finance/admin/agency-payments/:reservationNumber/reject
     */
    @Post('admin/agency-payments/:reservationNumber/reject')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async rejectAgencyPayment(
        @Param('reservationNumber') reservationNumber: string,
        @Body() body: RejectAgencyPaymentDto,
        @Req() req: AuthorizedRequest,
    ) {
        const num = reservationNumber.trim().toUpperCase();
        const reason = body.reason?.trim();
        if (!reason) {
            throw new BadRequestException('A reason is mandatory when rejecting a manual payment request.');
        }

        return this.dataSource.transaction(async (manager) => {
            const rows: any[] = await manager.query(
                `SELECT r.*, u.email as "customerEmail"
                 FROM reservations r
                 JOIN users u ON u.id = r.customer_id
                 WHERE r.reservation_number = $1 FOR UPDATE OF r`,
                [num],
            );

            if (!rows[0]) throw new NotFoundException('Reservation not found');
            const res = rows[0];

            if (
                res.status === ReservationStatus.CONFIRMED ||
                res.status === 'active_rental' ||
                res.status === 'completed'
            ) {
                throw new BadRequestException('Cannot reject payment request for a confirmed, active or completed reservation.');
            }

            // Set agency_payment_status to rejected while preserving reservation status and historical contracts
            await manager.query(
                `UPDATE reservations
                 SET agency_payment_status = 'rejected',
                     agency_payment_decided_at = now(),
                     agency_payment_decided_by = $1::uuid,
                     agency_payment_decision_notes = $2,
                     updated_at = now()
                 WHERE id = $3::uuid`,
                [req.user.id, reason, res.id],
            );

            // Revert security deposit back to pending if it was placed on hold under the rejected agency payment
            await manager.query(
                `UPDATE security_deposits
                 SET status = 'pending', held_at = null, updated_at = now()
                 WHERE reservation_id = $1::uuid AND status = 'held'`,
                [res.id],
            );

            // Notify customer in user_notifications
            try {
                await manager.query(
                    `INSERT INTO user_notifications
                       (recipient_id, category, priority, title, message, action_url, event_key, entity_type, entity_id)
                     VALUES
                       ($1::uuid, 'payments', 'warning', $2, $3, $4, $5, 'reservation', $6::uuid)
                     ON CONFLICT DO NOTHING`,
                    [
                        res.customer_id,
                        `Agency Payment Request Declined — ${num}`,
                        `Your request to pay at agency for reservation ${num} was declined: "${reason}". You may still complete your payment online using card before the deadline expires.`,
                        `/account/payments/${num}`,
                        `agency_payment_declined:${res.id}:${Date.now()}`,
                        res.id,
                    ],
                );
            } catch {
                // ignore
            }

            return {
                success: true,
                status: res.status,
                agencyPaymentStatus: 'rejected',
                reservationNumber: num,
                message: 'Agency payment request rejected. Customer notified and online payment remains open.',
            };
        });
    }
}
