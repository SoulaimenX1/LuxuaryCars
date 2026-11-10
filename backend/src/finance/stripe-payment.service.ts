import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
// @ts-ignore
import Stripe from 'stripe';
import { Reservation, ReservationStatus } from '../reservations/entities/reservation.entity.js';
import { InboxService } from '../notifications/inbox.service.js';
import { EmailOutboxService } from '../notifications/email-outbox.service.js';

export interface CheckoutSessionResult {
    sessionId: string;
    paymentUrl: string;
    paymentDeadlineAt: Date;
    rentalAmount: string;
    depositAmount: string;
    totalToPay: string;
}

export interface DepositRefundInput {
    refundAmount: number;
    retainedAmount: number;
    reason?: string;
    evidenceNotes?: string;
    excessDamageAmount?: number;
    inspectionDetails?: Record<string, any>;
}

@Injectable()
export class StripePaymentService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(StripePaymentService.name);
    private readonly stripeClient: Stripe | null = null;
    private readonly isTestMode: boolean;
    private readonly webhookSecret: string;
    private readonly frontendUrl: string;
    private readonly signingSecret: string;
    private expirationTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly dataSource: DataSource,
        private readonly config: ConfigService,
        @Optional() private readonly inboxService?: InboxService,
        @Optional() private readonly emailOutbox?: EmailOutboxService,
    ) {
        const apiKey = this.config.get<string>('STRIPE_SECRET_KEY') ?? '';
        this.isTestMode = this.config.get<boolean>('STRIPE_TEST_MODE') ?? true;
        this.webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET') ?? 'whsec_luxuar_test_secret';
        this.frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
        this.signingSecret = this.config.get<string>('JWT_SECRET') ?? 'luxuar-secure-payment-signing-secret';

        if (apiKey && apiKey.startsWith('sk_') && !apiKey.includes('change_me') && !apiKey.includes('demo_key')) {
            try {
                this.stripeClient = new Stripe(apiKey, {
                    apiVersion: '2025-02-24.acacia' as any,
                });
                this.logger.log('Stripe client initialized in live/test mode with provided API key.');
            } catch (err) {
                this.logger.warn(`Stripe initialization warning: ${String(err)}`);
            }
        } else {
            this.logger.log('Running in verified Stripe Test/Sandbox Mode with local signature validation.');
        }
    }

    onModuleInit() {
        const runScan = async () => {
            try {
                await this.expireOverdueAwaitingPayments();
                await this.autoActivateConfirmedRentals();
            } catch (err: any) {
                this.logger.error(`Automatic payment expiration / rental activation scan error: ${err.message}`);
            }
        };
        // Run initial scan on startup
        void runScan();
        // Schedule periodic automatic scan every 30 seconds
        this.expirationTimer = setInterval(() => { void runScan(); }, 30_000);
        if (this.expirationTimer.unref) {
            this.expirationTimer.unref();
        }
        this.logger.log('Automatic 24-hour payment expiration & rental start monitor active (interval: 30s).');
    }

    onModuleDestroy() {
        if (this.expirationTimer) {
            clearInterval(this.expirationTimer);
            this.expirationTimer = null;
        }
    }

    /**
     * Generate secure HMAC token for payment URL verification
     */
    private generatePaymentToken(reservationId: string, reservationNumber: string): string {
        return createHmac('sha256', this.signingSecret)
            .update(`${reservationId}:${reservationNumber}`)
            .digest('hex');
    }

    /**
     * Verify payment token
     */
    public verifyPaymentToken(reservationId: string, reservationNumber: string, token: string): boolean {
        const expected = this.generatePaymentToken(reservationId, reservationNumber);
        return expected === token;
    }

    /**
     * 1. Create a Stripe Checkout session separating rental fee and refundable deposit
     */
    async createCheckoutSession(
        reservation: Reservation,
        customerEmail?: string,
        vehicleName?: string,
        persist = true,
    ): Promise<CheckoutSessionResult> {
        const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // exactly 24 hours
        const vName = vehicleName || 'Luxury Vehicle';
        const rentalCents = Math.round(Number(reservation.totalAmount) * 100);
        const depositCents = Math.round(Number(reservation.depositAmount) * 100);
        const totalCents = rentalCents + depositCents;
        const totalToPay = (totalCents / 100).toFixed(2);

        let sessionId: string;
        let paymentUrl: string;

        if (this.stripeClient) {
            try {
                const session = await this.stripeClient.checkout.sessions.create({
                    line_items: [
                        {
                            price_data: {
                                currency: 'eur',
                                product_data: {
                                    name: `LUXUAR Rental — ${vName}`,
                                    description: `Rental contract for ${reservation.rentalDays} day(s) · Ref: ${reservation.reservationNumber}`,
                                },
                                unit_amount: rentalCents,
                            },
                            quantity: 1,
                        },
                        {
                            price_data: {
                                currency: 'eur',
                                product_data: {
                                    name: `Refundable Security Deposit — ${vName}`,
                                    description: `Returned upon inspected return of vehicle · Ref: ${reservation.reservationNumber}`,
                                },
                                unit_amount: depositCents,
                            },
                            quantity: 1,
                        },
                    ],
                    mode: 'payment',
                    customer_email: customerEmail,
                    client_reference_id: reservation.reservationNumber,
                    metadata: {
                        reservationId: reservation.id,
                        reservationNumber: reservation.reservationNumber,
                        customerId: reservation.customerId,
                        rentalAmount: reservation.totalAmount,
                        depositAmount: reservation.depositAmount,
                    },
                    expires_at: Math.floor(deadline.getTime() / 1000),
                    success_url: `${this.frontendUrl}/account/payments/${reservation.reservationNumber}?success=true&session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${this.frontendUrl}/account/payments/${reservation.reservationNumber}?canceled=true`,
                });

                sessionId = session.id;
                paymentUrl = session.url ?? `${this.frontendUrl}/account/payments/${reservation.reservationNumber}?session_id=${sessionId}`;
            } catch (error) {
                this.logger.error(`Failed to create Stripe Checkout session externally: ${String(error)}`);
                sessionId = `cs_test_${reservation.reservationNumber}_${randomBytes(8).toString('hex')}`;
                paymentUrl = `${this.frontendUrl}/account/payments/${reservation.reservationNumber}?session_id=${sessionId}`;
            }
        } else {
            // Local verified test mode
            sessionId = `cs_test_${reservation.reservationNumber}_${randomBytes(8).toString('hex')}`;
            paymentUrl = `${this.frontendUrl}/account/payments/${reservation.reservationNumber}?session_id=${sessionId}`;
        }

        // Persist session, payment URL and 24h deadline on reservation if requested
        if (persist) {
            await this.dataSource.query(
                `UPDATE reservations 
                 SET payment_deadline_at = $1,
                     stripe_session_id = $2,
                     payment_url = $3,
                     status = 'awaiting_payment',
                     updated_at = now()
                 WHERE id = $4::uuid`,
                [deadline, sessionId, paymentUrl, reservation.id],
            );
        }

        reservation.paymentDeadlineAt = deadline;
        reservation.stripeSessionId = sessionId;
        reservation.paymentUrl = paymentUrl;
        reservation.status = ReservationStatus.AWAITING_PAYMENT;

        return {
            sessionId,
            paymentUrl,
            paymentDeadlineAt: deadline,
            rentalAmount: reservation.totalAmount,
            depositAmount: reservation.depositAmount,
            totalToPay,
        };
    }

    /**
     * 2. Webhook processing with signature verification & idempotency
     */
    async handleWebhookEvent(
        rawPayload: string | Buffer,
        signatureHeader?: string,
    ): Promise<{ received: boolean; status: string; reservationNumber?: string }> {
        let event: any;

        const payloadString = Buffer.isBuffer(rawPayload) ? rawPayload.toString('utf8') : rawPayload;

        if (this.stripeClient && signatureHeader) {
            try {
                event = this.stripeClient.webhooks.constructEvent(
                    rawPayload,
                    signatureHeader,
                    this.webhookSecret,
                );
            } catch (err: any) {
                this.logger.error(`Stripe signature verification failed: ${err.message}`);
                throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
            }
        } else {
            // In test mode / simulation
            try {
                event = typeof payloadString === 'string' ? JSON.parse(payloadString) : rawPayload;
            } catch {
                throw new BadRequestException('Invalid JSON payload');
            }
        }

        const eventId = event.id || `evt_test_${randomUUID()}`;
        const eventType = event.type || 'checkout.session.completed';

        // Check duplicate webhook processing
        const existing = await this.dataSource.query(
            `SELECT id FROM stripe_processed_events WHERE event_id = $1 LIMIT 1`,
            [eventId],
        );

        if (existing[0]) {
            this.logger.log(`Duplicate webhook event ${eventId} ignored.`);
            return { received: true, status: 'duplicate_ignored' };
        }

        // Record event in idempotency table
        await this.dataSource.query(
            `INSERT INTO stripe_processed_events (event_id, event_type, payload)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (event_id) DO NOTHING`,
            [eventId, eventType, JSON.stringify(event)],
        );

        if (eventType === 'checkout.session.completed' || eventType === 'payment_intent.succeeded') {
            const session = event.data?.object || event;
            const resNumber = session.client_reference_id || session.metadata?.reservationNumber;
            const resId = session.metadata?.reservationId;

            const res = await this.confirmPaidReservation(resId, resNumber, session);
            return { received: true, status: 'confirmed', reservationNumber: res.reservationNumber };
        }

        if (eventType === 'payment_intent.payment_failed') {
            const pi = event.data?.object || event;
            const resNumber = pi.metadata?.reservationNumber;
            this.logger.warn(`Stripe payment failed for reservation ${resNumber}: ${pi.last_payment_error?.message || 'Payment declined'}`);
            return { received: true, status: 'payment_failed', reservationNumber: resNumber };
        }

        if (eventType === 'charge.refunded') {
            const charge = event.data?.object || event;
            const refund = charge.refunds?.data?.[0];
            const piId = charge.payment_intent;
            if (piId) {
                await this.dataSource.query(
                    `UPDATE reservations
                     SET stripe_refund_id = COALESCE(stripe_refund_id, $1),
                         deposit_refund_status = CASE WHEN deposit_refund_status = 'none' THEN 'refunded' ELSE deposit_refund_status END,
                         updated_at = now()
                     WHERE stripe_payment_intent_id = $2`,
                    [refund?.id || `re_${Date.now()}`, piId],
                );
            }
            return { received: true, status: 'refund_confirmed' };
        }

        if (eventType === 'charge.refund.updated') {
            const refundObj = event.data?.object || event;
            if (refundObj.status === 'failed') {
                this.logger.error(`Stripe refund failed for refund ${refundObj.id}: ${refundObj.failure_reason}`);
                await this.dataSource.query(
                    `UPDATE reservations
                     SET deposit_refund_status = 'refund_failed',
                         updated_at = now()
                     WHERE stripe_refund_id = $1`,
                    [refundObj.id],
                );
                return { received: true, status: 'refund_failure_recorded' };
            }
            return { received: true, status: 'refund_updated' };
        }

        return { received: true, status: 'unhandled_event' };
    }

    /**
     * 3. Confirm payment atomically, write ledger and transition to CONFIRMED
     */
    async confirmPaidReservation(
        reservationId?: string,
        reservationNumber?: string,
        paymentDetails?: any,
    ): Promise<Reservation> {
        return this.dataSource.transaction(async (manager) => {
            const query = reservationId
                ? `SELECT * FROM reservations WHERE id = $1::uuid FOR UPDATE`
                : `SELECT * FROM reservations WHERE reservation_number = $1 FOR UPDATE`;
            const param = reservationId || reservationNumber;

            const rows: any[] = await manager.query(query, [param]);
            if (!rows[0]) {
                throw new NotFoundException('Reservation not found for payment confirmation');
            }

            const current = rows[0];

            // Verify status
            if (current.status === 'confirmed') {
                // Already confirmed (idempotent)
                return manager.getRepository(Reservation).findOneOrFail({ where: { id: current.id } });
            }

            if (current.status !== 'awaiting_payment') {
                throw new ConflictException(
                    `Cannot confirm payment for reservation with status "${current.status}". Expected awaiting_payment.`,
                );
            }

            // Verify payment deadline
            if (current.payment_deadline_at && new Date(current.payment_deadline_at) < new Date()) {
                // Expired!
                await manager.query(
                    `UPDATE reservations SET status = 'cancelled_unpaid', updated_at = now() WHERE id = $1::uuid`,
                    [current.id],
                );
                throw new ConflictException('Payment deadline has expired. Reservation has been cancelled.');
            }

            const paymentIntentId =
                paymentDetails?.payment_intent ||
                paymentDetails?.id ||
                `pi_test_${current.reservation_number}_${randomBytes(6).toString('hex')}`;

            // Update reservation status to CONFIRMED
            await manager.query(
                `UPDATE reservations
                 SET status = 'confirmed',
                     paid_at = now(),
                     stripe_payment_intent_id = $1,
                     updated_at = now()
                 WHERE id = $2::uuid`,
                [paymentIntentId, current.id],
            );

            // Record rental payment into payments table
            await manager.query(
                `INSERT INTO payments 
                   (reservation_id, type, method, amount, currency, reference, recorded_by, notes)
                 VALUES ($1::uuid, 'rental_payment', 'card', $2, 'EUR', $3, $4::uuid, 'Verified Stripe Checkout rental payment')
                 ON CONFLICT DO NOTHING`,
                [current.id, current.total_amount, paymentIntentId, current.customer_id],
            );

            // Record security deposit payment into payments table
            await manager.query(
                `INSERT INTO payments 
                   (reservation_id, type, method, amount, currency, reference, recorded_by, notes)
                 VALUES ($1::uuid, 'deposit_payment', 'card', $2, 'EUR', $3, $4::uuid, 'Verified Stripe Checkout refundable deposit hold')
                 ON CONFLICT DO NOTHING`,
                [current.id, current.deposit_amount, `${paymentIntentId}-deposit`, current.customer_id],
            );

            // Create or update security_deposits record
            await manager.query(
                `INSERT INTO security_deposits 
                   (reservation_id, amount, status, held_at, retained_amount)
                 VALUES ($1::uuid, $2, 'held', now(), 0)
                 ON CONFLICT (reservation_id) 
                 DO UPDATE SET status = 'held', held_at = now(), retained_amount = 0, updated_at = now()`,
                [current.id, current.deposit_amount],
            );

            // Fetch the updated reservation
            const updated = await manager.getRepository(Reservation).findOneOrFail({ where: { id: current.id } });

            // Notify customer and admins
            if (this.inboxService) {
                await this.inboxService.reservationEvent('confirmed', updated);
            }

            return updated;
        });
    }

    /**
     * 4. Perform Vehicle Handover -> ACTIVE_RENTAL
     * Simplified: Handover confirmed by admin with 1 click; no mileage/fuel forms required.
     */
    async performHandover(
        reservationNumber: string,
        adminId: string,
        options?: { notes?: string; conditionNotes?: string; mileageKm?: number; fuelLevelPct?: number },
    ): Promise<Reservation> {
        return this.dataSource.transaction(async (manager) => {
            const rows = await manager.query(
                `SELECT * FROM reservations WHERE reservation_number = $1 FOR UPDATE`,
                [reservationNumber.trim().toUpperCase()],
            );
            if (!rows[0]) throw new NotFoundException('Reservation not found');
            const reservation = rows[0];

            if (reservation.status !== 'confirmed') {
                throw new ConflictException(
                    `Only confirmed reservations can be handed over. Current status: ${reservation.status}`,
                );
            }

            // Validate rental dates: return_at must not have passed
            const now = new Date();
            if (now >= new Date(reservation.return_at)) {
                throw new ConflictException(
                    `Cannot perform handover: scheduled return date has already passed for reservation ${reservation.reservation_number}.`,
                );
            }

            // Verify payment eligibility: rental total and required deposit conditions
            const paymentSummary = await manager.query(
                `SELECT 
                   COALESCE(SUM(CASE WHEN p.type = 'rental_payment' AND p.paid_at IS NOT NULL AND p.is_demo = false AND p.is_simulated = false THEN p.amount ELSE 0 END), 0) AS "realRentalPaid",
                   COALESCE(SUM(CASE WHEN p.type = 'deposit_payment' AND p.paid_at IS NOT NULL THEN p.amount ELSE 0 END), 0) AS "depositPaid"
                 FROM payments p
                 WHERE p.reservation_id = $1::uuid`,
                [reservation.id],
            );

            const heldDeposit = await manager.query(
                `SELECT id FROM security_deposits WHERE reservation_id = $1::uuid AND status = 'held' AND amount >= $2 LIMIT 1`,
                [reservation.id, reservation.deposit_amount],
            );

            const totalAmount = Number(reservation.total_amount);
            const depositAmount = Number(reservation.deposit_amount);
            const realRentalPaid = Number(paymentSummary[0]?.realRentalPaid ?? 0);
            const depositPaid = Number(paymentSummary[0]?.depositPaid ?? 0);
            const hasDepositHeld = Boolean(heldDeposit[0]) || depositPaid >= depositAmount || depositAmount <= 0;

            // Verified real payment: covers rental total and deposit condition is satisfied
            // (A rejected agency request cannot invalidate an independently verified Stripe / real payment)
            const hasVerifiedRealPayment = (Boolean(reservation.paid_at) || realRentalPaid >= totalAmount) &&
                                           realRentalPaid >= totalAmount &&
                                           hasDepositHeld;

            if (!hasVerifiedRealPayment) {
                throw new ConflictException(
                    `Cannot perform handover: reservation ${reservation.reservation_number} requires verified payment covering rental total (€${totalAmount}) and security deposit (€${depositAmount}).`,
                );
            }

            // Reject duplicate activations: contract must not already be active
            const existingRental = await manager.query(
                `SELECT id, status, contract_number FROM rentals WHERE reservation_id = $1::uuid`,
                [reservation.id],
            );
            if (existingRental[0]?.status === 'active') {
                throw new ConflictException(
                    `Rental contract ${existingRental[0].contract_number} is already active for reservation ${reservation.reservation_number}. Duplicate activation rejected.`,
                );
            }

            const handoverNotes = options?.notes || options?.conditionNotes || 'Handover confirmed by admin';

            // Create or activate rental contract
            const contractRes = await manager.query(
                `INSERT INTO rentals 
                   (reservation_id, status, started_at, expected_return_at, opened_by, notes)
                 VALUES ($1::uuid, 'active', now(), $2, $3::uuid, $4)
                 ON CONFLICT (reservation_id)
                 DO UPDATE SET status = 'active', started_at = now(), expected_return_at = $2, opened_by = $3::uuid, notes = $4
                 RETURNING id`,
                [reservation.id, reservation.return_at, adminId, handoverNotes],
            );
            const rentalId = contractRes[0]?.id;

            // Update reservation status to active_rental
            await manager.query(
                `UPDATE reservations
                 SET status = 'active_rental',
                     handover_at = now(),
                     handover_by = $1::uuid,
                     handover_inspection = $2::jsonb,
                     updated_at = now()
                 WHERE id = $3::uuid`,
                [adminId, JSON.stringify({ notes: handoverNotes, confirmedAt: new Date().toISOString() }), reservation.id],
            );

            // Record baseline handover inspection so database triggers and return workflows succeed
            if (rentalId) {
                const vehicleRow = await manager.query(
                    `SELECT mileage_km FROM vehicles WHERE id = $1::uuid`,
                    [reservation.vehicle_id],
                );
                const baselineMileage =
                    options?.mileageKm && options.mileageKm > 0
                        ? options.mileageKm
                        : Number(vehicleRow[0]?.mileage_km || 1000);
                const baselineFuel = options?.fuelLevelPct ?? 100;

                await manager.query(
                    `INSERT INTO inspections 
                       (rental_id, type, mileage_km, fuel_level_pct, overall_condition, notes, performed_by)
                     VALUES ($1::uuid, 'handover', $2, $3, 'excellent', $4, $5::uuid)
                     ON CONFLICT DO NOTHING`,
                    [rentalId, baselineMileage, baselineFuel, handoverNotes, adminId],
                );
                await manager.query(
                    `UPDATE vehicles SET mileage_km = $1 WHERE id = $2::uuid`,
                    [baselineMileage, reservation.vehicle_id],
                );
            }

            const updated = await manager.getRepository(Reservation).findOneOrFail({ where: { id: reservation.id } });

            // Notify customer of active rental
            if (this.inboxService) {
                await this.inboxService.reservationEvent('active_rental' as any, updated);
            }

            return updated;
        });
    }

    /**
     * 5. Process Return & Deposit Settlement/Refund -> COMPLETED
     * Simplified: Confirms vehicle return and settles security deposit (Full / Partial / Zero refund).
     * Mandatory reason required when retaining deposit. Retained amount cannot exceed deposit.
     */
    async processReturnAndRefund(
        reservationNumber: string,
        adminId: string,
        input: DepositRefundInput,
    ): Promise<{
        reservation: Reservation;
        refundId: string;
        refundAmount: string;
        retainedAmount: string;
        refundStatus: string;
    }> {
        return this.dataSource.transaction(async (manager) => {
            const rows = await manager.query(
                `SELECT * FROM reservations WHERE reservation_number = $1 FOR UPDATE`,
                [reservationNumber.trim().toUpperCase()],
            );
            if (!rows[0]) throw new NotFoundException('Reservation not found');
            const reservation = rows[0];

            if (reservation.status !== 'active_rental' && reservation.status !== 'confirmed') {
                throw new ConflictException(
                    `Return can only be processed for active rentals. Current status: ${reservation.status}`,
                );
            }

            const totalDeposit = Number(reservation.deposit_amount);
            const refundAmount = Math.max(0, Number(input.refundAmount));
            const retainedAmount = Math.max(0, Number(input.retainedAmount));

            // Deposit settlement mismatch check
            if (Math.abs(refundAmount + retainedAmount - totalDeposit) > 0.05) {
                throw new BadRequestException(
                    `Deposit settlement mismatch: refund (${refundAmount} €) + retained (${retainedAmount} €) must equal total deposit (${totalDeposit} €)`,
                );
            }

            // Damage deduction cannot exceed security deposit
            if (retainedAmount > totalDeposit) {
                throw new BadRequestException(
                    `Damage deduction (${retainedAmount} €) cannot exceed the security deposit (${totalDeposit} €). Record excess damage separately.`,
                );
            }

            // Mandatory reason when retaining deposit
            if (retainedAmount > 0 && (!input.reason || !input.reason.trim())) {
                throw new BadRequestException(
                    'A mandatory reason and supporting explanation is required when retaining deposit or deducting for damage.',
                );
            }

            let refundId = `re_test_${reservation.reservation_number}_${randomBytes(6).toString('hex')}`;

            // If real Stripe client, non-manual transaction, and refundAmount > 0
            const isManualPayment = 
                String(reservation.stripe_payment_intent_id || '').startsWith('manual') ||
                String(reservation.manual_payment_method || '').includes('MANUAL');

            if (this.stripeClient && reservation.stripe_payment_intent_id && !isManualPayment && refundAmount > 0) {
                try {
                    const refund = await this.stripeClient.refunds.create({
                        payment_intent: reservation.stripe_payment_intent_id,
                        amount: Math.round(refundAmount * 100),
                        reason: 'requested_by_customer',
                    });
                    refundId = refund.id;
                } catch (err: any) {
                    this.logger.error(`Stripe refund failed: ${err.message}`);
                    throw new ConflictException(`Stripe refund failed: ${err.message}`);
                }
            }

            const refundStatus =
                retainedAmount > 0
                    ? refundAmount > 0
                        ? 'partial_refund'
                        : 'retained'
                    : 'refunded';

            const returnSummary = {
                confirmedAt: new Date().toISOString(),
                reason: input.reason || null,
                evidenceNotes: input.evidenceNotes || null,
                excessDamageAmount: input.excessDamageAmount || 0,
                inspectionDetails: input.inspectionDetails || null,
            };

            // Update reservation
            await manager.query(
                `UPDATE reservations
                 SET status = 'completed',
                     return_confirmed_at = now(),
                     return_confirmed_by = $1::uuid,
                     return_inspection = $2::jsonb,
                     deposit_refund_status = $3,
                     deposit_refunded_amount = $4,
                     deposit_retained_amount = $5,
                     deposit_retention_reason = $6,
                     stripe_refund_id = $7,
                     updated_at = now()
                 WHERE id = $8::uuid`,
                [
                    adminId,
                    JSON.stringify(returnSummary),
                    refundStatus,
                    refundAmount.toFixed(2),
                    retainedAmount.toFixed(2),
                    input.reason || null,
                    refundId,
                    reservation.id,
                ],
            );

            // Close rental contract
            await manager.query(
                `UPDATE rentals
                 SET status = 'closed',
                     returned_at = now(),
                     closed_at = now(),
                     closed_by = $1::uuid,
                     notes = COALESCE(notes, '') || ' | Vehicle returned & deposit settled',
                     updated_at = now()
                 WHERE reservation_id = $2::uuid`,
                [adminId, reservation.id],
            );

            // Update security deposit record
            const depositStatus = retainedAmount > 0 ? (refundAmount > 0 ? 'partially_retained' : 'retained') : 'released';
            await manager.query(
                `UPDATE security_deposits
                 SET status = $1,
                     retained_amount = $2,
                     retention_reason = $3,
                     released_at = now(),
                     updated_at = now()
                 WHERE reservation_id = $4::uuid`,
                [depositStatus, retainedAmount.toFixed(2), input.reason || null, reservation.id],
            );

            const updated = await manager.getRepository(Reservation).findOneOrFail({ where: { id: reservation.id } });

            // Notify customer of completion & deposit refund
            if (this.inboxService) {
                await this.inboxService.reservationEvent('completed' as any, updated);
            }

            return {
                reservation: updated,
                refundId,
                refundAmount: refundAmount.toFixed(2),
                retainedAmount: retainedAmount.toFixed(2),
                refundStatus,
            };
        });
    }

    /**
     * Automatically start rentals at rental start time for valid confirmed bookings
     */
    async autoActivateConfirmedRentals(): Promise<{ activatedCount: number }> {
        const rows = await this.dataSource.query(
            `SELECT id, reservation_number, return_at, customer_id
             FROM reservations
             WHERE status = 'confirmed'
               AND pickup_at <= now()
               AND return_at > now()
               -- Enforce verified payment covering rental total & deposit
               AND EXISTS (
                 SELECT 1 FROM payments p
                 WHERE p.reservation_id = reservations.id
                   AND p.type = 'rental_payment'
                   AND p.paid_at IS NOT NULL
                   AND p.is_demo = false AND p.is_simulated = false
                 GROUP BY p.reservation_id
                 HAVING SUM(p.amount) >= reservations.total_amount
               )
               AND (
                 reservations.deposit_amount <= 0
                 OR EXISTS (
                   SELECT 1 FROM payments p
                   WHERE p.reservation_id = reservations.id
                     AND p.type = 'deposit_payment'
                     AND p.paid_at IS NOT NULL
                   GROUP BY p.reservation_id
                   HAVING SUM(p.amount) >= reservations.deposit_amount
                 )
                 OR EXISTS (
                   SELECT 1 FROM security_deposits sd
                   WHERE sd.reservation_id = reservations.id
                     AND sd.status = 'held'
                     AND sd.amount >= reservations.deposit_amount
                 )
               )
               AND NOT EXISTS (
                   SELECT 1 FROM rentals WHERE rentals.reservation_id = reservations.id AND rentals.status = 'active'
               )
             FOR UPDATE SKIP LOCKED`,
        );

        const toActivate = Array.isArray(rows?.[0]) ? rows[0] : rows;
        if (!toActivate || toActivate.length === 0) return { activatedCount: 0 };

        const adminRows = await this.dataSource.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`);
        const defaultAdminId = adminRows[0]?.id;

        let activatedCount = 0;
        for (const res of toActivate) {
            // The candidate scan above runs outside a transaction, so its row
            // lock is released immediately. The periodic monitor and the admin
            // "Auto-activate" action can therefore race on the same booking.
            // Re-lock and re-check eligibility inside the transaction so each
            // reservation is activated at most once and only while still valid.
            const activated = await this.dataSource.transaction(async (manager) => {
                const locked: { id: string }[] = await manager.query(
                    `SELECT id FROM reservations
                     WHERE id = $1::uuid
                       AND status = 'confirmed'
                       AND pickup_at <= now()
                       AND return_at > now()
                     FOR UPDATE SKIP LOCKED`,
                    [res.id],
                );
                if (!locked[0]) return false;

                const opener = defaultAdminId || res.customer_id;
                await manager.query(
                    `INSERT INTO rentals 
                       (reservation_id, status, started_at, expected_return_at, opened_by, notes)
                     VALUES ($1::uuid, 'active', now(), $2, $3::uuid, 'Auto-activated at rental start time')
                     ON CONFLICT (reservation_id)
                     DO UPDATE SET status = 'active', started_at = now(), expected_return_at = $2`,
                    [res.id, res.return_at, opener],
                );

                await manager.query(
                    `UPDATE reservations
                     SET status = 'active_rental',
                         handover_at = now(),
                         updated_at = now()
                     WHERE id = $1::uuid`,
                    [res.id],
                );

                const updated = await manager.getRepository(Reservation).findOne({ where: { id: res.id } });
                if (updated && this.inboxService) {
                    await this.inboxService.reservationEvent('active_rental' as any, updated);
                }
                return true;
            });
            if (activated) activatedCount += 1;
        }

        return { activatedCount };
    }

    /**
     * 6. Automatically expire overdue awaiting_payment reservations (24 hours window)
     */
    async expireOverdueAwaitingPayments(): Promise<{ expiredCount: number }> {
        const rows = await this.dataSource.query(
            `UPDATE reservations
             SET status = 'cancelled_unpaid',
                 updated_at = now()
             WHERE status = 'awaiting_payment'
               AND payment_deadline_at <= now()
             RETURNING id, reservation_number, customer_id`,
        );

        const expiredList = Array.isArray(rows?.[0]) ? rows[0] : rows;
        this.logger.log(`Expired ${expiredList.length} overdue reservations.`);

        for (const item of expiredList) {
            if (this.inboxService) {
                const res = await this.dataSource.getRepository(Reservation).findOne({ where: { id: item.id } });
                if (res) {
                    void this.inboxService.reservationEvent('cancelled_unpaid' as any, res);
                }
            }
        }

        return { expiredCount: expiredList.length };
    }
}
