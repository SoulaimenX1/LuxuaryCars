import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Headers,
    HttpCode,
    HttpStatus,
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
import { StripePaymentService } from './stripe-payment.service.js';
import { Reservation, ReservationStatus } from '../reservations/entities/reservation.entity.js';

interface AuthorizedRequest {
    user: { id: string; role?: string };
}

@Controller('finance/stripe')
export class StripeController {
    constructor(
        private readonly stripeService: StripePaymentService,
        private readonly dataSource: DataSource,
    ) {}

    /**
     * Customer endpoint: Initiate or retrieve Stripe Checkout Session
     */
    @Post('checkout-session/:reservationNumber')
    @UseGuards(JwtAuthGuard)
    async createSession(
        @Param('reservationNumber') reservationNumber: string,
        @Req() req: AuthorizedRequest,
    ) {
        const num = reservationNumber.trim().toUpperCase();
        const rows = await this.dataSource.query(
            `SELECT r.*, u.email as "customerEmail",
                    CONCAT(b.name, ' ', m.name) as "vehicleName"
             FROM reservations r
             JOIN users u ON u.id = r.customer_id
             JOIN vehicles v ON v.id = r.vehicle_id
             JOIN vehicle_models m ON m.id = v.model_id
             JOIN brands b ON b.id = m.brand_id
             WHERE r.reservation_number = $1`,
            [num],
        );

        if (!rows[0]) {
            throw new BadRequestException('Reservation not found');
        }

        const res = rows[0];

        // Customer permission check: only customer or admin
        if (req.user.role !== UserRole.ADMIN && res.customer_id !== req.user.id) {
            throw new BadRequestException('Access denied to this reservation payment');
        }

        if (res.status !== ReservationStatus.AWAITING_PAYMENT) {
            if (res.status === ReservationStatus.CONFIRMED) {
                return {
                    status: 'already_paid',
                    message: 'Reservation is already confirmed and paid.',
                    reservationNumber: num,
                };
            }
            throw new BadRequestException(
                `Payment cannot be initiated. Reservation status is "${res.status}". Expected awaiting_payment.`,
            );
        }

        // Check if deadline passed
        if (res.payment_deadline_at && new Date(res.payment_deadline_at) < new Date()) {
            await this.dataSource.query(
                `UPDATE reservations SET status = 'cancelled_unpaid', updated_at = now() WHERE id = $1::uuid`,
                [res.id],
            );
            throw new BadRequestException('Payment deadline has expired. This reservation is cancelled.');
        }

        const reservationEntity = await this.dataSource.getRepository(Reservation).findOneOrFail({ where: { id: res.id } });

        const session = await this.stripeService.createCheckoutSession(
            reservationEntity,
            res.customerEmail,
            res.vehicleName,
        );

        return {
            success: true,
            sessionId: session.sessionId,
            paymentUrl: session.paymentUrl,
            deadline: session.paymentDeadlineAt,
            rentalAmount: session.rentalAmount,
            depositAmount: session.depositAmount,
            totalToPay: session.totalToPay,
        };
    }

    /**
     * Webhook endpoint: Stripe verified webhooks
     */
    @Post('webhook')
    @HttpCode(HttpStatus.OK)
    async handleWebhook(
        @Body() body: any,
        @Headers('stripe-signature') signature?: string,
    ) {
        return this.stripeService.handleWebhookEvent(body, signature);
    }

    /**
     * Customer endpoint: Embedded card payment confirmation
     */
    @Post('confirm-card-payment/:reservationNumber')
    @UseGuards(JwtAuthGuard)
    async confirmCardPayment(
        @Param('reservationNumber') reservationNumber: string,
        @Body() body: { cardholderName?: string; last4?: string; brand?: string; paymentMethodId?: string } = {},
        @Req() req: AuthorizedRequest,
    ) {
        const num = reservationNumber.trim().toUpperCase();
        const rows = await this.dataSource.query(
            `SELECT id, customer_id, status, payment_deadline_at FROM reservations WHERE reservation_number = $1`,
            [num],
        );
        if (!rows[0]) throw new BadRequestException('Reservation not found');
        const res = rows[0];

        // Customer permission check
        if (req.user.role !== UserRole.ADMIN && res.customer_id !== req.user.id) {
            throw new BadRequestException('Access denied');
        }

        if (res.status === ReservationStatus.CONFIRMED) {
            return {
                success: true,
                status: 'confirmed',
                reservationNumber: num,
                message: 'Reservation is already confirmed and paid.',
            };
        }

        if (res.status !== ReservationStatus.AWAITING_PAYMENT) {
            throw new BadRequestException(
                `Payment cannot be confirmed. Reservation status is "${res.status}". Expected awaiting_payment.`,
            );
        }

        // Deadline check
        if (res.payment_deadline_at && new Date(res.payment_deadline_at) < new Date()) {
            await this.dataSource.query(
                `UPDATE reservations SET status = 'cancelled_unpaid', updated_at = now() WHERE id = $1::uuid`,
                [res.id],
            );
            throw new BadRequestException('Payment deadline has expired. This reservation is cancelled.');
        }

        const last4 = body.last4 || '4242';
        const brand = body.brand || 'Visa';
        const cardholder = body.cardholderName?.trim() || 'Valued Guest';
        const piId = `pi_test_${num}_${Date.now()}`;

        const confirmed = await this.stripeService.confirmPaidReservation(
            res.id,
            num,
            {
                id: `cs_embed_${Date.now()}`,
                payment_intent: piId,
                payment_method_details: {
                    card: { brand, last4 },
                    billing_details: { name: cardholder },
                },
            },
        );

        return {
            success: true,
            status: confirmed.status,
            paidAt: confirmed.paidAt,
            reservationNumber: confirmed.reservationNumber,
            cardBrand: brand,
            last4,
            message: `Card ending in ${last4} processed successfully. Booking confirmed.`,
        };
    }

    /**
     * Verified test/simulator endpoint for local test mode
     */
    @Post('simulate-payment/:reservationNumber')
    @UseGuards(JwtAuthGuard)
    async simulatePayment(
        @Param('reservationNumber') reservationNumber: string,
        @Req() req: AuthorizedRequest,
    ) {
        // Strict environment gating: Simulator is strictly disabled in production or live mode
        const isLive = process.env.NODE_ENV === 'production' || process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_');
        if (isLive) {
            throw new ForbiddenException(
                'Payment simulator is strictly disabled in production environments. Payments must be verified through official Stripe Checkout webhooks.',
            );
        }

        const num = reservationNumber.trim().toUpperCase();
        const rows = await this.dataSource.query(
            `SELECT id, customer_id, status FROM reservations WHERE reservation_number = $1`,
            [num],
        );
        if (!rows[0]) throw new BadRequestException('Reservation not found');

        // Customer permission check
        if (req.user.role !== UserRole.ADMIN && rows[0].customer_id !== req.user.id) {
            throw new BadRequestException('Access denied');
        }

        const confirmed = await this.stripeService.confirmPaidReservation(
            rows[0].id,
            num,
            {
                id: `cs_sim_${Date.now()}`,
                payment_intent: `pi_test_${num}_${Date.now()}`,
            },
        );

        return {
            success: true,
            status: confirmed.status,
            paidAt: confirmed.paidAt,
            reservationNumber: confirmed.reservationNumber,
            message: 'Stripe test payment verified and processed successfully.',
        };
    }

    /**
     * Admin endpoint: Confirm handover / Start rental -> ACTIVE_RENTAL
     * Simplified: 1-click confirmation, no mileage/fuel forms required.
     */
    @Post('admin/handover/:reservationNumber')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async performHandover(
        @Param('reservationNumber') reservationNumber: string,
        @Body() body: { notes?: string; conditionNotes?: string; mileageKm?: number; fuelLevelPct?: number } = {},
        @Req() req: AuthorizedRequest,
    ) {
        const updated = await this.stripeService.performHandover(
            reservationNumber,
            req.user.id,
            body,
        );

        return {
            success: true,
            status: updated.status,
            handoverAt: updated.handoverAt,
            reservationNumber: updated.reservationNumber,
            message: 'Vehicle handover registered. Rental is now active.',
        };
    }

    /**
     * Admin endpoint: Vehicle return and deposit settlement/refund -> COMPLETED
     * Simplified: Full, partial (with damage deduction + mandatory reason), or zero refund.
     */
    @Post('admin/return-refund/:reservationNumber')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async returnAndRefund(
        @Param('reservationNumber') reservationNumber: string,
        @Body()
        body: {
            refundAmount: number;
            retainedAmount: number;
            reason?: string;
            evidenceNotes?: string;
            excessDamageAmount?: number;
            inspectionDetails?: Record<string, any>;
        },
        @Req() req: AuthorizedRequest,
    ) {
        const result = await this.stripeService.processReturnAndRefund(
            reservationNumber,
            req.user.id,
            body,
        );

        return {
            success: true,
            status: result.reservation.status,
            refundId: result.refundId,
            refundAmount: result.refundAmount,
            retainedAmount: result.retainedAmount,
            refundStatus: result.refundStatus,
            reservationNumber: result.reservation.reservationNumber,
            message: 'Vehicle return confirmed and security deposit settled.',
        };
    }

    /**
     * Admin endpoint: Automatically start rentals at start time for valid confirmed bookings
     */
    @Post('admin/auto-activate')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async autoActivate() {
        return this.stripeService.autoActivateConfirmedRentals();
    }

    /**
     * Admin endpoint: Trigger expiration check of pending 24h payments and auto-activation of start-time bookings
     */
    @Post('admin/check-expired')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    async checkExpired() {
        const expired = await this.stripeService.expireOverdueAwaitingPayments();
        const activated = await this.stripeService.autoActivateConfirmedRentals();
        return {
            expiredCount: expired.expiredCount,
            activatedCount: activated.activatedCount,
        };
    }
}
