import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { envSchema } from '../config/env.schema.js';
import type { Reservation } from '../reservations/entities/reservation.entity.js';
import {
    dotStuffBody,
    EmailOutboxService,
    extractEnvelopeAddress,
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
});
