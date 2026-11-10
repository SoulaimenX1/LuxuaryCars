import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
    DataSource,
    EntityManager,
} from 'typeorm';
import { createLuxuryPdf, type LuxuryDocumentOptions } from './luxury-pdf.js';
import { vehicleImagesDir } from '../vehicles/vehicle-images.storage.js';
import { EmailOutboxService } from '../notifications/email-outbox.service.js';
import type { ManualPaymentDto } from './dto/manual-payment.dto.js';
import type { ReservationPaymentDto } from './dto/reservation-payment.dto.js';
import type {
    DepositHoldDto,
    DepositReceiptDto,
    DepositSettleDto,
} from './dto/deposit.dto.js';

type Database = DataSource | EntityManager;

type RentalInfo = {
    id: string;
    reservationId: string;
    status: string;
    customerId: string;
    reservationNumber: string;
    contractNumber: string;
    totalAmount: string;
    depositAmount: string;
    vehicleName: string;
    customerName: string;
    pickupAt: Date;
    returnAt: Date;
    dailyPrice?: string;
    rentalDays?: number;
    vehicleId?: string;
    vehiclePhoto?: string | null;
    brandName?: string;
    modelName?: string;
    licensePlate?: string;
    vin?: string;
    vehicleCategory?: string;
    pickupLocation?: string;
    dropoffLocation?: string;
    deliveryAddress?: string;
    customerEmail?: string;
    customerPhone?: string;
    customerAddress?: string;
    driverLicense?: string;
    extrasAmount?: string;
    discountAmount?: string;
    deliveryAmount?: string;
    promotionCode?: string;
    paidAt?: Date | null;
    stripePaymentIntentId?: string | null;
    isDemoPayment?: boolean | null;
    manualPaymentMethod?: string | null;
    paymentDeadlineAt?: Date | null;
    paymentUrl?: string | null;
    createdAt?: Date;
};

type ReservationInfo = {
    id: string;
    status: string;
    customerId: string;
    reservationNumber: string;
    totalAmount: string;
    depositAmount: string;
    vehicleName: string;
    customerName: string;
    pickupAt: Date;
    returnAt: Date;
    rentalId: string | null;
    rentalStatus: string | null;
    contractNumber: string | null;
    dailyPrice?: string;
    rentalDays?: number;
    vehicleId?: string;
    vehiclePhoto?: string | null;
    paymentDeadlineAt?: Date | null;
    paymentUrl?: string | null;
    paidAt?: Date | null;
    stripePaymentIntentId?: string | null;
    stripeRefundId?: string | null;
    depositRefundStatus?: string | null;
    depositRefundedAmount?: string | null;
    depositRetainedAmount?: string | null;
    depositRetentionReason?: string | null;
    agencyPaymentStatus?: string | null;
    agencyPaymentRequestedAt?: Date | null;
    agencyPaymentAgencyName?: string | null;
    agencyPaymentDecidedAt?: Date | null;
    agencyPaymentDecisionNotes?: string | null;
    isDemoPayment?: boolean | null;
    manualPaymentMethod?: string | null;
    createdAt?: Date;
};

type PaymentRow = {
    id: string;
    type: string;
    method: string;
    amount: string;
    currency: string;
    paidAt: Date;
    reference: string | null;
    provider?: string | null;
    notes?: string | null;
    isSimulated?: boolean;
    isDemo?: boolean;
};

type ChargeRow = {
    id: string;
    type: string;
    description: string;
    amount: string;
};

type DepositRow = {
    id: string;
    status: string;
    amount: string;
    retainedAmount: string;
    retentionReason: string | null;
};

const cents = (value: string | number): number =>
    Math.round(Number(value) * 100);

@Injectable()
export class FinanceService {
    constructor(
        private readonly dataSource: DataSource,
        @Optional() private readonly emailOutbox?: EmailOutboxService,
    ) {}

    private async rental(
        db: Database,
        id: string,
        customerId?: string,
        lock = false,
    ): Promise<RentalInfo> {
        const rows: RentalInfo[] = await db.query(
            `SELECT l.id, r.id AS "reservationId", l.status,
                    r.customer_id AS "customerId",
                    r.reservation_number AS "reservationNumber",
                    l.contract_number AS "contractNumber",
                    r.daily_price AS "dailyPrice",
                    r.rental_days AS "rentalDays",
                    r.payment_deadline_at AS "paymentDeadlineAt",
                    r.payment_url AS "paymentUrl",
                    r.paid_at AS "paidAt",
                    r.stripe_payment_intent_id AS "stripePaymentIntentId",
                    r.stripe_refund_id AS "stripeRefundId",
                    r.deposit_refund_status AS "depositRefundStatus",
                    r.deposit_refunded_amount AS "depositRefundedAmount",
                    r.deposit_retained_amount AS "depositRetainedAmount",
                    r.deposit_retention_reason AS "depositRetentionReason",
                    r.agency_payment_status AS "agencyPaymentStatus",
                    r.agency_payment_requested_at AS "agencyPaymentRequestedAt",
                    r.agency_payment_agency_name AS "agencyPaymentAgencyName",
                    r.agency_payment_decided_at AS "agencyPaymentDecidedAt",
                    r.agency_payment_decision_notes AS "agencyPaymentDecisionNotes",
                    r.is_demo_payment AS "isDemoPayment",
                    r.manual_payment_method AS "manualPaymentMethod",
                    r.created_at AS "createdAt",
                    r.extras_amount AS "extrasAmount",
                    r.discount_amount AS "discountAmount",
                    r.delivery_amount AS "deliveryAmount",
                    r.promotion_code AS "promotionCode",
                    v.id AS "vehicleId",
                    v.license_plate AS "licensePlate",
                    v.vin AS "vin",
                    cat.name AS "vehicleCategory",
                    b.name AS "brandName",
                    m.name AS "modelName",
                    pref.pickup_location_snapshot AS "pickupLocation",
                    pref.dropoff_location_snapshot AS "dropoffLocation",
                    pref.delivery_address AS "deliveryAddress",
                    u.email AS "customerEmail",
                    u.phone AS "customerPhone",
                    CONCAT_WS(', ', NULLIF(cp.address_line, ''), NULLIF(CONCAT_WS(' ', cp.postal_code, cp.city), ''), NULLIF(cp.country, '')) AS "customerAddress",
                    cp.license_number AS "driverLicense",
                    (SELECT vi.storage_path FROM vehicle_images vi WHERE vi.vehicle_id = v.id ORDER BY vi.is_primary DESC, vi.created_at ASC LIMIT 1) AS "vehiclePhoto",
                    r.total_amount AS "totalAmount",
                    r.deposit_amount AS "depositAmount",
                    CONCAT(b.name, ' ', m.name) AS "vehicleName",
                    CONCAT(u.first_name, ' ', u.last_name) AS "customerName",
                    r.pickup_at AS "pickupAt", r.return_at AS "returnAt"
             FROM rentals l
             JOIN reservations r ON r.id = l.reservation_id
             LEFT JOIN reservation_preferences pref ON pref.reservation_id = r.id
             JOIN users u ON u.id = r.customer_id
             LEFT JOIN customer_profiles cp ON cp.user_id = u.id
             JOIN vehicles v ON v.id = r.vehicle_id
             JOIN vehicle_models m ON m.id = v.model_id
             LEFT JOIN categories cat ON cat.id = m.category_id
             JOIN brands b ON b.id = m.brand_id
             WHERE l.id = $1::uuid
               ${customerId ? 'AND r.customer_id = $2::uuid' : ''}
               ${lock ? 'FOR UPDATE OF l' : ''}`,
            customerId ? [id, customerId] : [id],
        );
        if (!rows[0]) throw new NotFoundException('Rental not found');
        return rows[0];
    }

    private async reservation(
        db: Database,
        id: string,
        customerId?: string,
        lock = false,
    ): Promise<ReservationInfo> {
        const rows: ReservationInfo[] = await db.query(
            `SELECT r.id, r.status, r.customer_id AS "customerId",
                    r.reservation_number AS "reservationNumber",
                    r.total_amount AS "totalAmount",
                    r.deposit_amount AS "depositAmount",
                    CONCAT(b.name, ' ', m.name) AS "vehicleName",
                    CONCAT(u.first_name, ' ', u.last_name) AS "customerName",
                    r.pickup_at AS "pickupAt", r.return_at AS "returnAt",
                    l.id AS "rentalId", l.status AS "rentalStatus",
                    l.contract_number AS "contractNumber",
                    r.daily_price AS "dailyPrice",
                    r.rental_days AS "rentalDays",
                    r.payment_deadline_at AS "paymentDeadlineAt",
                    r.payment_url AS "paymentUrl",
                    r.paid_at AS "paidAt",
                    r.stripe_payment_intent_id AS "stripePaymentIntentId",
                    r.stripe_refund_id AS "stripeRefundId",
                    r.deposit_refund_status AS "depositRefundStatus",
                    r.deposit_refunded_amount AS "depositRefundedAmount",
                    r.deposit_retained_amount AS "depositRetainedAmount",
                    r.deposit_retention_reason AS "depositRetentionReason",
                    r.agency_payment_status AS "agencyPaymentStatus",
                    r.agency_payment_requested_at AS "agencyPaymentRequestedAt",
                    r.agency_payment_agency_name AS "agencyPaymentAgencyName",
                    r.agency_payment_decided_at AS "agencyPaymentDecidedAt",
                    r.agency_payment_decision_notes AS "agencyPaymentDecisionNotes",
                    r.is_demo_payment AS "isDemoPayment",
                    r.manual_payment_method AS "manualPaymentMethod",
                    r.created_at AS "createdAt",
                    v.id AS "vehicleId",
                    (SELECT vi.storage_path FROM vehicle_images vi WHERE vi.vehicle_id = v.id ORDER BY vi.is_primary DESC, vi.created_at ASC LIMIT 1) AS "vehiclePhoto"
             FROM reservations r
             JOIN users u ON u.id = r.customer_id
             JOIN vehicles v ON v.id = r.vehicle_id
             JOIN vehicle_models m ON m.id = v.model_id
             JOIN brands b ON b.id = m.brand_id
             LEFT JOIN rentals l ON l.reservation_id = r.id
             WHERE r.id = $1::uuid
               ${customerId ? 'AND r.customer_id = $2::uuid' : ''}
               ${lock ? 'FOR UPDATE OF r' : ''}`,
            customerId ? [id, customerId] : [id],
        );
        if (!rows[0]) throw new NotFoundException('Reservation not found');
        return rows[0];
    }

    async summary(rentalId: string, customerId?: string) {
        const rental = await this.rental(
            this.dataSource,
            rentalId,
            customerId,
        );
        return this.summaryForReservation(rental.reservationId, customerId);
    }

    async reservationSummary(reservationId: string, customerId?: string) {
        return this.summaryForReservation(reservationId, customerId);
    }

    async customerReservationSummaryByNumber(reservationNumber: string, customerId: string) {
        const rows: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM reservations
             WHERE reservation_number = $1
               AND customer_id = $2::uuid`,
            [reservationNumber.trim().toUpperCase(), customerId],
        );
        if (!rows[0]) throw new NotFoundException('Reservation not found');
        return this.summaryForReservation(rows[0].id, customerId);
    }

    async customerReservationSummaries(customerId: string) {
        const rows: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM reservations
             WHERE customer_id = $1::uuid
             ORDER BY created_at DESC`,
            [customerId],
        );
        return Promise.all(
            rows.map(({ id }) =>
                this.summaryForReservation(id, customerId),
            ),
        );
    }

    private async summaryForReservation(
        reservationId: string,
        customerId?: string,
    ) {
        const reservation = await this.reservation(
            this.dataSource,
            reservationId,
            customerId,
        );
        const rentalId = reservation.rentalId;
        const [payments, charges, deposits, invoices] = await Promise.all([
            this.dataSource.query(
                `SELECT id, type, method, amount, currency,
                        paid_at AS "paidAt", reference, provider, notes,
                        is_simulated AS "isSimulated", is_demo AS "isDemo"
                 FROM payments
                 WHERE reservation_id = $1::uuid
                 ORDER BY paid_at DESC, id DESC`,
                [reservationId],
            ) as Promise<PaymentRow[]>,
            this.dataSource.query(
                `SELECT id, type, description, amount
                 FROM additional_charges
                 WHERE rental_id = $1::uuid
                 ORDER BY created_at, id`,
                [rentalId],
            ) as Promise<ChargeRow[]>,
            this.dataSource.query(
                `SELECT id, status, amount,
                        retained_amount AS "retainedAmount",
                        retention_reason AS "retentionReason"
                 FROM security_deposits
                 WHERE reservation_id = $1::uuid`,
                [reservationId],
            ) as Promise<DepositRow[]>,
            this.dataSource.query(
                `SELECT id, invoice_number AS "invoiceNumber", status,
                        total_amount AS "totalAmount", issued_at AS "issuedAt"
                 FROM invoices
                 WHERE rental_id = $1::uuid
                 ORDER BY created_at DESC`,
                [rentalId],
            ),
        ]);

        const rentalChargesCents = charges.reduce(
            (sum, charge) => sum + cents(charge.amount),
            0,
        );

        // Filter valid payments: exclude rejected agency payments, unauthorized demos, and superseded duplicate Stripe sessions
        const validPayments: PaymentRow[] = [];

        for (const payment of payments) {
            const refLower = (payment.reference || '').toLowerCase();
            const isAgencyMethod =
                payment.method === 'manual_agency_demo' ||
                payment.provider === 'manual_agency_demo' ||
                payment.method === 'cash' ||
                payment.method === 'bank_transfer' ||
                payment.provider === 'manual_agency' ||
                refLower.startsWith('demo-agency') ||
                refLower.startsWith('manual-agency');

            // Exclude payments for rejected agency payment requests or cancelled reservations
            if (isAgencyMethod && reservation.agencyPaymentStatus === 'rejected') {
                continue;
            }
            if (reservation.status === 'cancelled_unpaid') {
                continue;
            }

            // Exclude unauthorized demo payments
            const isDemo = Boolean(payment.isDemo || payment.isSimulated) ||
                payment.method === 'manual_agency_demo' ||
                payment.provider === 'manual_agency_demo' ||
                refLower.startsWith('demo-agency');
            if (isDemo && reservation.agencyPaymentStatus !== 'approved') {
                continue;
            }

            // Exclude superseded duplicate Stripe payments when a confirmed stripe_payment_intent_id is recorded
            const isStripeMethod = payment.method === 'card' || payment.provider === 'stripe' || refLower.startsWith('pi_') || refLower.startsWith('cs_');
            if (isStripeMethod && reservation.stripePaymentIntentId) {
                const piId = reservation.stripePaymentIntentId;
                const isMatch = payment.reference === piId ||
                    payment.reference === `${piId}-deposit` ||
                    payment.reference?.startsWith(`${piId}_`);
                if (!isMatch) {
                    continue;
                }
            }

            validPayments.push(payment);
        }

        const collectedCents = validPayments.reduce((sum, payment) => {
            if (
                payment.type === 'rental_payment' ||
                payment.type === 'charge_payment'
            ) return sum + cents(payment.amount);
            if (payment.type === 'refund') return sum - cents(payment.amount);
            return sum;
        }, 0);
        const rentalCollectedCents = validPayments.reduce((sum, payment) => {
            if (payment.type === 'rental_payment') {
                return sum + cents(payment.amount);
            }
            if (payment.type === 'refund') {
                return sum - cents(payment.amount);
            }
            return sum;
        }, 0);
        const grossRentalPaymentsCents = validPayments.reduce((sum, payment) =>
            payment.type === 'rental_payment'
                ? sum + cents(payment.amount)
                : sum,
        0);
        const refundedCents = validPayments
            .filter(payment => payment.type === 'refund')
            .reduce((sum, payment) => sum + cents(payment.amount), 0);
        const agreedAmountCents = cents(reservation.totalAmount);
        const totalDueCents = agreedAmountCents + rentalChargesCents;
        const amountPaidCents = Math.max(0, collectedCents);
        const paymentStatus = grossRentalPaymentsCents > 0 &&
            rentalCollectedCents <= 0
            ? 'REFUNDED'
            : rentalCollectedCents >= agreedAmountCents
                ? 'PAID'
                : rentalCollectedCents > 0
                    ? 'PARTIALLY_PAID'
                    : 'PENDING';

        const depositPayments = validPayments.filter(
            payment => payment.type === 'deposit_payment',
        );
        const depositRefunds = validPayments.filter(
            payment => payment.type === 'deposit_refund',
        );
        const receivedCents = depositPayments.reduce(
            (sum, payment) => sum + cents(payment.amount),
            0,
        );
        const releasedCents = depositRefunds.reduce(
            (sum, payment) => sum + cents(payment.amount),
            0,
        );
        const requiredDepositCents = cents(reservation.depositAmount);
        const deposit = deposits[0];
        const isAgencyRejected = reservation.agencyPaymentStatus === 'rejected';
        const depositStatus = isAgencyRejected && deposit?.status === 'held'
            ? 'pending'
            : (deposit?.status ??
                (receivedCents >= requiredDepositCents && requiredDepositCents > 0
                    ? 'held'
                    : 'pending'));

        return {
            reservation: {
                id: reservation.id,
                reservationNumber: reservation.reservationNumber,
                status: reservation.status,
                customerId: reservation.customerId,
                customerName: reservation.customerName,
                vehicleName: reservation.vehicleName,
                pickupAt: reservation.pickupAt,
                returnAt: reservation.returnAt,
                totalAmount: reservation.totalAmount,
                depositAmount: reservation.depositAmount,
                dailyPrice: reservation.dailyPrice,
                rentalDays: reservation.rentalDays,
                vehicleId: reservation.vehicleId,
                vehiclePhoto: reservation.vehiclePhoto,
                paymentDeadlineAt: reservation.paymentDeadlineAt,
                paymentUrl: reservation.paymentUrl,
                paidAt: reservation.paidAt,
                stripeRefundId: reservation.stripeRefundId,
                depositRefundStatus: reservation.depositRefundStatus,
                depositRefundedAmount: reservation.depositRefundedAmount,
                depositRetainedAmount: reservation.depositRetainedAmount,
                depositRetentionReason: reservation.depositRetentionReason,
                agencyPaymentStatus: reservation.agencyPaymentStatus || 'none',
                agencyPaymentRequestedAt: reservation.agencyPaymentRequestedAt || null,
                agencyPaymentAgencyName: reservation.agencyPaymentAgencyName || null,
                agencyPaymentDecidedAt: reservation.agencyPaymentDecidedAt || null,
                agencyPaymentDecisionNotes: reservation.agencyPaymentDecisionNotes || null,
                isDemoPayment: reservation.isDemoPayment || false,
                manualPaymentMethod: reservation.manualPaymentMethod || null,
                createdAt: reservation.createdAt,
            },
            rental: rentalId
                ? {
                    id: rentalId,
                    status: reservation.rentalStatus,
                    contractNumber: reservation.contractNumber,
                    totalAmount: reservation.totalAmount,
                    depositAmount: reservation.depositAmount,
                dailyPrice: reservation.dailyPrice,
                rentalDays: reservation.rentalDays,
                vehicleId: reservation.vehicleId,
                vehiclePhoto: reservation.vehiclePhoto,
                paymentDeadlineAt: reservation.paymentDeadlineAt,
                paymentUrl: reservation.paymentUrl,
                paidAt: reservation.paidAt,
                stripeRefundId: reservation.stripeRefundId,
                depositRefundStatus: reservation.depositRefundStatus,
                depositRefundedAmount: reservation.depositRefundedAmount,
                depositRetainedAmount: reservation.depositRetainedAmount,
                depositRetentionReason: reservation.depositRetentionReason,
                agencyPaymentStatus: reservation.agencyPaymentStatus || 'none',
                agencyPaymentRequestedAt: reservation.agencyPaymentRequestedAt || null,
                agencyPaymentAgencyName: reservation.agencyPaymentAgencyName || null,
                agencyPaymentDecidedAt: reservation.agencyPaymentDecidedAt || null,
                agencyPaymentDecisionNotes: reservation.agencyPaymentDecisionNotes || null,
                isDemoPayment: reservation.isDemoPayment || false,
                manualPaymentMethod: reservation.manualPaymentMethod || null,
                createdAt: reservation.createdAt,
                }
                : null,
            payments,
            charges,
            deposit: {
                id: deposit?.id ?? null,
                status: depositStatus,
                amount: reservation.depositAmount,
                requiredAmount: (requiredDepositCents / 100).toFixed(2),
                receivedAmount: (receivedCents / 100).toFixed(2),
                outstandingAmount: (
                    Math.max(0, requiredDepositCents - receivedCents) / 100
                ).toFixed(2),
                releasedAmount: (releasedCents / 100).toFixed(2),
                refundedAmount: (releasedCents / 100).toFixed(2),
                retainedAmount: deposit?.retainedAmount ??
                    (depositStatus === 'retained' ||
                    depositStatus === 'partially_retained'
                        ? (
                            Math.max(0, receivedCents - releasedCents) / 100
                        ).toFixed(2)
                        : '0.00'),
                retentionReason: deposit?.retentionReason ?? null,
            },
            invoices,
            amountPaidEur: (amountPaidCents / 100).toFixed(2),
            outstandingEur: (
                Math.max(0, totalDueCents - amountPaidCents) / 100
            ).toFixed(2),
            paymentStatus,
            refundedEur: (refundedCents / 100).toFixed(2),
            note: 'Manually recorded payments only; no external payment is processed.',
        };
    }

    async recordReservationPayment(
        adminId: string,
        reservationId: string,
        dto: ReservationPaymentDto,
    ) {
        return this.dataSource.transaction(async manager => {
            const reservation = await this.reservation(
                manager,
                reservationId,
                undefined,
                true,
            );
            if (
                dto.type === 'rental_payment' &&
                !['confirmed', 'converted'].includes(reservation.status)
            ) {
                throw new ConflictException(
                    'Payments can be recorded only for confirmed reservations',
                );
            }
            if (reservation.rentalStatus === 'closed') {
                throw new ConflictException(
                    'Closed rentals cannot receive manual changes',
                );
            }
            return this.appendPayment(
                manager,
                adminId,
                reservation,
                dto,
                reservation.rentalId,
            );
        });
    }

    async recordPayment(
        adminId: string,
        rentalId: string,
        dto: ManualPaymentDto,
    ) {
        return this.dataSource.transaction(async manager => {
            const rental = await this.rental(
                manager,
                rentalId,
                undefined,
                true,
            );
            if (rental.status === 'closed') {
                throw new ConflictException(
                    'Closed rentals cannot receive manual changes',
                );
            }
            const reservation = await this.reservation(
                manager,
                rental.reservationId,
                undefined,
                true,
            );
            return this.appendPayment(
                manager,
                adminId,
                reservation,
                dto,
                rental.id,
            );
        });
    }

    private async appendPayment(
        manager: EntityManager,
        adminId: string,
        reservation: ReservationInfo,
        dto: ManualPaymentDto | ReservationPaymentDto,
        rentalId: string | null,
    ) {
        const reference = dto.reference.trim();
        const duplicate: { id: string }[] = await manager.query(
            `SELECT id FROM payments
             WHERE reservation_id = $1::uuid
               AND type = $2 AND reference = $3
             LIMIT 1`,
            [reservation.id, dto.type, reference],
        );
        if (duplicate.length) {
            throw new ConflictException(
                'This payment reference has already been recorded',
            );
        }

        const paymentRows: { type: string; amount: string }[] =
            await manager.query(
                `SELECT type, amount FROM payments
                 WHERE reservation_id = $1::uuid
                   AND type IN ('rental_payment', 'charge_payment', 'refund')`,
                [reservation.id],
            );
        const netPaidCents = paymentRows.reduce(
            (sum, payment) =>
                sum + (payment.type === 'refund' ? -1 : 1) *
                    cents(payment.amount),
            0,
        );
        const charges: { amount: string }[] = rentalId
            ? await manager.query(
                `SELECT amount FROM additional_charges
                 WHERE rental_id = $1::uuid`,
                [rentalId],
            )
            : [];
        const dueCents = cents(reservation.totalAmount) +
            charges.reduce((sum, charge) => sum + cents(charge.amount), 0);
        const amountCents = cents(dto.amount);

        if (dto.type === 'refund' && amountCents > netPaidCents) {
            throw new BadRequestException(
                'Manual refund exceeds recorded rental and charge payments',
            );
        }
        if (
            dto.type !== 'refund' &&
            amountCents > Math.max(0, dueCents - netPaidCents)
        ) {
            throw new BadRequestException(
                'Payment exceeds the outstanding rental balance',
            );
        }

        const rows: { id: string }[] = await manager.query(
            `INSERT INTO payments
                (reservation_id, rental_id, type, method, amount,
                 reference, recorded_by, notes)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8)
             RETURNING id`,
            [
                reservation.id,
                rentalId,
                dto.type,
                dto.method,
                (amountCents / 100).toFixed(2),
                reference,
                adminId,
                dto.notes?.trim() || null,
            ],
        );
        await this.audit(manager, adminId, 'FINANCIAL_PAYMENT_RECORDED', 'payment', rows[0].id, {
            reservationId: reservation.id,
            rentalId,
            type: dto.type,
            method: dto.method,
            amount: (amountCents / 100).toFixed(2),
            currency: 'EUR',
            reference,
        });
        return {
            paymentId: rows[0].id,
            recorded: true,
            processedExternally: false,
        };
    }

    async recordDepositReceipt(
        adminId: string,
        reservationId: string,
        dto: DepositReceiptDto,
    ) {
        return this.dataSource.transaction(async manager => {
            const reservation = await this.reservation(
                manager,
                reservationId,
                undefined,
                true,
            );
            if (
                !['confirmed', 'converted'].includes(reservation.status) ||
                reservation.rentalStatus === 'closed'
            ) {
                throw new ConflictException(
                    'A deposit receipt requires a confirmed, unsettled reservation',
                );
            }
            const requiredCents = cents(reservation.depositAmount);
            const amountCents = cents(dto.amount);
            if (requiredCents <= 0) {
                throw new ConflictException(
                    'No security deposit is required for this reservation',
                );
            }
            return this.appendDepositReceipt(
                manager,
                adminId,
                reservation,
                amountCents,
                dto.method,
                dto.reference,
            );
        });
    }

    private async appendDepositReceipt(
        manager: EntityManager,
        adminId: string,
        reservation: ReservationInfo,
        amountCents: number,
        method: DepositReceiptDto['method'],
        rawReference: string,
    ) {
        const reference = rawReference.trim();
        const requiredCents = cents(reservation.depositAmount);
        const deposits: DepositRow[] = await manager.query(
            `SELECT id, status, amount, retained_amount AS "retainedAmount",
                    retention_reason AS "retentionReason"
             FROM security_deposits
             WHERE reservation_id = $1::uuid
             FOR UPDATE`,
            [reservation.id],
        );
        if (
            deposits[0] &&
            ['released', 'partially_retained', 'retained'].includes(
                deposits[0].status,
            )
        ) {
            throw new ConflictException(
                'A settled security deposit cannot receive further funds',
            );
        }

        const receivedRows: { type: string; amount: string }[] =
            await manager.query(
                `SELECT type, amount FROM payments
                 WHERE reservation_id = $1::uuid
                   AND type IN ('deposit_payment', 'deposit_refund')`,
                [reservation.id],
            );
        const receivedCents = receivedRows.reduce(
            (sum, payment) =>
                sum + (payment.type === 'deposit_refund' ? -1 : 1) *
                    cents(payment.amount),
            0,
        );
        const outstandingCents = Math.max(0, requiredCents - receivedCents);
        if (amountCents > outstandingCents) {
            throw new BadRequestException(
                'Deposit receipt exceeds the outstanding security deposit',
            );
        }
        const duplicate: { id: string }[] = await manager.query(
            `SELECT id FROM payments
             WHERE reservation_id = $1::uuid
               AND type = 'deposit_payment' AND reference = $2
             LIMIT 1`,
            [reservation.id, reference],
        );
        if (duplicate.length) {
            throw new ConflictException(
                'This deposit reference has already been recorded',
            );
        }

        const updatedReceivedCents = receivedCents + amountCents;
        if (!deposits[0]) {
            await manager.query(
                `INSERT INTO security_deposits
                    (reservation_id, rental_id, amount, status, held_at)
                 VALUES ($1::uuid, $2::uuid, $3, $4::deposit_status,
                         CASE WHEN $4::deposit_status = 'held'::deposit_status
                              THEN now() ELSE NULL END)`,
                [
                    reservation.id,
                    reservation.rentalId,
                    (requiredCents / 100).toFixed(2),
                    updatedReceivedCents === requiredCents ? 'held' : 'pending',
                ],
            );
        } else {
            await manager.query(
                `UPDATE security_deposits
                 SET rental_id = COALESCE(rental_id, $2::uuid),
                     status = $3::deposit_status,
                     held_at = CASE WHEN $3::deposit_status = 'held'::deposit_status
                                    THEN COALESCE(held_at, now())
                                    ELSE held_at END
                 WHERE reservation_id = $1::uuid`,
                [
                    reservation.id,
                    reservation.rentalId,
                    updatedReceivedCents === requiredCents ? 'held' : 'pending',
                ],
            );
        }

        const rows: { id: string }[] = await manager.query(
            `INSERT INTO payments
                (reservation_id, rental_id, type, method, amount,
                 reference, recorded_by)
             VALUES ($1::uuid, $2::uuid, 'deposit_payment', $3, $4, $5, $6::uuid)
             RETURNING id`,
            [
                reservation.id,
                reservation.rentalId,
                method,
                (amountCents / 100).toFixed(2),
                reference,
                adminId,
            ],
        );
        await this.audit(manager, adminId, 'SECURITY_DEPOSIT_RECEIVED', 'payment', rows[0].id, {
            reservationId: reservation.id,
            rentalId: reservation.rentalId,
            amount: (amountCents / 100).toFixed(2),
            requiredAmount: (requiredCents / 100).toFixed(2),
            method,
            reference,
            resultingStatus: updatedReceivedCents === requiredCents ? 'held' : 'pending',
        });
        return {
            paymentId: rows[0].id,
            receivedEur: (amountCents / 100).toFixed(2),
            outstandingEur: (
                Math.max(0, requiredCents - updatedReceivedCents) / 100
            ).toFixed(2),
            processedExternally: false,
        };
    }

    async holdDeposit(
        adminId: string,
        rentalId: string,
        dto: DepositHoldDto,
    ) {
        return this.dataSource.transaction(async manager => {
            const rental = await this.rental(
                manager,
                rentalId,
                undefined,
                true,
            );
            if (rental.status !== 'active') {
                throw new ConflictException(
                    'Hold deposit during an active rental',
                );
            }
            const reservation = await this.reservation(
                manager,
                rental.reservationId,
                undefined,
                true,
            );
            const received: { type: string; amount: string }[] =
                await manager.query(
                    `SELECT type, amount FROM payments
                     WHERE reservation_id = $1::uuid
                       AND type IN ('deposit_payment', 'deposit_refund')`,
                    [reservation.id],
                );
            const receivedCents = received.reduce(
                (sum, payment) =>
                    sum + (payment.type === 'deposit_refund' ? -1 : 1) *
                        cents(payment.amount),
                0,
            );
            const outstandingCents = Math.max(
                0,
                cents(reservation.depositAmount) - receivedCents,
            );
            if (outstandingCents === 0) {
                throw new ConflictException(
                    'Security deposit is already fully recorded',
                );
            }
            return this.appendDepositReceipt(
                manager,
                adminId,
                reservation,
                outstandingCents,
                dto.method,
                dto.reference,
            );
        });
    }

    async settleDeposit(
        adminId: string,
        rentalId: string,
        dto: DepositSettleDto,
    ) {
        return this.dataSource.transaction(async manager => {
            const rental = await this.rental(
                manager,
                rentalId,
                undefined,
                true,
            );
            if (rental.status !== 'returned') {
                throw new ConflictException(
                    'Vehicle must be returned before settling deposit',
                );
            }
            const reservation = await this.reservation(
                manager,
                rental.reservationId,
                undefined,
                true,
            );
            const rows: DepositRow[] = await manager.query(
                `SELECT id, amount, status,
                        retained_amount AS "retainedAmount",
                        retention_reason AS "retentionReason"
                 FROM security_deposits
                 WHERE reservation_id = $1::uuid
                 FOR UPDATE`,
                [reservation.id],
            );
            const deposit = rows[0];
            if (!deposit || deposit.status !== 'held') {
                throw new ConflictException('Held deposit not found');
            }
            const amountCents = cents(deposit.amount);
            const retainedCents = cents(dto.retainedAmount);
            if (retainedCents > amountCents) {
                throw new BadRequestException(
                    'Retained amount exceeds deposit',
                );
            }
            if (retainedCents > 0 && !dto.reason?.trim()) {
                throw new BadRequestException('Retention reason required');
            }
            const refundCents = amountCents - retainedCents;
            const reference = dto.reference.trim();
            if (refundCents > 0) {
                const duplicate: { id: string }[] = await manager.query(
                    `SELECT id FROM payments
                     WHERE reservation_id = $1::uuid
                       AND type = 'deposit_refund' AND reference = $2
                     LIMIT 1`,
                    [reservation.id, reference],
                );
                if (duplicate.length) {
                    throw new ConflictException(
                        'This deposit refund reference has already been recorded',
                    );
                }
            }
            const status = retainedCents === amountCents
                ? 'retained'
                : retainedCents > 0
                    ? 'partially_retained'
                    : 'released';
            await manager.query(
                `UPDATE security_deposits
                 SET status = $2, retained_amount = $3,
                     retention_reason = $4, released_at = now()
                 WHERE reservation_id = $1::uuid`,
                [
                    reservation.id,
                    status,
                    (retainedCents / 100).toFixed(2),
                    dto.reason?.trim() || null,
                ],
            );
            let refundId: string | null = null;
            if (refundCents > 0) {
                const refunds: { id: string }[] = await manager.query(
                    `INSERT INTO payments
                        (reservation_id, rental_id, type, method, amount,
                         reference, recorded_by)
                     VALUES ($1::uuid, $2::uuid, 'deposit_refund',
                             $3, $4, $5, $6::uuid)
                     RETURNING id`,
                    [
                        reservation.id,
                        rental.id,
                        dto.method,
                        (refundCents / 100).toFixed(2),
                        reference,
                        adminId,
                    ],
                );
                refundId = refunds[0].id;
            }
            await this.audit(manager, adminId, 'SECURITY_DEPOSIT_SETTLED', 'security_deposit', deposit.id, {
                reservationId: reservation.id,
                rentalId,
                status,
                requiredAmount: (amountCents / 100).toFixed(2),
                retainedAmount: (retainedCents / 100).toFixed(2),
                refundedAmount: (refundCents / 100).toFixed(2),
                reason: dto.reason?.trim() || null,
                reference,
                refundPaymentId: refundId,
            });
            return {
                settled: true,
                status,
                retainedEur: (retainedCents / 100).toFixed(2),
                refundEur: (refundCents / 100).toFixed(2),
                processedExternally: false,
            };
        });
    }

    async addCharge(
        adminId: string,
        rentalId: string,
        input: {
            type: 'damage' | 'cleaning' | 'other';
            description: string;
            amount: number;
            inspectionDamageId?: string;
        },
    ) {
        return this.dataSource.transaction(async manager => {
            const rental = await this.rental(
                manager,
                rentalId,
                undefined,
                true,
            );
            if (rental.status !== 'returned') {
                throw new ConflictException(
                    'Charges can be finalised after vehicle return and before closure',
                );
            }
            const invoices: unknown[] = await manager.query(
                `SELECT id FROM invoices
                 WHERE rental_id = $1 AND status = 'issued' LIMIT 1`,
                [rentalId],
            );
            if (invoices.length) {
                throw new ConflictException(
                    'Issued invoices cannot be changed',
                );
            }
            if (input.inspectionDamageId) {
                if (input.type !== 'damage') {
                    throw new BadRequestException(
                        'Inspection damage references require a damage charge',
                    );
                }
                const refs: unknown[] = await manager.query(
                    `SELECT d.id FROM inspection_damages d
                     JOIN inspections i ON i.id = d.inspection_id
                     WHERE d.id = $1::uuid AND i.rental_id = $2::uuid
                       AND i.type = 'return'
                       AND EXISTS (
                         SELECT 1
                         FROM return_damages rd
                         JOIN vehicle_returns vr ON vr.id = rd.return_id
                         WHERE vr.rental_id = $2::uuid
                           AND rd.vehicle_zone = d.vehicle_zone
                           AND rd.description = d.description
                           AND rd.pre_existing = false
                       )`,
                    [input.inspectionDamageId, rentalId],
                );
                if (!refs.length) {
                    throw new BadRequestException(
                        'Damage is not a newly documented finding for this rental',
                    );
                }
                const duplicates: { id: string }[] = await manager.query(
                    `SELECT id FROM additional_charges
                     WHERE inspection_damage_id = $1::uuid
                     LIMIT 1`,
                    [input.inspectionDamageId],
                );
                if (duplicates.length) {
                    throw new ConflictException(
                        'A charge has already been recorded for this inspection finding',
                    );
                }
            } else if (input.type === 'damage') {
                throw new BadRequestException(
                    'Damage charges must reference a documented return finding',
                );
            }
            const rows: { id: string }[] = await manager.query(
                `INSERT INTO additional_charges
                    (rental_id, type, description, amount,
                     inspection_damage_id, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id`,
                [
                    rentalId,
                    input.type,
                    input.description.trim(),
                    input.amount,
                    input.inspectionDamageId ?? null,
                    adminId,
                ],
            );
            await this.audit(manager, adminId, 'FINANCIAL_CHARGE_RECORDED', 'additional_charge', rows[0].id, {
                rentalId,
                reservationId: rental.reservationId,
                type: input.type,
                description: input.description.trim(),
                amount: input.amount.toFixed(2),
                inspectionDamageId: input.inspectionDamageId ?? null,
            });
            return { chargeId: rows[0].id, recorded: true };
        });
    }

    async issueInvoice(adminId: string, rentalId: string) {
        const result = await this.dataSource.transaction(async manager => {
            const rental = await this.rental(
                manager,
                rentalId,
                undefined,
                true,
            );
            if (rental.status === 'active') {
                throw new ConflictException(
                    'Return the vehicle before issuing a final invoice',
                );
            }
            const existing: { id: string }[] = await manager.query(
                `SELECT id FROM invoices
                 WHERE rental_id = $1 AND status = 'issued'
                 LIMIT 1 FOR UPDATE`,
                [rentalId],
            );
            if (existing[0]) {
                throw new ConflictException('Invoice already issued');
            }
            const extra: {
                type: string;
                description: string;
                amount: string;
                id: string;
            }[] = await manager.query(
                `SELECT id, type, description, amount
                 FROM additional_charges
                 WHERE rental_id = $1
                 ORDER BY created_at`,
                [rentalId],
            );
            const baseCents = cents(rental.totalAmount);
            const totalCents = extra.reduce(
                (sum, charge) => sum + cents(charge.amount),
                baseCents,
            );
            const number: { value: string }[] = await manager.query(
                `SELECT ('INV-' || to_char(now(), 'YYYY') || '-' ||
                        lpad(nextval('invoice_number_seq')::text, 6, '0')) AS value`,
            );
            const invoices: { id: string }[] = await manager.query(
                `INSERT INTO invoices
                    (rental_id, invoice_number, status, subtotal,
                     tax_rate, tax_amount, total_amount, issued_at, issued_by)
                 VALUES ($1, $2, 'issued', $3, 0, 0, $3, now(), $4)
                 RETURNING id`,
                [
                    rentalId,
                    number[0].value,
                    (totalCents / 100).toFixed(2),
                    adminId,
                ],
            );
            const id = invoices[0].id;
            await manager.query(
                `INSERT INTO invoice_items
                    (invoice_id, description, quantity, unit_price)
                 VALUES ($1,
                         'Rental service (including selected extras and discounts)',
                         1, $2)`,
                [id, rental.totalAmount],
            );
            for (const charge of extra) {
                await manager.query(
                    `INSERT INTO invoice_items
                        (invoice_id, description, quantity, unit_price,
                         additional_charge_id)
                     VALUES ($1, $2, 1, $3, $4)`,
                    [id, charge.description, charge.amount, charge.id],
                );
            }
            await this.audit(manager, adminId, 'FINANCIAL_INVOICE_ISSUED', 'invoice', id, {
                rentalId,
                reservationId: rental.reservationId,
                invoiceNumber: number[0].value,
                totalAmount: (totalCents / 100).toFixed(2),
            });
            return {
                invoiceId: id,
                invoiceNumber: number[0].value,
                totalAmount: (totalCents / 100).toFixed(2),
                note: 'Prototype document; local tax/legal compliance must be reviewed before commercial use.',
            };
        });

        if (this.emailOutbox) {
            await this.emailOutbox.safelyNotifyInvoiceIssued(
                rentalId,
                result.invoiceNumber,
                result.totalAmount,
            );
        }

        return result;
    }

    async document(
        rentalId: string,
        type: 'contract' | 'invoice',
        customerId?: string,
    ) {
        const rental = await this.rental(
            this.dataSource,
            rentalId,
            customerId,
        );

        let imageBuffer: Buffer | null = null;
        try {
            const dir = vehicleImagesDir();
            // Only embed the rented vehicle's own photo. Never substitute a
            // different car's image: the document would misrepresent the vehicle.
            if (rental.vehiclePhoto) {
                const photoFile = basename(rental.vehiclePhoto);
                imageBuffer = await readFile(join(dir, photoFile));
            }
            if (!imageBuffer) {
                const files = await readdir(dir).catch(() => []);
                const cleanPlate = (rental.licensePlate || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const cleanId = (rental.vehicleId || '').toLowerCase();
                const matched = files.find(f => {
                    const fLow = f.toLowerCase();
                    return (cleanPlate && fLow.includes(cleanPlate)) || (cleanId && fLow.includes(cleanId));
                });
                if (matched) {
                    imageBuffer = await readFile(join(dir, matched));
                }
            }
        } catch {
            // Repli sans image si indisponible
            imageBuffer = null;
        }

        if (type === 'invoice') {
            const invoices: {
                id: string;
                invoiceNumber: string;
                subtotal: string;
                taxRate: string;
                taxAmount: string;
                totalAmount: string;
                issuedAt: Date;
            }[] = await this.dataSource.query(
                `SELECT id,
                        invoice_number AS "invoiceNumber",
                        subtotal,
                        tax_rate AS "taxRate",
                        tax_amount AS "taxAmount",
                        total_amount AS "totalAmount",
                        issued_at AS "issuedAt"
                 FROM invoices
                 WHERE rental_id = $1 AND status = 'issued'
                 ORDER BY issued_at DESC LIMIT 1`,
                [rentalId],
            );
            if (!invoices[0]) {
                throw new NotFoundException('Issued invoice not found');
            }
            const inv = invoices[0];

            // Payments reconciliation for balance due
            const payments: PaymentRow[] = await this.dataSource.query(
                `SELECT id, type, method, amount, currency, paid_at AS "paidAt", reference, provider
                 FROM payments
                 WHERE reservation_id = $1::uuid
                 ORDER BY paid_at DESC`,
                [rental.reservationId],
            );

            const collectedCents = payments.reduce((sum, p) => {
                if (p.type === 'rental_payment' || p.type === 'charge_payment') {
                    return sum + cents(p.amount);
                }
                if (p.type === 'refund') {
                    return sum - cents(p.amount);
                }
                return sum;
            }, 0);

            const invTotalCents = cents(inv.totalAmount);
            const amountPaidCents = Math.max(0, collectedCents);
            const balanceDueCents = Math.max(0, invTotalCents - amountPaidCents);
            const amountPaidStr = (amountPaidCents / 100).toFixed(2);
            const balanceDueStr = (balanceDueCents / 100).toFixed(2);

            const latestPayment = payments.find(p => p.type === 'rental_payment');
            const paymentMethodStr = latestPayment?.method
                ? (latestPayment.method.toUpperCase().replace(/_/g, ' ') + (latestPayment.provider === 'stripe' ? ' (Stripe)' : ''))
                : (rental.manualPaymentMethod ? rental.manualPaymentMethod.toUpperCase() : 'Card Online / Stripe');
            const paymentRefStr = latestPayment?.reference || rental.stripePaymentIntentId || undefined;
            const paymentStatusStr = balanceDueCents <= 0 ? 'PAID & RECONCILED' : amountPaidCents > 0 ? 'PARTIALLY PAID' : 'PENDING SETTLEMENT';

            const invoiceOptions: LuxuryDocumentOptions = {
                invoiceNumber: inv.invoiceNumber,
                contractNumber: rental.contractNumber,
                reservationNumber: rental.reservationNumber,
                issuedAt: inv.issuedAt ? new Date(inv.issuedAt).toISOString() : new Date().toISOString(),
                customerName: rental.customerName,
                customerEmail: rental.customerEmail,
                customerPhone: rental.customerPhone,
                customerAddress: rental.customerAddress || rental.deliveryAddress || 'Budapest Metropolitan Area',
                vehicleName: rental.vehicleName,
                brandName: rental.brandName,
                modelName: rental.modelName,
                licensePlate: rental.licensePlate,
                vin: rental.vin,
                vehicleCategory: rental.vehicleCategory || 'Prestige & High-Performance',
                pickupLocation: rental.pickupLocation || 'Budapest Flagship Showroom',
                dropoffLocation: rental.dropoffLocation || 'Budapest Flagship Showroom',
                imageBuffer,
                pickupAt: rental.pickupAt ? new Date(rental.pickupAt).toISOString() : undefined,
                returnAt: rental.returnAt ? new Date(rental.returnAt).toISOString() : undefined,
                dailyPrice: rental.dailyPrice,
                rentalDays: rental.rentalDays,
                subtotalAmount: inv.subtotal,
                taxRate: inv.taxRate || '27.00',
                taxAmount: inv.taxAmount,
                totalAmount: inv.totalAmount,
                amountPaid: amountPaidStr,
                balanceDue: balanceDueStr,
                depositAmount: rental.depositAmount,
                paymentStatus: paymentStatusStr,
                paymentMethod: paymentMethodStr,
                paymentReference: paymentRefStr,
                paidAt: rental.paidAt ? new Date(rental.paidAt).toISOString() : undefined,
                deliveryFee: rental.deliveryAmount && Number(rental.deliveryAmount) > 0 ? rental.deliveryAmount : undefined,
                discountAmount: rental.discountAmount && Number(rental.discountAmount) > 0 ? rental.discountAmount : undefined,
                extrasAmount: rental.extrasAmount && Number(rental.extrasAmount) > 0 ? rental.extrasAmount : undefined,
                promotionCode: rental.promotionCode || undefined,
                isDemo: Boolean(rental.isDemoPayment),
                footerNote: 'LUXUAR AUTOMOTIVE ATELIER KFT. · Showroom: Budapest Flagship Showroom · Concierge: luxurycarsrentcars@gmail.com',
            };

            const invoiceRows = [
                `Customer: ${rental.customerName}`,
                `Vehicle: ${rental.vehicleName}`,
                `Reservation: ${rental.reservationNumber}`,
                `Contract: ${rental.contractNumber}`,
                `Invoice number: ${inv.invoiceNumber}`,
                `Pickup: ${new Date(rental.pickupAt).toISOString().slice(0, 10)}`,
                `Return: ${new Date(rental.returnAt).toISOString().slice(0, 10)}`,
                `Rental amount EUR: ${inv.totalAmount}`,
                `Security deposit EUR: ${rental.depositAmount}`,
            ];

            return createLuxuryPdf(
                'COMMERCIAL RENTAL INVOICE',
                'Official Commercial Rental Invoice & Fiscal Settlement Record',
                invoiceRows,
                invoiceOptions,
            );
        }

        // Contract
        const contractOptions: LuxuryDocumentOptions = {
            contractNumber: rental.contractNumber,
            reservationNumber: rental.reservationNumber,
            customerName: rental.customerName,
            customerEmail: rental.customerEmail,
            customerPhone: rental.customerPhone,
            customerAddress: rental.customerAddress || rental.deliveryAddress || 'Budapest Metropolitan Area',
            authorizedDrivers: `${rental.customerName}${rental.driverLicense ? ` (Licence: ${rental.driverLicense})` : ' (Verified Driver Dossier on File)'}`,
            vehicleName: rental.vehicleName,
            brandName: rental.brandName,
            modelName: rental.modelName,
            licensePlate: rental.licensePlate,
            vin: rental.vin,
            vehicleCategory: rental.vehicleCategory || 'Prestige & High-Performance',
            pickupLocation: rental.pickupLocation || 'Budapest Flagship Showroom',
            dropoffLocation: rental.dropoffLocation || 'Budapest Flagship Showroom',
            imageBuffer,
            pickupAt: rental.pickupAt ? new Date(rental.pickupAt).toISOString() : undefined,
            returnAt: rental.returnAt ? new Date(rental.returnAt).toISOString() : undefined,
            dailyPrice: rental.dailyPrice,
            rentalDays: rental.rentalDays,
            totalAmount: rental.totalAmount,
            depositAmount: rental.depositAmount,
            deliveryFee: rental.deliveryAmount && Number(rental.deliveryAmount) > 0 ? rental.deliveryAmount : undefined,
            discountAmount: rental.discountAmount && Number(rental.discountAmount) > 0 ? rental.discountAmount : undefined,
            extrasAmount: rental.extrasAmount && Number(rental.extrasAmount) > 0 ? rental.extrasAmount : undefined,
            mileageAllowance: '250 km / day (Tier 1 Included)',
            fuelPolicy: 'Full-to-Full (Premium 98+ RON / 80%+ SOC)',
            departureInspection: 'Digital Handover Protocol Certified (0 Pre-existing Damage)',
            handoverCondition: 'Factory Pristine & Showroom Sanitized',
            paymentStatus: rental.status === 'active'
                ? 'Active & In Custody'
                : rental.status === 'returned'
                ? 'Returned & Reconciled'
                : 'Verified & Closed',
            signatureStatus: 'Digitally Executed & Showroom Verified',
            isDemo: Boolean(rental.isDemoPayment),
            footerNote: 'LUXUAR AUTOMOTIVE ATELIER KFT. · Showroom: Budapest Flagship Showroom · Concierge: luxurycarsrentcars@gmail.com',
        };

        const contractRows = [
            `Customer: ${rental.customerName}`,
            `Vehicle: ${rental.vehicleName}`,
            `Reservation: ${rental.reservationNumber}`,
            `Contract: ${rental.contractNumber}`,
            `Pickup: ${new Date(rental.pickupAt).toISOString().slice(0, 10)}`,
            `Return: ${new Date(rental.returnAt).toISOString().slice(0, 10)}`,
            `Rental amount EUR: ${rental.totalAmount}`,
            `Security deposit EUR: ${rental.depositAmount}`,
            'Vehicle condition is recorded at handover and return.',
            'The customer remains responsible for agreed charges per rental policy.',
            'Additional protection, if selected, is subject to separate terms.',
        ];

        return createLuxuryPdf(
            'OFFICIAL RENTAL AGREEMENT',
            'Official Custody & High-Performance Vehicle Hire Agreement',
            contractRows,
            contractOptions,
        );
    }

    async paymentReceipt(
        paymentId: string,
        customerId?: string,
    ) {
        const rows: {
            id: string;
            reservationId: string;
            customerId: string;
            reservationNumber: string;
            customerName: string;
            vehicleName: string;
            type: string;
            method: string;
            amount: string;
            currency: string;
            paidAt: Date;
            reference: string | null;
    provider?: string | null;
    notes?: string | null;
    isSimulated?: boolean;
    isDemo?: boolean;
    resIsDemo?: boolean;
        }[] = await this.dataSource.query(
            `SELECT p.id, p.reservation_id AS "reservationId",
                    r.customer_id AS "customerId",
                    r.reservation_number AS "reservationNumber",
                    CONCAT(u.first_name, ' ', u.last_name) AS "customerName",
                    CONCAT(b.name, ' ', m.name) AS "vehicleName",
                    p.type, p.method, p.amount, p.currency,
                    p.paid_at AS "paidAt", p.reference,
                    p.provider, p.notes,
                    p.is_simulated AS "isSimulated",
                    p.is_demo AS "isDemo",
                    r.is_demo_payment AS "resIsDemo"
             FROM payments p
             JOIN reservations r ON r.id = p.reservation_id
             JOIN users u ON u.id = r.customer_id
             JOIN vehicles v ON v.id = r.vehicle_id
             JOIN vehicle_models m ON m.id = v.model_id
             JOIN brands b ON b.id = m.brand_id
             WHERE p.id = $1::uuid
               ${customerId ? 'AND r.customer_id = $2::uuid' : ''}`,
            customerId ? [paymentId, customerId] : [paymentId],
        );
        const payment = rows[0];
        if (!payment) throw new NotFoundException('Payment receipt not found');

        const options = {
            contractNumber: payment.reference ?? undefined,
            reservationNumber: payment.reservationNumber,
            customerName: payment.customerName,
            vehicleName: payment.vehicleName,
            totalAmount: `${payment.amount} ${payment.currency}`,
            paymentStatus: payment.type.replace('_', ' ').toUpperCase(),
            pickupAt: payment.paidAt ? new Date(payment.paidAt).toISOString() : undefined,
            footerNote: 'LUXUAR · OFFICIAL PAYMENT RECEIPT · CONCIERGE: luxurycarsrentcars@gmail.com',
        };

        return createLuxuryPdf(
            'OFFICIAL PAYMENT RECEIPT',
            'Verified Payment Transaction Record',
            [
                `Customer: ${payment.customerName}`,
                `Vehicle: ${payment.vehicleName}`,
                `Reservation: ${payment.reservationNumber}`,
                `Transaction type: ${payment.type.replace('_', ' ').toUpperCase()}`,
                `Payment method: ${payment.method.toUpperCase()} (${payment.provider === 'stripe' ? 'Stripe Gateway' : 'Verified Counter Payment'})`,
                `Amount: ${payment.amount} ${payment.currency}`,
                `Reference: ${payment.reference ?? '—'}`,
                `Recorded at: ${new Date(payment.paidAt).toISOString()}`,
                'Status: Officially Settled and Reconciled',
            ],
            options,
        );
    }

    async getFinanceOverview() {
        // 1. Payment Requests & Decision History
        const requests = await this.dataSource.query(`
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
                v.license_plate AS "licensePlate",
                CONCAT(dec.first_name, ' ', dec.last_name) AS "decidedByName"
            FROM reservations r
            JOIN users u ON u.id = r.customer_id
            JOIN vehicles v ON v.id = r.vehicle_id
            JOIN vehicle_models m ON m.id = v.model_id
            JOIN brands b ON b.id = m.brand_id
            LEFT JOIN users dec ON dec.id = r.agency_payment_decided_by
            WHERE r.agency_payment_status != 'none' 
               OR r.agency_payment_requested_at IS NOT NULL
               OR r.manual_payment_method IS NOT NULL
            ORDER BY 
              CASE WHEN r.agency_payment_status = 'agency_payment_requested' THEN 0 ELSE 1 END,
              r.agency_payment_requested_at DESC NULLS LAST,
              r.created_at DESC;
        `);

        // 2. All Transactions across all reservations
        const rawPayments = await this.dataSource.query(`
            SELECT 
                p.id,
                p.type,
                p.method,
                p.amount,
                p.currency,
                p.paid_at AS "paidAt",
                p.reference,
                p.provider,
                p.is_simulated AS "isSimulated",
                p.is_demo AS "isDemo",
                p.notes,
                r.id AS "reservationId",
                r.reservation_number AS "reservationNumber",
                r.status AS "reservationStatus",
                r.agency_payment_status AS "agencyPaymentStatus",
                r.is_demo_payment AS "reservationIsDemo",
                r.stripe_payment_intent_id AS "stripePaymentIntentId",
                r.total_amount AS "rentalAmount",
                r.deposit_amount AS "depositAmount",
                r.deposit_refund_status AS "depositRefundStatus",
                CONCAT(u.first_name, ' ', u.last_name) AS "customerName",
                u.email AS "customerEmail",
                CONCAT(b.name, ' ', m.name) AS "vehicleName",
                v.license_plate AS "licensePlate",
                CONCAT(rec.first_name, ' ', rec.last_name) AS "recordedByName"
            FROM payments p
            JOIN reservations r ON r.id = p.reservation_id
            JOIN users u ON u.id = r.customer_id
            JOIN vehicles v ON v.id = r.vehicle_id
            JOIN vehicle_models m ON m.id = v.model_id
            JOIN brands b ON b.id = m.brand_id
            LEFT JOIN users rec ON rec.id = p.recorded_by
            ORDER BY p.paid_at DESC, p.created_at DESC;
        `);

        // Classify each transaction according to section 5:
        // STRIPE VERIFIED, MANUAL VERIFIED, DEMO SIMULATED, FAILED / REJECTED
        const transactions = rawPayments.map((p: any) => {
            const refLower = (p.reference || '').toLowerCase();
            const isStripeMethod =
                p.method === 'card' ||
                p.provider === 'stripe' ||
                refLower.startsWith('pi_') ||
                refLower.startsWith('cs_');

            // A Stripe transaction is duplicate/superseded if a confirmed stripePaymentIntentId exists on the reservation
            // and this record does not match it
            let isDuplicate = false;
            if (isStripeMethod && p.stripePaymentIntentId) {
                const piId = p.stripePaymentIntentId;
                const isMatch = p.reference === piId ||
                    p.reference === `${piId}-deposit` ||
                    p.reference?.startsWith(`${piId}_`);
                isDuplicate = !isMatch;
            }

            const isAgencyMethod =
                p.method === 'manual_agency_demo' ||
                p.provider === 'manual_agency_demo' ||
                p.method === 'cash' ||
                p.method === 'bank_transfer' ||
                p.provider === 'manual_agency' ||
                refLower.startsWith('demo-agency') ||
                refLower.startsWith('manual-agency');

            const isRejected =
                (isAgencyMethod && p.agencyPaymentStatus === 'rejected') ||
                p.reservationStatus === 'cancelled_unpaid' ||
                p.reservationStatus === 'rejected';

            const isDemo = Boolean(p.isDemo || p.isSimulated || p.reservationIsDemo) ||
                p.method === 'manual_agency_demo' ||
                p.provider === 'manual_agency_demo' ||
                refLower.startsWith('demo-agency');

            let integrityStatus: 'STRIPE_VERIFIED' | 'MANUAL_VERIFIED' | 'FAILED_REJECTED';

            if (isRejected || isDuplicate) {
                integrityStatus = 'FAILED_REJECTED';
            } else if (
                isStripeMethod &&
                ['confirmed', 'active_rental', 'completed'].includes(p.reservationStatus)
            ) {
                integrityStatus = 'STRIPE_VERIFIED';
            } else if (
                (p.provider === 'manual_agency' || refLower.startsWith('manual-agency') || p.method === 'cash' || p.method === 'bank_transfer') &&
                p.agencyPaymentStatus === 'approved' &&
                ['confirmed', 'active_rental', 'completed'].includes(p.reservationStatus)
            ) {
                integrityStatus = 'MANUAL_VERIFIED';
            } else {
                integrityStatus = 'FAILED_REJECTED';
            }

            return {
                ...p,
                isDemo,
                isDuplicate,
                integrityStatus,
            };
        });

        // 3. Documents: Receipts & Invoices
        // Invoices from `invoices` table
        const rawInvoices = await this.dataSource.query(`
            SELECT 
                i.id,
                i.invoice_number AS "invoiceNumber",
                i.total_amount AS "totalAmount",
                i.currency,
                i.issued_at AS "issuedAt",
                i.status,
                r.id AS "rentalId",
                res.reservation_number AS "reservationNumber",
                res.is_demo_payment AS "isDemo",
                CONCAT(u.first_name, ' ', u.last_name) AS "customerName"
            FROM invoices i
            JOIN rentals r ON r.id = i.rental_id
            JOIN reservations res ON res.id = r.reservation_id
            JOIN users u ON u.id = res.customer_id
            ORDER BY i.issued_at DESC;
        `);

        const documents = [
            ...rawInvoices.map((inv: any) => ({
                id: inv.id,
                documentType: 'invoice' as const,
                documentNumber: inv.invoiceNumber,
                reservationNumber: inv.reservationNumber,
                customerName: inv.customerName,
                amount: inv.totalAmount,
                currency: inv.currency || 'EUR',
                issuedAt: inv.issuedAt,
                downloadUrl: `/api/admin/operations/finance/${inv.rentalId}/documents/invoice`,
            })),
            ...transactions
                .filter((tx: any) => tx.integrityStatus !== 'FAILED_REJECTED')
                .map((tx: any) => ({
                id: tx.id,
                documentType: 'receipt' as const,
                documentNumber: tx.reference || `REC-${tx.id.slice(0, 8).toUpperCase()}`,
                reservationNumber: tx.reservationNumber,
                customerName: tx.customerName,
                amount: tx.amount,
                currency: tx.currency || 'EUR',
                issuedAt: tx.paidAt,
                downloadUrl: `/api/admin/operations/finance/payments/${tx.id}/receipt`,
            })),
        ];

        // 4. Payment History (Unified Audit Trail)
        const history: Array<{
            id: string;
            timestamp: string;
            eventType: string;
            badge: 'STRIPE' | 'MANUAL' | 'PENDING' | 'REJECTED';
            title: string;
            reservationNumber: string;
            customerName: string;
            amount: string;
            reference: string;
            actor: string;
            notes: string;
        }> = [];

        // Events from transactions
        for (const tx of transactions) {
            history.push({
                id: `tx-${tx.id}`,
                timestamp: tx.paidAt,
                eventType: tx.type,
                badge: tx.integrityStatus === 'STRIPE_VERIFIED'
                    ? 'STRIPE'
                    : tx.integrityStatus === 'MANUAL_VERIFIED'
                    ? 'MANUAL'
                    : 'REJECTED',
                title: tx.integrityStatus === 'FAILED_REJECTED'
                    ? (tx.isDuplicate ? 'Duplicate Payment Record (Excluded)' : 'Unauthorized / Rejected Payment Entry')
                    : tx.type === 'rental_payment'
                    ? 'Verified Rental Fee Payment'
                    : tx.type === 'deposit_payment'
                    ? 'Security Deposit Authorized'
                    : tx.type === 'refund'
                    ? 'Payment Refund Processed'
                    : 'Additional Charge Paid',
                reservationNumber: tx.reservationNumber,
                customerName: tx.customerName,
                amount: tx.amount,
                reference: tx.reference || '—',
                actor: tx.recordedByName || (tx.integrityStatus === 'STRIPE_VERIFIED' ? 'Stripe Gateway' : 'Agency Staff'),
                notes: tx.notes || (tx.isDuplicate ? 'Duplicate payment record superseded' : tx.integrityStatus === 'FAILED_REJECTED' ? 'Payment rejected or unauthorized' : 'Payment confirmed'),
            });
        }

        // Events from payment requests
        for (const req of requests) {
            if (req.agencyPaymentRequestedAt) {
                history.push({
                    id: `req-${req.id}-requested`,
                    timestamp: req.agencyPaymentRequestedAt,
                    eventType: 'request_created',
                    badge: req.agencyPaymentStatus === 'agency_payment_requested' ? 'PENDING' : 'MANUAL',
                    title: `Pay at Agency Requested (${req.agencyPaymentAgencyName || 'Agency Counter'})`,
                    reservationNumber: req.reservationNumber,
                    customerName: req.customerName,
                    amount: req.totalDue,
                    reference: req.reservationNumber,
                    actor: req.customerName,
                    notes: `Customer requested manual counter payment for €${req.totalAmount} rental + €${req.depositAmount} deposit.`,
                });
            }
            if (req.agencyPaymentDecidedAt) {
                const isRejected = req.agencyPaymentStatus === 'rejected';
                history.push({
                    id: `req-${req.id}-decided`,
                    timestamp: req.agencyPaymentDecidedAt,
                    eventType: isRejected ? 'request_rejected' : 'request_approved',
                    badge: isRejected ? 'REJECTED' : 'MANUAL',
                    title: isRejected
                        ? `Agency Payment Request Rejected`
                        : `Verified Manual Payment Approved at Counter`,
                    reservationNumber: req.reservationNumber,
                    customerName: req.customerName,
                    amount: req.totalDue,
                    reference: req.reservationNumber,
                    actor: req.decidedByName || 'Administrator',
                    notes: req.agencyPaymentDecisionNotes || (isRejected ? 'Rejected by administrator' : 'Approved'),
                });
            }
        }

        // Sort history descending by timestamp
        history.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        // 5. Aggregate Stats
        const verifiedRentalTxs = transactions.filter(
            (t: any) => !t.isDemo && !t.isDuplicate && (t.integrityStatus === 'STRIPE_VERIFIED' || t.integrityStatus === 'MANUAL_VERIFIED') && t.type === 'rental_payment'
        );
        const refundTxs = transactions.filter(
            (t: any) => t.type === 'refund' && !t.isDuplicate
        );
        const sumAmount = (list: any[]) =>
            list.reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0);

        const refundSum = sumAmount(refundTxs);
        const stripeRentalTxs = verifiedRentalTxs.filter(
            (t: any) => t.integrityStatus === 'STRIPE_VERIFIED'
        );
        const manualRentalTxs = verifiedRentalTxs.filter(
            (t: any) => t.integrityStatus === 'MANUAL_VERIFIED'
        );

        const stats = {
            totalVerifiedRevenueEur: Math.max(0, sumAmount(verifiedRentalTxs) - refundSum).toFixed(2),
            verifiedStripeCount: stripeRentalTxs.length,
            verifiedStripeEur: Math.max(0, sumAmount(stripeRentalTxs) - refundSum).toFixed(2),
            verifiedManualCount: manualRentalTxs.length,
            verifiedManualEur: sumAmount(manualRentalTxs).toFixed(2),
            pendingRequestsCount: requests.filter((r: any) => r.agencyPaymentStatus === 'agency_payment_requested').length,
        };

        return {
            stats,
            requests,
            transactions,
            documents,
            history,
        };
    }

    private async audit(
        manager: EntityManager,
        actorId: string,
        action: string,
        entityType: string,
        entityId: string,
        values: Record<string, unknown>,
    ) {
        await manager.query(
            `INSERT INTO audit_logs
                (actor_id, action, entity_type, entity_id, new_values)
             VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb)`,
            [
                actorId,
                action,
                entityType,
                entityId,
                JSON.stringify(values),
            ],
        );
    }
}
