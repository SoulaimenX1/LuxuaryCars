import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { envSchema } from '../config/env.schema.js';
import type { Reservation } from '../reservations/entities/reservation.entity.js';
import {
    dotStuffBody,
    EmailOutboxService,
    extractEnvelopeAddress,
    isEncryptedOutboxContent,
    isTestRecipient,
    OUTBOX_CIPHERTEXT_PREFIX,
    REDACTED_OUTBOX_MESSAGE,
    sanitizeHeaderValue,
    type EmailMessagePayload,
} from './email-outbox.service.js';

const baseEnv = {
    NODE_ENV: 'test',
    PORT: '3001',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USERNAME: 'postgres',
    DB_PASSWORD: 'postgres-password',
    DB_DATABASE: 'luxury_car_rental',
    JWT_SECRET: 'unit-test-only-secret-that-is-at-least-32-characters',
};

describe('EmailOutboxService & SMTP security configuration', () => {
    it('validates secure SMTP config and rejects partial SMTP credentials or CRLF injection', () => {
        const defaults = envSchema.parse(baseEnv);
        expect(defaults.SMTP_HOST).toBeUndefined();
        expect(defaults.SMTP_PORT).toBe(587);
        expect(defaults.SMTP_SECURE).toBe(false);
        expect(defaults.EMAIL_OUTBOX_MAX_ATTEMPTS).toBe(3);

        // Empty string in .env is normalized to undefined
        const emptyHost = envSchema.parse({
            ...baseEnv,
            SMTP_HOST: '   ',
            SMTP_USER: '',
            SMTP_PASSWORD: '',
        });
        expect(emptyHost.SMTP_HOST).toBeUndefined();

        // Partial auth (user without password) must fail
        expect(() =>
            envSchema.parse({
                ...baseEnv,
                SMTP_HOST: 'smtp.luxuar.hu',
                SMTP_USER: 'mailer@luxuar.hu',
            }),
        ).toThrow(/Both SMTP_USER and SMTP_PASSWORD must be provided together/);

        // CRLF injection in SMTP_FROM must fail
        expect(() =>
            envSchema.parse({
                ...baseEnv,
                SMTP_FROM: 'LUXUAR <no-reply@luxuar.hu>\r\nBcc: attacker@evil.test',
            }),
        ).toThrow();
    });

    it('sanitizes headers, extracts envelope addresses, dot-stuffs bodies, and redacts secrets', () => {
        expect(
            sanitizeHeaderValue('Reservation confirmed\r\nBcc: spy@evil.test'),
        ).toBe('Reservation confirmed Bcc: spy@evil.test');
        expect(
            extractEnvelopeAddress('LUXUAR Concierge <no-reply@luxuar.hu>'),
        ).toBe('no-reply@luxuar.hu');
        expect(() => extractEnvelopeAddress('not-an-email')).toThrow(
            /Invalid email address/,
        );
        expect(dotStuffBody('Line 1\n.leading dot\n..two dots')).toBe(
            'Line 1\r\n..leading dot\r\n...two dots',
        );

        const config = new ConfigService({
            SMTP_USER: 'concierge@luxuar.hu',
            SMTP_PASSWORD: 'SuperSecretSmtpPassword!99',
        });
        const service = new EmailOutboxService(
            { query: vi.fn() } as unknown as DataSource,
            config,
        );
        const plainToken = Buffer.from(
            '\u0000concierge@luxuar.hu\u0000SuperSecretSmtpPassword!99',
            'utf8',
        ).toString('base64');

        const redacted = service.sanitizeError(
            new Error(
                `AUTH failed for SuperSecretSmtpPassword!99 token=${plainToken}`,
            ),
        );
        expect(redacted).not.toContain('SuperSecretSmtpPassword!99');
        expect(redacted).not.toContain(plainToken);
        expect(redacted).toContain('[REDACTED]');
    });

    it('deduplicates transactional emails using ON CONFLICT (customer_id, event_key) DO NOTHING', async () => {
        const calls: { sql: string; params: unknown[] }[] = [];
        let insertedOnce = false;
        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params });
            if (sql.includes('INSERT INTO customer_email_outbox')) {
                if (!insertedOnce) {
                    insertedOnce = true;
                    return [
                        {
                            id: 'outbox-1',
                            notification_id: 'notif-1',
                        },
                    ];
                }
                return [];
            }
            return [];
        });

        const service = new EmailOutboxService({
            query,
        } as unknown as DataSource);

        const first = await service.enqueueEmail({
            customerId: 'customer-1',
            eventKey: 'reservation:res-1:confirmed',
            templateType: 'booking_confirmed',
            notificationId: 'notif-1',
            subject: 'Reservation RES-2026-000001 confirmed — LUXUAR',
            message: 'Confirmed body',
        });
        const second = await service.enqueueEmail({
            customerId: 'customer-1',
            eventKey: 'reservation:res-1:confirmed',
            templateType: 'booking_confirmed',
            notificationId: 'notif-1',
            subject: 'Reservation RES-2026-000001 confirmed — LUXUAR',
            message: 'Confirmed body',
        });

        expect(first).toEqual({ id: 'outbox-1', deduplicated: false });
        expect(second).toEqual({ id: null, deduplicated: true });
        expect(
            calls.some((c) =>
                c.sql.includes('INSERT INTO notification_delivery_logs'),
            ),
        ).toBe(true);
    });

    it('retries failed deliveries with exponential backoff and marks failed only after maxAttempts', async () => {
        const state = {
            id: 'outbox-retry-1',
            customer_id: 'customer-1',
            recipient_email: 'client@luxuar.hu',
            user_email: 'client@luxuar.hu',
            subject: 'Reservation RES-2026-000001 confirmed — LUXUAR',
            message: 'Confirmed body',
            event_key: 'reservation:res-1:confirmed',
            template_type: 'booking_confirmed',
            notification_id: 'notif-1',
            status: 'pending',
            attempt_count: 0,
            max_attempts: 3,
            last_error: null as string | null,
        };
        const deliveryLogs: { status: string; error: string | null }[] = [];

        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('FOR UPDATE OF o SKIP LOCKED')) {
                if (
                    state.status === 'pending' &&
                    state.attempt_count < state.max_attempts
                ) {
                    return [{ ...state }];
                }
                return [];
            }
            if (
                sql.includes('UPDATE customer_email_outbox') &&
                sql.includes("SET status = 'pending'")
            ) {
                state.attempt_count = Number(params[1]);
                state.last_error = String(params[3]);
                return [];
            }
            if (
                sql.includes('UPDATE customer_email_outbox') &&
                sql.includes("SET status = 'failed'")
            ) {
                state.status = 'failed';
                state.attempt_count = Number(params[1]);
                state.last_error = String(params[2]);
                return [];
            }
            if (
                sql.includes('UPDATE customer_email_outbox') &&
                sql.includes("SET status = 'sent'")
            ) {
                state.status = 'sent';
                state.attempt_count = Number(params[2]);
                state.last_error = null;
                return [];
            }
            if (sql.includes('INSERT INTO notification_delivery_logs')) {
                deliveryLogs.push({
                    status: String(params[1]),
                    error: (params[2] as string | null) ?? null,
                });
                return [];
            }
            return [];
        });

        const db = {
            query,
            transaction: vi.fn(async (cb: (m: { query: typeof query }) => unknown) =>
                cb({ query }),
            ),
        } as unknown as DataSource;

        const config = new ConfigService({
            EMAIL_OUTBOX_MAX_ATTEMPTS: 3,
            EMAIL_OUTBOX_BASE_DELAY_MS: 1000,
        });
        const service = new EmailOutboxService(db, config);

        expect(service.computeRetryDelayMs(1)).toBe(1000);
        expect(service.computeRetryDelayMs(2)).toBe(2000);
        expect(service.computeRetryDelayMs(3)).toBe(4000);

        // Always fail transport for first 3 attempts
        service.setTransport({
            sendMail: vi
                .fn()
                .mockRejectedValue(new Error('421 Temporary SMTP outage')),
        });

        const attempt1 = await service.processOutboxBatch();
        expect(attempt1).toEqual({
            claimed: 1,
            sent: 0,
            retried: 1,
            failed: 0,
        });
        expect(state.status).toBe('pending');
        expect(state.attempt_count).toBe(1);

        const attempt2 = await service.processOutboxBatch();
        expect(attempt2).toEqual({
            claimed: 1,
            sent: 0,
            retried: 1,
            failed: 0,
        });
        expect(state.status).toBe('pending');
        expect(state.attempt_count).toBe(2);

        const attempt3 = await service.processOutboxBatch();
        expect(attempt3).toEqual({
            claimed: 1,
            sent: 0,
            retried: 0,
            failed: 1,
        });
        expect(state.status).toBe('failed');
        expect(state.attempt_count).toBe(3);
        expect(state.last_error).toContain('421 Temporary SMTP outage');
        expect(deliveryLogs).toHaveLength(3);
        expect(deliveryLogs.every((l) => l.status === 'failed')).toBe(true);
    });

    it('covers confirmation, cancellation, check-in, and return transactional email templates end-to-end', async () => {
        const sentEmails: EmailMessagePayload[] = [];
        const outboxQueue: {
            id: string;
            customer_id: string;
            recipient_email: string;
            user_email: string;
            subject: string;
            message: string;
            html_message: string | null;
            event_key: string;
            template_type: string;
            notification_id: string | null;
            status: string;
            attempt_count: number;
            max_attempts: number;
        }[] = [];

        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('FROM reservations r') && sql.includes('WHERE r.id = $1::uuid')) {
                return [
                    {
                        reservationId: 'res-1',
                        customerId: 'customer-1',
                        customerEmail: 'vip@luxuar.hu',
                        customerName: 'Ada Lovelace',
                        reservationNumber: 'RES-2026-000077',
                        vehicleName: 'Ferrari 296 GTB',
                        pickupAt: '2030-07-01T10:00:00.000Z',
                        returnAt: '2030-07-03T10:00:00.000Z',
                        totalAmount: '2400.00',
                        decisionReason: null,
                        pickupLocation: 'Budapest Flagship Showroom',
                        returnLocation: 'Budapest Flagship Showroom',
                    },
                ];
            }
            if (sql.includes('FROM rentals l') && sql.includes('WHERE l.id = $1::uuid')) {
                return [
                    {
                        rentalId: 'rental-1',
                        contractNumber: 'CNT-2026-000077',
                        reservationId: 'res-1',
                        reservationNumber: 'RES-2026-000077',
                        customerId: 'customer-1',
                        customerEmail: 'vip@luxuar.hu',
                        customerName: 'Ada Lovelace',
                        vehicleName: 'Ferrari 296 GTB',
                        pickupAgencyName: 'Budapest Flagship Showroom',
                        returnAgencyName: 'Budapest Flagship Showroom',
                        startedAt: '2030-07-01T10:05:00.000Z',
                        expectedReturnAt: '2030-07-03T10:00:00.000Z',
                        returnedAt: '2030-07-03T09:50:00.000Z',
                        pickupMileageKm: 5000,
                        pickupFuelPct: 100,
                        returnMileageKm: 5280,
                        returnFuelPct: 100,
                        returnReference: 'RET-2026-000077',
                    },
                ];
            }
            if (sql.includes('INSERT INTO user_notifications')) {
                return [{ id: 'notif-1' }];
            }
            if (sql.includes('SELECT id FROM user_notifications')) {
                return [{ id: 'notif-1' }];
            }
            if (sql.includes('INSERT INTO customer_email_outbox')) {
                const eventKey = String(params[4]);
                if (outboxQueue.some((item) => item.event_key === eventKey)) {
                    return [];
                }
                const id = `outbox-${outboxQueue.length + 1}`;
                outboxQueue.push({
                    id,
                    customer_id: String(params[0]),
                    recipient_email:
                        typeof params[1] === 'string'
                            ? params[1]
                            : 'vip@luxuar.hu',
                    user_email: 'vip@luxuar.hu',
                    subject: String(params[2]),
                    message: String(params[3]),
                    html_message: (params[8] as string | null) ?? null,
                    event_key: eventKey,
                    template_type: String(params[5]),
                    notification_id: (params[6] as string | null) ?? null,
                    status: 'pending',
                    attempt_count: 0,
                    max_attempts: 3,
                });
                return [{ id, notification_id: params[6] ?? null }];
            }
            if (sql.includes('FOR UPDATE OF o SKIP LOCKED')) {
                return outboxQueue.filter((item) => item.status === 'pending');
            }
            if (
                sql.includes('UPDATE customer_email_outbox') &&
                sql.includes("SET status = 'sent'")
            ) {
                const target = outboxQueue.find((item) => item.id === params[0]);
                if (target) target.status = 'sent';
                return [];
            }
            return [];
        });

        const db = {
            query,
            transaction: vi.fn(async (cb: (m: { query: typeof query }) => unknown) =>
                cb({ query }),
            ),
        } as unknown as DataSource;

        const service = new EmailOutboxService(db);
        service.setTransport({
            sendMail: vi.fn(async (payload: EmailMessagePayload) => {
                sentEmails.push(payload);
                return { messageId: `<${payload.outboxId}@luxuar.test>` };
            }),
        });

        const reservation = {
            id: 'res-1',
            customerId: 'customer-1',
            reservationNumber: 'RES-2026-000077',
            decisionReason: null,
        } as Reservation;

        // 1. Booking confirmation (called twice to verify idempotency)
        await service.notifyReservationEvent('confirmed', reservation);
        await service.notifyReservationEvent('confirmed', reservation);

        // 2. Check-in code + Check-in handover
        await service.notifyCheckInCodeIssued({
            customerId: 'customer-1',
            reservationId: 'res-1',
            reservationNumber: 'RES-2026-000077',
            code: '87654321',
            expiresAt: '2030-07-01T12:00:00.000Z',
        });
        await service.notifyCheckInCompleted('rental-1');

        // 3. Vehicle return
        await service.notifyVehicleReturned('rental-1', {
            returnReference: 'RET-2026-000077',
            automaticChargesEur: '0.00',
            estimatedDamageAmountEur: '0.00',
        });

        // 4. Booking cancellation
        await service.notifyReservationEvent('cancelled', reservation);

        expect(sentEmails).toHaveLength(5);
        expect(sentEmails.map((e) => e.templateType)).toEqual([
            'booking_confirmed',
            'check_in_code',
            'check_in_completed',
            'vehicle_returned',
            'booking_cancelled',
        ]);
        expect(sentEmails[0].subject).toContain(
            'Reservation RES-2026-000077 confirmed',
        );
        expect(sentEmails[1].text).toContain('87654321');
        expect(sentEmails[2].subject).toContain(
            'Check-in completed — Contract CNT-2026-000077',
        );
        expect(sentEmails[3].subject).toContain(
            'Vehicle return registered — RET-2026-000077',
        );
        expect(sentEmails[4].subject).toContain(
            'Reservation RES-2026-000077 cancelled',
        );
    });

    it('dispatches cancelled_unpaid email with car image matching identical LUXUAR reference design', async () => {
        const sentEmails: EmailMessagePayload[] = [];
        const outboxQueue: any[] = [];

        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('FROM reservations r') && sql.includes('WHERE r.id = $1::uuid')) {
                return [
                    {
                        reservationId: 'res-66',
                        customerId: 'customer-bensalah',
                        customerEmail: 'soulaimenbensalah11@gmail.com',
                        customerName: 'Soulaimen Bensalah',
                        reservationNumber: 'RES-2026-000066',
                        vehicleName: 'Mercedes-AMG ONE',
                        pickupAt: '2026-11-05T10:00:00.000Z',
                        returnAt: '2026-11-08T10:00:00.000Z',
                        totalAmount: '4500.00',
                        vehiclePhoto: '/vehicles/lc-0046-image-1792253049840.png',
                    },
                ];
            }
            if (sql.includes('INSERT INTO user_notifications') || sql.includes('SELECT id FROM user_notifications')) {
                return [{ id: 'notif-66' }];
            }
            if (sql.includes('INSERT INTO customer_email_outbox')) {
                const id = 'outbox-66';
                outboxQueue.push({
                    id,
                    customer_id: String(params[0]),
                    recipient_email: String(params[1]),
                    user_email: String(params[1]),
                    subject: String(params[2]),
                    message: String(params[3]),
                    html_message: (params[8] as string | null) ?? null,
                    event_key: String(params[4]),
                    template_type: String(params[5]),
                    notification_id: (params[6] as string | null) ?? null,
                    status: 'pending',
                    attempt_count: 0,
                    max_attempts: 3,
                });
                return [{ id, notification_id: 'notif-66' }];
            }
            if (sql.includes('FOR UPDATE OF o SKIP LOCKED')) {
                return outboxQueue.filter((item) => item.status === 'pending');
            }
            if (sql.includes('UPDATE customer_email_outbox') && sql.includes("SET status = 'sent'")) {
                const target = outboxQueue.find((item) => item.id === params[0]);
                if (target) target.status = 'sent';
                return [];
            }
            return [];
        });

        const db = {
            query,
            transaction: vi.fn(async (cb: (m: { query: typeof query }) => unknown) => cb({ query })),
        } as unknown as DataSource;

        const config = new ConfigService({
            FRONTEND_URL: 'http://localhost:3000',
        });
        const service = new EmailOutboxService(db, config);
        service.setTransport({
            sendMail: vi.fn(async (payload: EmailMessagePayload) => {
                sentEmails.push(payload);
                return { messageId: `<${payload.outboxId}@luxuar.test>` };
            }),
        });

        await service.notifyReservationEvent('cancelled_unpaid', {
            id: 'res-66',
            customerId: 'customer-bensalah',
            reservationNumber: 'RES-2026-000066',
            decisionReason: null,
        } as Reservation);

        expect(sentEmails).toHaveLength(1);
        const email = sentEmails[0];
        expect(email.templateType).toBe('booking_cancelled_unpaid');
        expect(email.subject).toContain('Reservation Cancelled');

        // Check HTML content matches the screenshot with car image
        expect(email.html).toBeDefined();
        const html = email.html!;
        expect(html).toContain('L U X U A R');
        expect(html).toContain('P R E M I U M C A R R E N T A L');
        expect(html).toContain('RESERVATION UPDATE');
        expect(html).toContain('Your reservation has been cancelled.');
        expect(html).toContain('Dear Soulaimen Bensalah,');
        expect(html).toContain('Your reservation has been cancelled because the payment deadline expired without a verified payment.');
        expect(html).toContain('RESERVATION DETAILS');
        expect(html).toContain('Mercedes-AMG ONE');
        expect(html).toContain('http://localhost:3000/vehicles/lc-0046-image-1792253049840.png');
        expect(html).toContain('RES-2026-000066');
        expect(html).toContain('Cancelled — Unpaid');
        expect(html).toContain('You are welcome to explore our collection and submit a new reservation request.');
        expect(html).toContain('EXPLORE THE COLLECTION →');
        expect(html).toContain('Kind regards, The LUXUAR Team');
        expect(html).toContain('Excellence in every journey.');
        expect(html).toContain('Premium Car Rental · Customer Support');
    });
    it('dispatches branded invoice issued email with PDF retrieval CTA and deduplication', async () => {
        const outboxQueue: Record<string, unknown>[] = [];
        const sentEmails: EmailMessagePayload[] = [];
        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('SELECT l.id AS "rentalId"')) {
                return [
                    {
                        rentalId: 'rental-inv-1',
                        contractNumber: 'CNT-2026-000001',
                        reservationId: 'res-inv-1',
                        reservationNumber: 'RES-2026-000001',
                        customerId: 'customer-1',
                        customerEmail: 'client@luxuar.test',
                        customerName: 'Alexander Hayes',
                        vehicleName: 'Rolls-Royce Ghost',
                        pickupAgencyName: 'LUXUAR Central',
                        returnAgencyName: 'LUXUAR Central',
                        startedAtIso: '2026-11-01T10:00:00.000Z',
                        expectedReturnAtIso: '2026-11-05T10:00:00.000Z',
                        returnedAtIso: '2026-11-05T09:30:00.000Z',
                        vehiclePhoto: '/vehicles/ghost.png',
                    },
                ];
            }
            if (sql.includes('INSERT INTO user_notifications') || sql.includes('SELECT id FROM user_notifications')) {
                return [{ id: 'notif-inv-1' }];
            }
            if (sql.includes('INSERT INTO customer_email_outbox')) {
                const id = 'outbox-inv-1';
                outboxQueue.push({
                    id,
                    customer_id: String(params[0]),
                    recipient_email: String(params[1]),
                    user_email: String(params[1]),
                    subject: String(params[2]),
                    message: String(params[3]),
                    html_message: (params[8] as string | null) ?? null,
                    event_key: String(params[4]),
                    template_type: String(params[5]),
                    notification_id: (params[6] as string | null) ?? null,
                    status: 'pending',
                    attempt_count: 0,
                    max_attempts: 3,
                });
                return [{ id, notification_id: 'notif-inv-1' }];
            }
            if (sql.includes('FOR UPDATE OF o SKIP LOCKED')) {
                return outboxQueue.filter((item) => item.status === 'pending');
            }
            if (sql.includes('UPDATE customer_email_outbox') && sql.includes("SET status = 'sent'")) {
                const target = outboxQueue.find((item) => item.id === params[0]);
                if (target) target.status = 'sent';
                return [];
            }
            return [];
        });

        const db = {
            query,
            transaction: vi.fn(async (cb: (m: { query: typeof query }) => unknown) => cb({ query })),
        } as unknown as DataSource;

        const config = new ConfigService({
            FRONTEND_URL: 'http://localhost:3000',
        });
        const service = new EmailOutboxService(db, config);
        service.setTransport({
            sendMail: vi.fn(async (payload: EmailMessagePayload) => {
                sentEmails.push(payload);
                return { messageId: `<${payload.outboxId}@luxuar.test>` };
            }),
        });

        await service.notifyInvoiceIssued('rental-inv-1', 'INV-2026-000001', '4200.00');

        expect(sentEmails).toHaveLength(1);
        const email = sentEmails[0];
        expect(email.templateType).toBe('invoice_issued');
        expect(email.subject).toContain('INV-2026-000001');
        expect(email.to).toBe('client@luxuar.test');
        expect(email.html).toContain('FINANCIAL STATEMENT');
        expect(email.html).toContain('Final Invoice Issued');
        expect(email.html).toContain('INV-2026-000001');
        expect(email.html).toContain('CNT-2026-000001');
        expect(email.html).toContain('EUR 4200.00');
        expect(email.html).toContain('Rolls-Royce Ghost');
        expect(email.html).toContain('VIEW MY RENTALS &amp; INVOICES →');
        expect(email.text).toContain('INV-2026-000001');
        expect(email.text).toContain('EUR 4200.00');
        expect(email.text).toContain('luxurycarsrentcars@gmail.com');
    });

    it('encrypts sensitive verification & password-reset tokens at rest (AES-256-GCM), preserves retries, and purges sensitive content after delivery', async () => {
        const encryptionKey =
            'test-outbox-aes-256-gcm-secret-key-at-least-32-bytes!';
        const outboxRows: {
            id: string;
            customer_id: string;
            recipient_email: string;
            user_email: string;
            subject: string;
            message: string;
            html_message: string | null;
            event_key: string;
            template_type: string;
            notification_id: string | null;
            status: string;
            attempt_count: number;
            max_attempts: number;
            last_error: string | null;
            due: boolean;
        }[] = [];

        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO customer_email_outbox')) {
                const id = `outbox-sec-${outboxRows.length + 1}`;
                outboxRows.push({
                    id,
                    customer_id: String(params[0]),
                    recipient_email: String(params[1]),
                    user_email: String(params[1]),
                    subject: String(params[2]),
                    message: String(params[3]),
                    html_message: (params[8] as string | null) ?? null,
                    event_key: String(params[4]),
                    template_type: String(params[5]),
                    notification_id: (params[6] as string | null) ?? null,
                    status: 'pending',
                    attempt_count: 0,
                    max_attempts: Number(params[7] ?? 3),
                    last_error: null,
                    due: true,
                });
                return [{ id, notification_id: params[6] ?? null }];
            }
            if (sql.includes('FOR UPDATE OF o SKIP LOCKED')) {
                return outboxRows
                    .filter(
                        (r) =>
                            r.status === 'pending' &&
                            r.due &&
                            r.attempt_count < r.max_attempts,
                    )
                    .map((r) => ({ ...r }));
            }
            if (
                sql.includes('UPDATE customer_email_outbox') &&
                sql.includes("SET status = 'pending'") &&
                sql.includes('next_attempt_at = now() +')
            ) {
                const row = outboxRows.find((r) => r.id === params[0]);
                if (row) {
                    row.status = 'pending';
                    row.attempt_count = Number(params[1]);
                    row.last_error = String(params[3]);
                    row.due = false;
                    if (typeof params[4] === 'string') row.message = params[4];
                    if (params[5] !== undefined) {
                        row.html_message = (params[5] as string | null) ?? null;
                    }
                }
                return [];
            }
            if (
                sql.includes('UPDATE customer_email_outbox') &&
                sql.includes("SET status = 'failed'")
            ) {
                const row = outboxRows.find((r) => r.id === params[0]);
                if (row) {
                    row.status = 'failed';
                    row.attempt_count = Number(params[1]);
                    row.last_error = String(params[2]);
                    row.due = false;
                    if (typeof params[3] === 'string') row.message = params[3];
                    if (params[4] !== undefined) {
                        row.html_message = (params[4] as string | null) ?? null;
                    }
                }
                return [];
            }
            if (
                sql.includes('UPDATE customer_email_outbox') &&
                sql.includes("SET status = 'sent'")
            ) {
                const row = outboxRows.find((r) => r.id === params[0]);
                if (row) {
                    row.status = 'sent';
                    row.attempt_count = Number(params[2]);
                    row.last_error = null;
                    row.due = false;
                    if (params[3] === true) {
                        row.message = String(params[4]);
                        row.html_message = null;
                    }
                }
                return [];
            }
            if (
                sql.includes('UPDATE customer_email_outbox') &&
                sql.includes("AND status != 'sent'")
            ) {
                const row = outboxRows.find(
                    (r) =>
                        r.id === params[0] &&
                        r.status !== 'sent' &&
                        r.message !== params[1],
                );
                if (!row) return [];
                row.status = 'pending';
                row.attempt_count = 0;
                row.last_error = null;
                row.due = true;
                return [
                    {
                        id: row.id,
                        recipient_email: row.recipient_email,
                        subject: row.subject,
                    },
                ];
            }
            return [];
        });

        const db = {
            query,
            transaction: vi.fn(
                async (cb: (m: { query: typeof query }) => unknown) =>
                    cb({ query }),
            ),
        } as unknown as DataSource;

        const config = new ConfigService({
            FRONTEND_URL: 'http://localhost:3000',
            EMAIL_OUTBOX_ENCRYPTION_KEY: encryptionKey,
            EMAIL_OUTBOX_MAX_ATTEMPTS: 2,
        });
        const service = new EmailOutboxService(db, config);

        const rawVerifyToken = 'VERIFY_SECRET_TOKEN_9876543210_ABCDEF';
        const rawResetToken = 'RESET_SECRET_TOKEN_1234567890_ZYXWVU';
        const deliveredPayloads: EmailMessagePayload[] = [];

        // Simulate transient SMTP failure on first attempt so messages stay in DB ('pending' retry -> 'failed')
        let shouldFailSmtp = true;
        service.setTransport({
            sendMail: vi.fn(async (payload: EmailMessagePayload) => {
                if (shouldFailSmtp) {
                    throw new Error(
                        `421 SMTP down while sending token=${rawVerifyToken} key=${encryptionKey}`,
                    );
                }
                deliveredPayloads.push(payload);
                return { messageId: `<${payload.outboxId}@luxuar.test>` };
            }),
        });

        // 1. Enqueue email verification & password reset (attempt 1 fails -> status = 'pending', attempt_count = 1)
        await service.notifyEmailVerification({
            customerId: 'cust-sec-1',
            recipientEmail: 'alice@luxuar.hu',
            customerName: 'Alice Example',
            token: rawVerifyToken,
            tokenId: 'tok-v-1',
            expiresAt: '2030-01-01T00:05:00.000Z',
        });

        await service.notifyPasswordReset({
            customerId: 'cust-sec-1',
            recipientEmail: 'alice@luxuar.hu',
            customerName: 'Alice Example',
            token: rawResetToken,
            tokenId: 'tok-r-1',
            expiresAt: '2030-01-01T01:00:00.000Z',
        });

        expect(outboxRows).toHaveLength(2);
        const [verifyRow, resetRow] = outboxRows;

        // Verify confidential tokens are encrypted at rest while queued/retrying
        expect(isEncryptedOutboxContent(verifyRow.message)).toBe(true);
        expect(isEncryptedOutboxContent(verifyRow.html_message)).toBe(true);
        expect(verifyRow.message).not.toContain(rawVerifyToken);
        expect(verifyRow.html_message).not.toContain(rawVerifyToken);
        expect(verifyRow.message).not.toContain('/verify-email?token=');

        expect(isEncryptedOutboxContent(resetRow.message)).toBe(true);
        expect(isEncryptedOutboxContent(resetRow.html_message)).toBe(true);
        expect(resetRow.message).not.toContain(rawResetToken);
        expect(resetRow.html_message).not.toContain(rawResetToken);
        expect(resetRow.message).not.toContain('/reset-password?token=');

        // Verify last_error never leaks raw tokens or encryption key
        expect(verifyRow.last_error).not.toContain(rawVerifyToken);
        expect(verifyRow.last_error).not.toContain(encryptionKey);
        expect(verifyRow.last_error).toContain('[REDACTED]');

        // 2. Second attempt also fails -> rows transition to 'failed' and remain encrypted at rest
        verifyRow.due = true;
        resetRow.due = true;
        const secondBatch = await service.processOutboxBatch();
        expect(secondBatch.failed).toBe(2);
        expect(verifyRow.status).toBe('failed');
        expect(resetRow.status).toBe('failed');
        expect(isEncryptedOutboxContent(verifyRow.message)).toBe(true);
        expect(verifyRow.message).not.toContain(rawVerifyToken);
        expect(resetRow.message).not.toContain(rawResetToken);

        // 3. Recover via retryOutboxItem + healthy SMTP -> decrypts in memory, sends plaintext to recipient, and purges DB content
        shouldFailSmtp = false;
        verifyRow.max_attempts = 3;
        resetRow.max_attempts = 3;
        await service.retryOutboxItem(verifyRow.id);
        await service.retryOutboxItem(resetRow.id);
        await service.processOutboxBatch();

        expect(deliveredPayloads).toHaveLength(2);
        expect(deliveredPayloads[0].text).toContain(rawVerifyToken);
        expect(deliveredPayloads[0].html).toContain(rawVerifyToken);
        expect(deliveredPayloads[1].text).toContain(rawResetToken);
        expect(deliveredPayloads[1].html).toContain(rawResetToken);

        // After delivery, sensitive content is removed while delivery metadata is preserved
        expect(verifyRow.status).toBe('sent');
        expect(verifyRow.message).toBe(REDACTED_OUTBOX_MESSAGE);
        expect(verifyRow.html_message).toBeNull();
        expect(verifyRow.recipient_email).toBe('alice@luxuar.hu');
        expect(verifyRow.template_type).toBe('email_verification');

        expect(resetRow.status).toBe('sent');
        expect(resetRow.message).toBe(REDACTED_OUTBOX_MESSAGE);
        expect(resetRow.html_message).toBeNull();

        // Delivered/redacted rows cannot be re-queued
        const retryDelivered = await service.retryOutboxItem(verifyRow.id);
        expect(retryDelivered.success).toBe(false);
    });

    it('detects ciphertext tampering, rejects wrong keys, and safely handles legacy plaintext records', async () => {
        const serviceA = new EmailOutboxService(
            { query: vi.fn() } as unknown as DataSource,
            new ConfigService({
                EMAIL_OUTBOX_ENCRYPTION_KEY:
                    'key-alpha-0123456789abcdef0123456789abcdef',
            }),
        );
        const serviceB = new EmailOutboxService(
            { query: vi.fn() } as unknown as DataSource,
            new ConfigService({
                EMAIL_OUTBOX_ENCRYPTION_KEY:
                    'key-bravo-fedcba9876543210fedcba9876543210',
            }),
        );

        const secretMessage =
            'Verification token: TOKEN_XYZ_1234567890_SECRET';
        const c1 = serviceA.encryptOutboxContent(secretMessage);
        const c2 = serviceA.encryptOutboxContent(secretMessage);

        // Random 96-bit IV guarantees distinct ciphertexts for identical plaintexts
        expect(c1.startsWith(OUTBOX_CIPHERTEXT_PREFIX)).toBe(true);
        expect(c2.startsWith(OUTBOX_CIPHERTEXT_PREFIX)).toBe(true);
        expect(c1).not.toBe(c2);
        expect(serviceA.decryptOutboxContent(c1)).toBe(secretMessage);

        // Wrong key must fail GCM authentication
        expect(() => serviceB.decryptOutboxContent(c1)).toThrow(
            /invalid key or tampered ciphertext/,
        );

        // Tampered auth tag / ciphertext must fail GCM authentication
        const parts = c1.split(':');
        const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${parts[4].slice(0, -2)}AA`;
        expect(() => serviceA.decryptOutboxContent(tampered)).toThrow(
            /invalid key or tampered ciphertext/,
        );

        // Legacy plaintext records are read without error and upgraded/redacted safely by processOutboxBatch
        const legacyPlain =
            'Legacy verification email with Verification token: LEGACY_TOKEN_999';
        expect(serviceA.decryptOutboxContent(legacyPlain)).toBe(legacyPlain);
    });

    it('routes local SMTP to Mailpit (127.0.0.1:1025) without overwriting or exposing Gmail credentials and rejects non-local Mailpit hosts', () => {
        const parsed = envSchema.parse({
            ...baseEnv,
            SMTP_HOST: 'smtp.gmail.com',
            SMTP_PORT: '587',
            SMTP_USER: 'preserved.gmail@example.com',
            SMTP_PASSWORD: 'PreservedGmailAppPassword!',
            MAILPIT_ENABLED: 'true',
            MAILPIT_SMTP_HOST: '127.0.0.1',
            MAILPIT_SMTP_PORT: '1025',
            MAILPIT_HTTP_URL: 'http://127.0.0.1:8025',
        });
        expect(parsed.MAILPIT_ENABLED).toBe(true);
        expect(parsed.SMTP_HOST).toBe('smtp.gmail.com');
        expect(parsed.SMTP_USER).toBe('preserved.gmail@example.com');

        // Rejects non-localhost MAILPIT_SMTP_HOST when MAILPIT_ENABLED=true
        expect(() =>
            envSchema.parse({
                ...baseEnv,
                MAILPIT_ENABLED: 'true',
                MAILPIT_SMTP_HOST: 'smtp.external.example.com',
            }),
        ).toThrow(/MAILPIT_SMTP_HOST must be bound to localhost/);

        const devService = new EmailOutboxService(
            { query: vi.fn() } as unknown as DataSource,
            new ConfigService({
                NODE_ENV: 'development',
                SMTP_HOST: 'smtp.gmail.com',
                SMTP_PORT: 587,
                SMTP_USER: 'preserved.gmail@example.com',
                SMTP_PASSWORD: 'PreservedGmailAppPassword!',
                MAILPIT_ENABLED: 'true',
                MAILPIT_SMTP_HOST: '127.0.0.1',
                MAILPIT_SMTP_PORT: 1025,
            }),
        );

        const devSnapshot = devService.getSmtpConfigSnapshot();
        expect(devSnapshot.configured).toBe(true);
        expect(devSnapshot.host).toBe('127.0.0.1');
        expect(devSnapshot.port).toBe(1025);
        expect(devSnapshot.secure).toBe(false);
        expect(devSnapshot.authEnabled).toBe(false);
        expect(devSnapshot.user).toBeNull();

        // In production, MAILPIT_ENABLED is ignored and standard SMTP config is used
        const prodService = new EmailOutboxService(
            { query: vi.fn() } as unknown as DataSource,
            new ConfigService({
                NODE_ENV: 'production',
                SMTP_HOST: 'smtp.gmail.com',
                SMTP_PORT: 587,
                SMTP_USER: 'preserved.gmail@example.com',
                SMTP_PASSWORD: 'PreservedGmailAppPassword!',
                MAILPIT_ENABLED: 'true',
                MAILPIT_SMTP_HOST: '127.0.0.1',
                MAILPIT_SMTP_PORT: 1025,
            }),
        );

        const prodSnapshot = prodService.getSmtpConfigSnapshot();
        expect(prodSnapshot.host).toBe('smtp.gmail.com');
        expect(prodSnapshot.port).toBe(587);
        expect(prodSnapshot.authEnabled).toBe(true);
    });

    it('distinguishes test recipients from real inboxes and routes appropriately', () => {
        expect(isTestRecipient('client@luxuar-test.hu')).toBe(true);
        expect(isTestRecipient('test@example.com')).toBe(true);
        expect(isTestRecipient('user@sub.example.org')).toBe(true);
        expect(isTestRecipient('user@dev.test')).toBe(true);
        expect(isTestRecipient('admin@localhost')).toBe(true);

        expect(isTestRecipient('bensalah.soulaymen@gmail.com')).toBe(false);
        expect(isTestRecipient('client@yahoo.com')).toBe(false);
        expect(isTestRecipient('john.doe@company.fr')).toBe(false);

        const devService = new EmailOutboxService(
            { query: vi.fn() } as unknown as DataSource,
            new ConfigService({
                NODE_ENV: 'development',
                SMTP_HOST: 'smtp.gmail.com',
                SMTP_PORT: 587,
                SMTP_USER: 'luxurycarsrentcars@gmail.com',
                SMTP_PASSWORD: 'app-password',
                MAILPIT_ENABLED: 'true',
                MAILPIT_SMTP_HOST: '127.0.0.1',
                MAILPIT_SMTP_PORT: 1025,
            }),
        );

        // Test recipient routes to Mailpit
        const testSnap = devService.getSmtpConfigSnapshot('client@luxuar-test.hu');
        expect(testSnap.host).toBe('127.0.0.1');
        expect(testSnap.port).toBe(1025);
        expect(testSnap.authEnabled).toBe(false);

        // Real recipient routes to real Gmail SMTP
        const realSnap = devService.getSmtpConfigSnapshot('bensalah.soulaymen@gmail.com');
        expect(realSnap.host).toBe('smtp.gmail.com');
        expect(realSnap.port).toBe(587);
        expect(realSnap.authEnabled).toBe(true);
        expect(realSnap.user).toBe('luxurycarsrentcars@gmail.com');

        // Fallback when SMTP_HOST is not configured: routes to Mailpit even for real addresses
        const offlineDevService = new EmailOutboxService(
            { query: vi.fn() } as unknown as DataSource,
            new ConfigService({
                NODE_ENV: 'development',
                MAILPIT_ENABLED: 'true',
                MAILPIT_SMTP_HOST: '127.0.0.1',
                MAILPIT_SMTP_PORT: 1025,
            }),
        );
        const fallbackSnap = offlineDevService.getSmtpConfigSnapshot('bensalah.soulaymen@gmail.com');
        expect(fallbackSnap.host).toBe('127.0.0.1');
        expect(fallbackSnap.port).toBe(1025);
    });
});
