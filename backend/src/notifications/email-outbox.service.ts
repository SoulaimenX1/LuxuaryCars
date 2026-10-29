import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { renderLuxuarEmailHtml, renderLuxuarEmailText } from './templates/luxuar-email-layout.js';
import { DataSource } from 'typeorm';
import type { Reservation } from '../reservations/entities/reservation.entity.js';

export type TransactionalEmailTemplate =
    | 'booking_created'
    | 'booking_approved_awaiting_payment'
    | 'booking_confirmed'
    | 'booking_cancelled'
    | 'booking_cancelled_unpaid'
    | 'booking_rejected'
    | 'booking_no_show'
    | 'vehicle_handover'
    | 'check_in_code'
    | 'check_in_completed'
    | 'vehicle_returned'
    | 'rental_closed'
    | 'deposit_refunded'
    | 'email_verification'
    | 'password_reset';

export interface EmailMessagePayload {
    outboxId: string;
    to: string;
    from: string;
    subject: string;
    text: string;
    html?: string;
    eventKey: string | null;
    templateType: string | null;
}

export interface EmailTransport {
    sendMail(payload: EmailMessagePayload): Promise<{ messageId?: string }>;
}

export interface EnqueueEmailInput {
    customerId: string;
    eventKey: string;
    templateType: TransactionalEmailTemplate;
    subject: string;
    message: string;
    recipientEmail?: string | null;
    notificationId?: string | null;
    maxAttempts?: number;
}

export interface OutboxProcessResult {
    claimed: number;
    sent: number;
    retried: number;
    failed: number;
}

export interface SmtpConfigSnapshot {
    configured: boolean;
    host: string | null;
    port: number;
    secure: boolean;
    authEnabled: boolean;
    user: string | null;
    from: string;
    timeoutMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    scanIntervalMs: number;
}

interface OutboxRow {
    id: string;
    customer_id: string;
    recipient_email: string | null;
    user_email: string | null;
    subject: string;
    message: string;
    event_key: string | null;
    template_type: string | null;
    notification_id: string | null;
    attempt_count: number;
    max_attempts: number;
}

const EMAIL_REGEX = /^[^\s@<\r\n]+@[^\s@>\r\n]+\.[^\s@>\r\n]+$/;

export function sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim();
}

export function extractEnvelopeAddress(headerAddress: string): string {
    const clean = sanitizeHeaderValue(headerAddress);
    const angleMatch = /<([^<>]+)>/.exec(clean);
    const candidate = (angleMatch ? angleMatch[1] : clean).trim();
    if (!EMAIL_REGEX.test(candidate)) {
        throw new Error(`Invalid email address format: ${candidate}`);
    }
    return candidate;
}

export function dotStuffBody(text: string): string {
    const normalized = text.replace(/\r?\n/g, '\r\n');
    return normalized
        .split('\r\n')
        .map((line) => (line.startsWith('.') ? `.${line}` : line))
        .join('\r\n');
}

@Injectable()
export class EmailOutboxService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(EmailOutboxService.name);
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;
    private schemaEnsured = false;
    private customTransport: EmailTransport | null = null;

    constructor(
        private readonly db: DataSource,
        @Optional()
        private readonly configService?: ConfigService,
    ) {}

    onModuleInit(): void {
        const nodeEnv =
            this.configService?.get<string>('NODE_ENV') ??
            process.env.NODE_ENV ??
            'development';
        if (nodeEnv === 'test') {
            return;
        }
        const intervalMs = this.getScanIntervalMs();
        this.startScheduler(intervalMs);
        void this.processOutboxBatch().catch((error) => {
            this.logger.warn(
                `Initial transactional email outbox scan failed: ${this.sanitizeError(error)}`,
            );
        });
    }

    onModuleDestroy(): void {
        this.stopScheduler();
    }

    startScheduler(intervalMs = this.getScanIntervalMs()): void {
        this.stopScheduler();
        const safeInterval =
            Number.isFinite(intervalMs) && intervalMs >= 1_000
                ? Math.floor(intervalMs)
                : 30_000;
        this.timer = setInterval(() => {
            void this.processOutboxBatch().catch((error) => {
                this.logger.error(
                    `Scheduled email outbox scan failed: ${this.sanitizeError(error)}`,
                );
            });
        }, safeInterval);
        this.timer.unref?.();
    }

    stopScheduler(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    setTransport(transport: EmailTransport | null): void {
        this.customTransport = transport;
    }

    getSmtpConfigSnapshot(): SmtpConfigSnapshot {
        const host = this.getEnvString('SMTP_HOST');
        const user = this.getEnvString('SMTP_USER');
        const password = this.getEnvString('SMTP_PASSWORD');
        return {
            configured: Boolean(host),
            host: host ?? null,
            port: this.getEnvNumber('SMTP_PORT', 587),
            secure: this.getEnvBoolean('SMTP_SECURE', false),
            authEnabled: Boolean(user && password),
            user: user ?? null,
            from: sanitizeHeaderValue(
                this.getEnvString('SMTP_FROM') ??
                    'LUXUAR Concierge <no-reply@luxuar.hu>',
            ),
            timeoutMs: this.getEnvNumber('SMTP_TIMEOUT_MS', 10_000),
            maxAttempts: this.getMaxAttempts(),
            baseDelayMs: this.getBaseDelayMs(),
            scanIntervalMs: this.getScanIntervalMs(),
        };
    }

    computeRetryDelayMs(attemptNumber: number): number {
        const base = this.getBaseDelayMs();
        const exponent = Math.max(0, Math.min(attemptNumber - 1, 10));
        return base * Math.pow(2, exponent);
    }

    sanitizeError(error: unknown): string {
        const raw =
            error instanceof Error
                ? error.message
                : typeof error === 'string'
                  ? error
                  : 'Email delivery error';
        let sanitized = raw.replace(/[\r\n]+/g, ' ').trim();
        const password = this.getEnvString('SMTP_PASSWORD');
        const user = this.getEnvString('SMTP_USER');
        if (password && password.length > 0) {
            sanitized = sanitized.split(password).join('[REDACTED]');
            const base64Pass = Buffer.from(password, 'utf8').toString('base64');
            sanitized = sanitized.split(base64Pass).join('[REDACTED]');
        }
        if (user && password) {
            const plainToken = Buffer.from(
                `\u0000${user}\u0000${password}`,
                'utf8',
            ).toString('base64');
            sanitized = sanitized.split(plainToken).join('[REDACTED]');
        }
        return sanitized.slice(0, 500);
    }

    async ensureSchema(): Promise<void> {
        if (this.schemaEnsured) return;
        try {
            await this.db.query(`
                ALTER TABLE customer_email_outbox
                  ADD COLUMN IF NOT EXISTS event_key varchar(180),
                  ADD COLUMN IF NOT EXISTS template_type varchar(40),
                  ADD COLUMN IF NOT EXISTS recipient_email varchar(255),
                  ADD COLUMN IF NOT EXISTS notification_id uuid REFERENCES user_notifications(id) ON DELETE SET NULL,
                  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
                  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
                  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
                  ADD COLUMN IF NOT EXISTS last_error text,
                  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
                  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
            `);
            await this.db.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_email_outbox_event_key
                  ON customer_email_outbox (customer_id, event_key)
                  WHERE event_key IS NOT NULL
            `);
            await this.db.query(`
                CREATE INDEX IF NOT EXISTS idx_customer_email_outbox_dispatch
                  ON customer_email_outbox (status, next_attempt_at, created_at)
                  WHERE status = 'pending'
            `);
            this.schemaEnsured = true;
        } catch {
            this.schemaEnsured = true;
        }
    }

    /**
     * Enqueues a transactional email idempotently.
     * Uses `(customer_id, event_key)` unique partial index so duplicate triggers
     * for the same domain event never produce duplicate emails.
     */
    async enqueueEmail(
        input: EnqueueEmailInput,
    ): Promise<{ id: string | null; deduplicated: boolean }> {
        await this.ensureSchema();

        const maxAttempts = input.maxAttempts ?? this.getMaxAttempts();
        const subject = sanitizeHeaderValue(input.subject).slice(0, 200);
        const eventKey = input.eventKey.trim().slice(0, 180);

        // If `ReservationsService.createReservation` already inserted a legacy row
        // without `event_key` for this exact customer and subject, upgrade that row
        // in place instead of creating a duplicate outbox record.
        if (input.templateType === 'booking_created') {
            const upgraded = await this.db.query(
                `UPDATE customer_email_outbox
                 SET event_key = $3,
                     template_type = $4,
                     notification_id = COALESCE(notification_id, $5::uuid),
                     max_attempts = $6,
                     updated_at = now()
                 WHERE id = (
                     SELECT id FROM customer_email_outbox
                     WHERE customer_id = $1::uuid
                       AND subject = $2
                       AND event_key IS NULL
                     ORDER BY created_at DESC
                     LIMIT 1
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM customer_email_outbox
                     WHERE customer_id = $1::uuid AND event_key = $3
                 )
                 RETURNING id`,
                [
                    input.customerId,
                    subject,
                    eventKey,
                    input.templateType,
                    input.notificationId ?? null,
                    maxAttempts,
                ],
            );
            const upgradedRows: { id: string }[] = Array.isArray(upgraded?.[0])
                ? upgraded[0]
                : upgraded ?? [];
            if (upgradedRows[0]?.id) {
                if (input.notificationId) {
                    await this.recordDeliveryLog(
                        input.notificationId,
                        'queued',
                        null,
                    );
                }
                return { id: upgradedRows[0].id, deduplicated: false };
            }
        }

        const inserted: { id: string; notification_id: string | null }[] =
            await this.db.query(
                `INSERT INTO customer_email_outbox
                    (customer_id, recipient_email, subject, message, status,
                     event_key, template_type, notification_id, attempt_count,
                     max_attempts, next_attempt_at, updated_at)
                 SELECT u.id,
                        COALESCE($2::varchar, u.email),
                        $3::varchar,
                        $4::text,
                        'pending',
                        $5::varchar,
                        $6::varchar,
                        $7::uuid,
                        0,
                        $8::int,
                        now(),
                        now()
                 FROM users u
                 WHERE u.id = $1::uuid
                   AND u.status = 'active'
                 ON CONFLICT (customer_id, event_key)
                 WHERE event_key IS NOT NULL
                 DO NOTHING
                 RETURNING id, notification_id`,
                [
                    input.customerId,
                    input.recipientEmail ?? null,
                    subject,
                    input.message,
                    eventKey,
                    input.templateType,
                    input.notificationId ?? null,
                    maxAttempts,
                ],
            );

        if (!inserted?.[0]?.id) {
            return { id: null, deduplicated: true };
        }

        if (inserted[0].notification_id) {
            await this.recordDeliveryLog(
                inserted[0].notification_id,
                'queued',
                null,
            );
        }

        return { id: inserted[0].id, deduplicated: false };
    }

    /**
     * Claims due pending emails using `FOR UPDATE SKIP LOCKED` and dispatches them.
     * Failed deliveries are retried with exponential backoff up to `max_attempts`.
     */
    async processOutboxBatch(limit = 25): Promise<OutboxProcessResult> {
        if (this.running) {
            return { claimed: 0, sent: 0, retried: 0, failed: 0 };
        }
        this.running = true;
        try {
            await this.ensureSchema();
            const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);

            const claimed: OutboxRow[] = await this.db.transaction(
                async (manager) => {
                    const dueRows: OutboxRow[] = await manager.query(
                        `SELECT o.id,
                                o.customer_id,
                                o.recipient_email,
                                u.email AS user_email,
                                o.subject,
                                o.message,
                                o.event_key,
                                o.template_type,
                                o.notification_id,
                                COALESCE(o.attempt_count, 0) AS attempt_count,
                                COALESCE(o.max_attempts, $1::int) AS max_attempts
                         FROM customer_email_outbox o
                         JOIN users u ON u.id = o.customer_id
                         WHERE o.status = 'pending'
                           AND COALESCE(o.next_attempt_at, o.created_at, now()) <= now()
                           AND COALESCE(o.attempt_count, 0) < COALESCE(o.max_attempts, $1::int)
                           AND (o.locked_at IS NULL OR o.locked_at < now() - interval '5 minutes')
                         ORDER BY COALESCE(o.next_attempt_at, o.created_at) ASC, o.created_at ASC
                         LIMIT $2
                         FOR UPDATE OF o SKIP LOCKED`,
                        [this.getMaxAttempts(), safeLimit],
                    );

                    if (dueRows.length > 0) {
                        const ids = dueRows.map((row) => row.id);
                        await manager.query(
                            `UPDATE customer_email_outbox
                             SET locked_at = now(), updated_at = now()
                             WHERE id = ANY($1::uuid[])`,
                            [ids],
                        );
                    }
                    return dueRows;
                },
            );

            let sent = 0;
            let retried = 0;
            let failed = 0;
            const snapshot = this.getSmtpConfigSnapshot();
            const transport =
                this.customTransport ?? this.createDefaultTransport(snapshot);

            for (const row of claimed) {
                const nextAttemptCount = Number(row.attempt_count ?? 0) + 1;
                const maxAttempts = Number(
                    row.max_attempts ?? this.getMaxAttempts(),
                );
                const recipient = (
                    row.recipient_email ??
                    row.user_email ??
                    ''
                ).trim();

                try {
                    const toAddress = extractEnvelopeAddress(recipient);
                    let html: string | undefined;
                    try {
                        if (row.template_type === 'booking_created') {
                        const frontendBase = (this.configService?.get<string>('FRONTEND_URL') ?? process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '');
                        const resMatch = row.message.match(/reservation request ([A-Z0-9\-]+)/i) || row.subject.match(/([A-Z0-9\-]{6,})/);
                        const resNum = resMatch ? resMatch[1] : '';
                        const resUrl = resNum ? `${frontendBase}/account/reservations/${resNum}` : `${frontendBase}/account/reservations`;
                        const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                        const nameMatch = row.message.match(/Dear ([^,\n]+)/);
                        const customerName = nameMatch ? nameMatch[1] : 'Valued Client';
                        const vehicleMatch = row.message.match(/for ([^\n\.]+)/i);
                        const vehicleName = vehicleMatch ? vehicleMatch[1] : '';
                        const pickupMatch = row.message.match(/Pickup Date: ([^\n]+)/i);
                        const returnMatch = row.message.match(/Return Date: ([^\n]+)/i);
                        const agencyMatch = row.message.match(/Agency: ([^\n]+)/i);
                        const pickupAt = pickupMatch ? pickupMatch[1].trim() : '';
                        const returnAt = returnMatch ? returnMatch[1].trim() : '';
                        const agency = agencyMatch ? agencyMatch[1].trim() : 'Assigned LUXUAR Agency';
                        
                        const photoHtml = '';
                        const vehicleLine = vehicleName ? `<p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1D1B18;"><strong>${esc(vehicleName)}</strong></p>` : '';
                        
                        html = renderLuxuarEmailHtml({
                            title: 'Your journey begins here.',
                            preheader: 'Reservation Received — Pending Approval',
                            bodyHtml: `<p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#B9975B;">RESERVATION RECEIVED</p>
<p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1D1B18;">Dear ${esc(customerName)},</p>
<p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1D1B18;">Thank you for choosing LUXUAR. We have received your reservation request${resNum ? ` <strong>${esc(resNum)}</strong>` : ''}${vehicleName ? ` for <strong>${esc(vehicleName)}</strong>` : ''}.</p>
<p style="margin:0 0 24px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1D1B18;">Your request is currently under review. Approval is required before payment, and you will receive a follow-up email once your reservation is approved or declined.</p>
${photoHtml}
${vehicleLine}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F9F6F1;border:1px solid #E6DFD3;margin:24px 0 28px 0;">
  <tr><td style="padding:28px 28px 22px 28px;">
    <p style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',Times,serif;font-size:18px;line-height:26px;color:#171512;">Reservation Summary</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Reservation reference</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(resNum)}</td></tr>
      ${pickupAt ? `<tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Pickup date</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(pickupAt)}</td></tr>` : ''}
      ${returnAt ? `<tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Return date</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(returnAt)}</td></tr>` : ''}
      <tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Collection agency</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(agency)}</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Current status</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#B9975B;">PENDING APPROVAL</td></tr>
    </table>
  </td></tr>
</table>
<p style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1D1B18;"><strong>Next steps</strong></p>
<p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1D1B18;">Our team is reviewing your request. You will receive a follow-up email once your reservation is approved or declined.</p>`,
                            bodyText: row.message,
                            ctaLabel: 'VIEW MY RESERVATION',
                            ctaUrl: resUrl,
                        });
                        } else {
                            html = renderLuxuarEmailHtml({
                                title: sanitizeHeaderValue(row.subject),
                                preheader: sanitizeHeaderValue(row.subject),
                                bodyHtml: row.message.replace(/\n/g, '<br/>'),
                                bodyText: row.message,
                            });
                        }
                    } catch {
                        html = undefined;
                    }
                    await transport.sendMail({
                        outboxId: row.id,
                        to: toAddress,
                        from: snapshot.from,
                        subject: sanitizeHeaderValue(row.subject),
                        text: row.message,
                        html,
                        eventKey: row.event_key ?? null,
                        templateType: row.template_type ?? null,
                    });

                    await this.db.query(
                        `UPDATE customer_email_outbox
                         SET status = 'sent',
                             recipient_email = COALESCE(recipient_email, $2),
                             sent_at = now(),
                             attempt_count = $3,
                             last_error = NULL,
                             locked_at = NULL,
                             updated_at = now()
                         WHERE id = $1::uuid`,
                        [row.id, toAddress, nextAttemptCount],
                    );

                    if (row.notification_id) {
                        await this.recordDeliveryLog(
                            row.notification_id,
                            'sent',
                            null,
                        );
                    }
                    sent += 1;
                } catch (error) {
                    const sanitizedError = this.sanitizeError(error);
                    const exhausted = nextAttemptCount >= maxAttempts;

                    if (exhausted) {
                        await this.db.query(
                            `UPDATE customer_email_outbox
                             SET status = 'failed',
                                 attempt_count = $2,
                                 last_error = $3,
                                 locked_at = NULL,
                                 updated_at = now()
                             WHERE id = $1::uuid`,
                            [row.id, nextAttemptCount, sanitizedError],
                        );
                        failed += 1;
                    } else {
                        const delayMs =
                            this.computeRetryDelayMs(nextAttemptCount);
                        await this.db.query(
                            `UPDATE customer_email_outbox
                             SET status = 'pending',
                                 attempt_count = $2,
                                 next_attempt_at = now() + ($3::bigint * interval '1 millisecond'),
                                 last_error = $4,
                                 locked_at = NULL,
                                 updated_at = now()
                             WHERE id = $1::uuid`,
                            [
                                row.id,
                                nextAttemptCount,
                                delayMs,
                                sanitizedError,
                            ],
                        );
                        retried += 1;
                    }

                    if (row.notification_id) {
                        await this.recordDeliveryLog(
                            row.notification_id,
                            'failed',
                            sanitizedError,
                        );
                    }
                    this.logger.warn(
                        `Transactional email outbox item ${row.id} failed (attempt ${nextAttemptCount}/${maxAttempts}): ${sanitizedError}`,
                    );
                }
            }

            return {
                claimed: claimed.length,
                sent,
                retried,
                failed,
            };
        } finally {
            this.running = false;
        }
    }

    /**
     * Enqueues and dispatches transactional emails for reservation lifecycle events:
     * - `confirmed`: Booking confirmation email
     * - `cancelled`: Booking cancellation email
     * - `rejected`: Booking declined/cancelled email
     * - `created`: Upgrades/deduplicates initial reservation request email
     */
    async notifyReservationEvent(
        event: 'created' | 'confirmed' | 'rejected' | 'cancelled' | 'awaiting_payment' | 'cancelled_unpaid' | 'active_rental' | 'completed',
        reservation: Pick<
            Reservation,
            'id' | 'customerId' | 'reservationNumber' | 'decisionReason'
        >,
    ): Promise<void> {
        await this.ensureSchema();
        const details = await this.loadReservationDetails(reservation.id);
        const reservationNumber =
            details?.reservationNumber ?? reservation.reservationNumber;
        const customerId = details?.customerId ?? reservation.customerId;
        const customerName = details?.customerName || 'Valued Client';
        const vehicleName = details?.vehicleName || 'your selected vehicle';
        const pickupLocation =
            details?.pickupLocation || 'Assigned LUXUAR Agency';
        const returnLocation = details?.returnLocation || pickupLocation;
        const pickupAtIso = details?.pickupAt
            ? new Date(details.pickupAt).toISOString()
            : null;
        const returnAtIso = details?.returnAt
            ? new Date(details.returnAt).toISOString()
            : null;
        const pickupAt = pickupAtIso
            ? new Date(pickupAtIso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Scheduled pick-up';
        const returnAt = returnAtIso
            ? new Date(returnAtIso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Scheduled return';
        const totalAmount = details?.totalAmount
            ? `EUR ${Number(details.totalAmount).toFixed(2)}`
            : 'As quoted';
        const notificationId = await this.findNotificationId(
            customerId,
            `reservation:${reservation.id}:${event}:customer`,
        );

        const rawRental = Number(details?.totalAmount || 0);
        const rawDeposit = Number(details?.depositAmount || 0);
        const grandTotal = `EUR ${(rawRental + rawDeposit).toFixed(2)}`;
        const depositFormatted = `EUR ${rawDeposit.toFixed(2)}`;
        const frontendBase = (this.configService?.get<string>('FRONTEND_URL') ?? process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '');
        const paymentUrl = `${frontendBase}/account/payments/${reservationNumber}`;
        const reservationUrl = `${frontendBase}/account/reservations/${reservationNumber}`;

        if (event === 'awaiting_payment') {
            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:awaiting_payment`,
                templateType: 'booking_approved_awaiting_payment',
                notificationId,
                subject: `Reservation Approved — Payment Required`,
                message: [
                    `Dear ${customerName},`,
                    '',
                    `Your reservation request ${reservationNumber} has been approved by LUXUAR Concierge!`,
                    '',
                    'RESERVATION SUMMARY:',
                    `• Reservation Reference: ${reservationNumber}`,
                    `• Vehicle: ${vehicleName}`,
                    `• Rental Dates: ${pickupAt} to ${returnAt}`,
                    `• Rental Price: ${totalAmount}`,
                    `• Refundable Security Deposit: ${depositFormatted}`,
                    `• Grand Total Payable: ${grandTotal}`,
                    '',
                    'PAYMENT DEADLINE: You have exactly 24 hours to complete your secure payment.',
                    'Please click the secure button below to complete checkout via Stripe:',
                    paymentUrl,
                    '',
                    'Once verified by Stripe, your reservation will immediately transition to CONFIRMED.',
                    '',
                    'LUXUAR Concierge Team',
                ].join('\n'),
            });
        } else if (event === 'cancelled_unpaid') {
            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:cancelled_unpaid`,
                templateType: 'booking_cancelled_unpaid',
                notificationId,
                subject: `Reservation Cancelled — Payment Deadline Expired`,
                message: [
                    `Dear ${customerName},`,
                    '',
                    `The 24-hour payment window for reservation ${reservationNumber} (${vehicleName}) has expired without verified payment.`,
                    'In accordance with LUXUAR policy, the vehicle hold has been released and the reservation is now CANCELLED_UNPAID.',
                    '',
                    'You are welcome to select another vehicle or submit a new reservation request at any time at /vehicles.',
                    '',
                    'LUXUAR Concierge Team',
                ].join('\n'),
            });
        } else if (event === 'active_rental') {
            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:active_rental`,
                templateType: 'vehicle_handover',
                notificationId,
                subject: `Vehicle Active Rental Started — LUXUAR ${reservationNumber}`,
                message: [
                    `Dear ${customerName},`,
                    '',
                    `Your rental for ${vehicleName} (Reservation ${reservationNumber}) is now active.`,
                    `Scheduled return: ${returnAt} at ${returnLocation}.`,
                    '',
                    'Have an exceptional journey with LUXUAR.',
                    '',
                    'LUXUAR Concierge Team',
                ].join('\n'),
            });
        } else if (event === 'completed') {
            const refundedAmount = details?.depositRefundedAmount != null ? `EUR ${Number(details.depositRefundedAmount).toFixed(2)}` : 'EUR 0.00';
            const retainedAmount = details?.depositRetainedAmount != null ? `EUR ${Number(details.depositRetainedAmount).toFixed(2)}` : 'EUR 0.00';
            const reason = details?.depositRetentionReason?.trim() || (Number(details?.depositRetainedAmount || 0) > 0 ? 'Documented vehicle return damage' : 'No damage detected');
            const status = details?.depositRefundStatus || 'refunded';

            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:completed`,
                templateType: 'deposit_refunded',
                notificationId,
                subject: `Rental Completed & Security Deposit Processed`,
                message: [
                    `Dear ${customerName},`,
                    '',
                    `The return of vehicle ${vehicleName} for reservation ${reservationNumber} has been finalized.`,
                    '',
                    'ITEMIZED SECURITY DEPOSIT STATEMENT:',
                    `• Initial Security Deposit: ${depositFormatted}`,
                    `• Documented Deduction: ${retainedAmount}`,
                    `• Reason / Notes: ${reason}`,
                    `• Refunded Amount: ${refundedAmount}`,
                    `• Stripe Refund Status: ${status}`,
                    '',
                    'View your full financial receipt and rental history at:',
                    paymentUrl,
                    '',
                    'Thank you for traveling with LUXUAR. We look forward to your next journey.',
                    '',
                    'LUXUAR Concierge Team',
                ].join('\n'),
            });
        } else if (event === 'confirmed') {
            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:confirmed`,
                templateType: 'booking_confirmed',
                notificationId,
                subject: `Reservation Confirmed — Payment Received — Reservation ${reservationNumber} confirmed — LUXUAR`,
                message: [
                    `Dear ${customerName},`,
                    '',
                    `Your payment for reservation ${reservationNumber} has been successfully verified via Stripe!`,
                    '',
                    'BOOKING DETAILS:',
                    `• Reservation Reference: ${reservationNumber}`,
                    `• Vehicle: ${vehicleName}`,
                    `• Pick-up Date: ${pickupAt} (${pickupLocation})`,
                    `• Return Date: ${returnAt} (${returnLocation})`,
                    `• Total Paid: ${grandTotal} (Rental: ${totalAmount} + Deposit: ${depositFormatted})`,
                    '',
                    'Your receipt and booking voucher are available at:',
                    paymentUrl,
                    '',
                    'We look forward to welcoming you.',
                    '',
                    'LUXUAR Concierge Team',
                ].join('\n'),
            });
        } else if (event === 'cancelled') {
            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:cancelled`,
                templateType: 'booking_cancelled',
                notificationId,
                subject: `Reservation Cancelled — Reservation ${reservationNumber} cancelled — LUXUAR`,
                message: [
                    `Dear ${customerName},`,
                    '',
                    `Your reservation ${reservationNumber} for ${vehicleName} has been cancelled.`,
                    `Scheduled pick-up: ${pickupAt} (${pickupLocation})`,
                    '',
                    'If you wish to make a new booking, please visit /vehicles.',
                    '',
                    'LUXUAR Concierge Team',
                ].join('\n'),
            });
        } else if (event === 'rejected') {
            const reason =
                reservation.decisionReason?.trim() ||
                details?.decisionReason?.trim() ||
                'Vehicle scheduling conflict';
            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:rejected`,
                templateType: 'booking_rejected',
                notificationId,
                subject: `Reservation Request Declined`,
                message: [
                    `Dear ${customerName},`,
                    '',
                    `Thank you for your interest in LUXUAR. Regrettably, your reservation request ${reservationNumber} for ${vehicleName} could not be approved at this time.`,
                    `Reason: ${reason}.`,
                    '',
                    'No payment was collected, and any provisional hold on your vehicle has been released.',
                    'We warmly invite you to select another vehicle from our fleet:',
                    `${(this.configService?.get<string>('FRONTEND_URL') ?? 'http://localhost:3000').replace(/\/$/, '')}/vehicles`,
                    '',
                    'LUXUAR Concierge Team',
                ].join('\n'),
            });
        } else if (event === 'created') {
            const vehicleImagePath = details?.vehicleImageUrl ?? null;
            let vehicleImageUrl: string | null = null;
            if (vehicleImagePath) {
                if (vehicleImagePath.startsWith('http://') || vehicleImagePath.startsWith('https://')) {
                    vehicleImageUrl = vehicleImagePath;
                } else if (vehicleImagePath.startsWith('/')) {
                    vehicleImageUrl = `${frontendBase}${vehicleImagePath}`;
                } else {
                    vehicleImageUrl = `${frontendBase}/vehicles/${vehicleImagePath.replace(/^.*[\\/]/, '')}`;
                }
            }

            const photoHtml = vehicleImageUrl
                ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 24px 0;"><tr><td align="center" style="background-color:#F7F4EF;"><img src="${vehicleImageUrl.replace(/"/g, '&quot;')}" alt="Selected vehicle: ${String(vehicleName).replace(/"/g, '&quot;')}" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;max-height:260px;object-fit:cover;" /></td></tr></table>`
                : '';

            const esc = (s: string) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            const summaryCardHtml = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F9F6F1;border:1px solid #E6DFD3;margin:24px 0;"><tr><td style="padding:28px 28px 20px 28px;"><p style="margin:0 0 18px 0;font-family:\'Times New Roman\',Times,serif;font-size:18px;line-height:26px;color:#171512;">Reservation Summary</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Vehicle</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(vehicleName)}</td></tr><tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Reference</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(reservationNumber)}</td></tr><tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Pickup Date</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(pickupAt)}</td></tr><tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Return Date</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(returnAt)}</td></tr><tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Status</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#B08B52;">Pending Approval</td></tr><tr><td style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8B8472;">Agency</td><td align="right" style="padding:10px 0;border-top:1px solid #E6DFD3;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#171512;">${esc(pickupLocation || 'Assigned LUXUAR Agency')}</td></tr></table></td></tr></table>`;

            const bodyHtml = `<p style="margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#B08B52;">RESERVATION RECEIVED</p><h1 style="margin:0 0 18px 0;font-family:\'Times New Roman\',Times,serif;font-size:32px;line-height:40px;font-weight:400;color:#171512;letter-spacing:0.01em;">Your journey begins here.</h1><p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:26px;color:#171512;">Dear ${esc(customerName)},</p><p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:26px;color:#171512;">Thank you for choosing LUXUAR. We have received your reservation request <strong>${esc(reservationNumber)}</strong> for <strong>${esc(vehicleName)}</strong>.</p><p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:26px;color:#171512;">Your request is currently under review. Approval is required before payment, and you will receive a follow-up email once your reservation is approved or declined.</p>${photoHtml}${summaryCardHtml}<p style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:26px;color:#171512;"><strong>Next step</strong></p><p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:26px;color:#171512;">Our team is reviewing your request. You will receive a follow-up email once your reservation is approved or declined.</p>`;

            const bodyText = [
                `RESERVATION RECEIVED`,
                ``,
                `Your journey begins here.`,
                ``,
                `Dear ${customerName},`,
                ``,
                `Thank you for choosing LUXUAR. We have received your reservation request ${reservationNumber} for ${vehicleName}.`,
                ``,
                `Your request is currently under review. Approval is required before payment, and you will receive a follow-up email once your reservation is approved or declined.`,
                ``,
                `RESERVATION SUMMARY`,
                `- Vehicle: ${vehicleName}`,
                `- Reference: ${reservationNumber}`,
                `- Pickup Date: ${pickupAt}`,
                `- Return Date: ${returnAt}`,
                `- Status: Pending Approval`,
                `- Agency: ${pickupLocation || 'Assigned LUXUAR Agency'}`,
                ``,
                `Next step: Our team is reviewing your request. You will receive a follow-up email once your reservation is approved or declined.`,
                ``,
                `View your reservation: ${reservationUrl}`,
            ].join('\n');

            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:created`,
                templateType: 'booking_created',
                notificationId,
                subject: `Reservation Received — Pending Approval`,
                message: bodyText,
            });
        }

        await this.processOutboxBatch();
    }

    async safelyNotifyReservationEvent(
        event: 'created' | 'confirmed' | 'rejected' | 'cancelled' | 'awaiting_payment' | 'cancelled_unpaid' | 'active_rental' | 'completed',
        reservation: Pick<
            Reservation,
            'id' | 'customerId' | 'reservationNumber' | 'decisionReason'
        >,
    ): Promise<void> {
        try {
            await this.notifyReservationEvent(event, reservation);
        } catch (error) {
            this.logger.warn(
                `Transactional email could not be queued for reservation ${reservation.id} (${event}): ${this.sanitizeError(error)}`,
            );
        }
    }

    /**
     * Enqueues and dispatches a no-show cancellation transactional email.
     */
    async notifyReservationNoShow(
        customerId: string,
        reservationId: string,
    ): Promise<void> {
        await this.ensureSchema();
        const details = await this.loadReservationDetails(reservationId);
        const reservationNumber = details?.reservationNumber ?? reservationId;
        const customerName = details?.customerName || 'Valued Client';
        const vehicleName = details?.vehicleName || 'your reserved vehicle';
        const notificationId = await this.findNotificationId(
            customerId,
            `reservation:${reservationId}:no_show:customer`,
        );

        await this.enqueueEmail({
            customerId,
            recipientEmail: details?.customerEmail ?? null,
            eventKey: `reservation:${reservationId}:no_show`,
            templateType: 'booking_no_show',
            notificationId,
            subject: `Reservation ${reservationNumber} cancelled (no-show) — LUXUAR`,
            message: [
                `Dear ${customerName},`,
                '',
                `Reservation ${reservationNumber} for ${vehicleName} was marked as a no-show because check-in was not completed before the pick-up deadline.`,
                'The reserved vehicle has been released back into fleet availability.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
        });

        await this.processOutboxBatch();
    }

    async safelyNotifyReservationNoShow(
        customerId: string,
        reservationId: string,
    ): Promise<void> {
        try {
            await this.notifyReservationNoShow(customerId, reservationId);
        } catch (error) {
            this.logger.warn(
                `No-show transactional email could not be queued for reservation ${reservationId}: ${this.sanitizeError(error)}`,
            );
        }
    }

    /**
     * Enqueues and dispatches a check-in code email when a customer generates their one-time code.
     */
    async notifyCheckInCodeIssued(input: {
        customerId: string;
        reservationId?: string;
        reservationNumber: string;
        code: string;
        expiresAt: Date | string;
        agencyName?: string;
    }): Promise<void> {
        await this.ensureSchema();
        const normalizedNumber = input.reservationNumber.trim().toUpperCase();
        const details = input.reservationId
            ? await this.loadReservationDetails(input.reservationId)
            : await this.loadReservationDetailsByNumber(normalizedNumber);
        const reservationId =
            input.reservationId ?? details?.reservationId ?? normalizedNumber;
        const customerName = details?.customerName || 'Valued Client';
        const vehicleName = details?.vehicleName || 'your reserved vehicle';
        const pickupLocation =
            input.agencyName ||
            details?.pickupLocation ||
            'Assigned LUXUAR Agency';
        const expiresIso = new Date(input.expiresAt).toISOString();
        const codeFingerprint = createHash('sha256')
            .update(`${reservationId}:${input.code}`)
            .digest('hex')
            .slice(0, 16);

        await this.enqueueEmail({
            customerId: input.customerId,
            recipientEmail: details?.customerEmail ?? null,
            eventKey: `reservation:${reservationId}:checkin_code:${codeFingerprint}`,
            templateType: 'check_in_code',
            subject: `Check-in code for reservation ${normalizedNumber} — LUXUAR`,
            message: [
                `Dear ${customerName},`,
                '',
                `Your one-time check-in code for reservation ${normalizedNumber} (${vehicleName}) is: ${input.code}`,
                `Pick-up agency: ${pickupLocation}`,
                `Code valid until: ${expiresIso}`,
                '',
                'Present this code along with your driving licence and identity document at the agency desk.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
        });

        await this.processOutboxBatch();
    }

    async safelyNotifyCheckInCodeIssued(input: {
        customerId: string;
        reservationId?: string;
        reservationNumber: string;
        code: string;
        expiresAt: Date | string;
        agencyName?: string;
    }): Promise<void> {
        try {
            await this.notifyCheckInCodeIssued(input);
        } catch (error) {
            this.logger.warn(
                `Check-in code email could not be queued for reservation ${input.reservationNumber}: ${this.sanitizeError(error)}`,
            );
        }
    }

    /**
     * Enqueues and dispatches a check-in / handover confirmation email when a rental starts.
     */
    async notifyCheckInCompleted(rentalId: string): Promise<void> {
        await this.ensureSchema();
        const rental = await this.loadRentalDetails(rentalId);
        if (!rental) return;

        const notificationEventKey = `rental:${rental.rentalId}:checked_in:customer`;
        const notificationId = await this.ensureCustomerNotification({
            recipientId: rental.customerId,
            category: 'rentals',
            priority: 'success',
            title: 'Check-in completed — rental active',
            message: `Check-in completed for reservation ${rental.reservationNumber} (contract ${rental.contractNumber}). Enjoy your drive in the ${rental.vehicleName}.`,
            actionUrl: '/account/reservations',
            eventKey: notificationEventKey,
            entityType: 'rental',
            entityId: rental.rentalId,
        });

        await this.enqueueEmail({
            customerId: rental.customerId,
            recipientEmail: rental.customerEmail,
            eventKey: `rental:${rental.rentalId}:checked_in`,
            templateType: 'check_in_completed',
            notificationId,
            subject: `Check-in completed — Contract ${rental.contractNumber} — LUXUAR`,
            message: [
                `Dear ${rental.customerName},`,
                '',
                `Your vehicle check-in and handover for reservation ${rental.reservationNumber} is complete.`,
                `Rental contract: ${rental.contractNumber}`,
                `Vehicle: ${rental.vehicleName}`,
                `Pick-up agency: ${rental.pickupAgencyName}`,
                `Handover time: ${rental.startedAtIso}`,
                `Expected return: ${rental.expectedReturnAtIso} at ${rental.returnAgencyName}`,
                `Recorded pick-up mileage: ${rental.pickupMileageKm ?? 'N/A'} km | Fuel level: ${rental.pickupFuelPct ?? 'N/A'}%`,
                '',
                'Wishing you an exceptional journey.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
        });

        await this.processOutboxBatch();
    }

    async safelyNotifyCheckInCompleted(rentalId: string): Promise<void> {
        try {
            await this.notifyCheckInCompleted(rentalId);
        } catch (error) {
            this.logger.warn(
                `Check-in completed email could not be queued for rental ${rentalId}: ${this.sanitizeError(error)}`,
            );
        }
    }

    /**
     * Enqueues and dispatches a vehicle return confirmation email when a return inspection is registered.
     */
    async notifyVehicleReturned(
        rentalId: string,
        summary?: {
            returnReference?: string;
            automaticChargesEur?: string;
            estimatedDamageAmountEur?: string;
            lateDays?: number;
            excessKm?: number;
            fuelShortfallPct?: number;
        },
    ): Promise<void> {
        await this.ensureSchema();
        const rental = await this.loadRentalDetails(rentalId);
        if (!rental) return;

        const returnRef =
            summary?.returnReference ??
            rental.returnReference ??
            rental.contractNumber;
        const autoCharges = summary?.automaticChargesEur ?? '0.00';
        const damageEst = summary?.estimatedDamageAmountEur ?? '0.00';

        const notificationEventKey = `rental:${rental.rentalId}:returned:customer`;
        const notificationId = await this.ensureCustomerNotification({
            recipientId: rental.customerId,
            category: 'rentals',
            priority: 'info',
            title: 'Vehicle return registered',
            message: `Return ${returnRef} has been recorded for reservation ${rental.reservationNumber} (${rental.vehicleName}).`,
            actionUrl: '/account/reservations',
            eventKey: notificationEventKey,
            entityType: 'rental',
            entityId: rental.rentalId,
        });

        await this.enqueueEmail({
            customerId: rental.customerId,
            recipientEmail: rental.customerEmail,
            eventKey: `rental:${rental.rentalId}:returned`,
            templateType: 'vehicle_returned',
            notificationId,
            subject: `Vehicle return registered — ${returnRef} — LUXUAR`,
            message: [
                `Dear ${rental.customerName},`,
                '',
                `We confirm the return of your ${rental.vehicleName} for reservation ${rental.reservationNumber}.`,
                `Rental contract: ${rental.contractNumber}`,
                `Return reference: ${returnRef}`,
                `Return agency: ${rental.returnAgencyName}`,
                `Returned at: ${rental.returnedAtIso ?? new Date().toISOString()}`,
                `Recorded return mileage: ${rental.returnMileageKm ?? 'N/A'} km | Fuel level: ${rental.returnFuelPct ?? 'N/A'}%`,
                `Automatic return fees: EUR ${autoCharges}`,
                `Estimated new damage assessment: EUR ${damageEst}`,
                '',
                'Thank you for choosing LUXUAR.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
        });

        await this.processOutboxBatch();
    }

    async safelyNotifyVehicleReturned(
        rentalId: string,
        summary?: {
            returnReference?: string;
            automaticChargesEur?: string;
            estimatedDamageAmountEur?: string;
            lateDays?: number;
            excessKm?: number;
            fuelShortfallPct?: number;
        },
    ): Promise<void> {
        try {
            await this.notifyVehicleReturned(rentalId, summary);
        } catch (error) {
            this.logger.warn(
                `Vehicle return email could not be queued for rental ${rentalId}: ${this.sanitizeError(error)}`,
            );
        }
    }

    /**
     * Enqueues and dispatches a final closure confirmation email when a rental is closed.
     */
    async notifyRentalClosed(rentalId: string): Promise<void> {
        await this.ensureSchema();
        const rental = await this.loadRentalDetails(rentalId);
        if (!rental) return;

        const notificationEventKey = `rental:${rental.rentalId}:closed:customer`;
        const notificationId = await this.ensureCustomerNotification({
            recipientId: rental.customerId,
            category: 'rentals',
            priority: 'success',
            title: 'Rental contract closed',
            message: `Rental contract ${rental.contractNumber} for reservation ${rental.reservationNumber} is now closed.`,
            actionUrl: '/account/reservations',
            eventKey: notificationEventKey,
            entityType: 'rental',
            entityId: rental.rentalId,
        });

        await this.enqueueEmail({
            customerId: rental.customerId,
            recipientEmail: rental.customerEmail,
            eventKey: `rental:${rental.rentalId}:closed`,
            templateType: 'rental_closed',
            notificationId,
            subject: `Rental ${rental.contractNumber} closed — LUXUAR`,
            message: [
                `Dear ${rental.customerName},`,
                '',
                `Your rental contract ${rental.contractNumber} (reservation ${rental.reservationNumber}, ${rental.vehicleName}) has been finalized and closed.`,
                'All invoice balances and security deposit settlements have been completed.',
                '',
                'We look forward to welcoming you again.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
        });

        await this.processOutboxBatch();
    }

    async safelyNotifyRentalClosed(rentalId: string): Promise<void> {
        try {
            await this.notifyRentalClosed(rentalId);
        } catch (error) {
            this.logger.warn(
                `Rental closed email could not be queued for rental ${rentalId}: ${this.sanitizeError(error)}`,
            );
        }
    }

    /**
     * Enqueues and dispatches an email verification message linked to a one_time_tokens record.
     */
    async notifyEmailVerification(input: {
        customerId: string;
        recipientEmail?: string | null;
        customerName?: string;
        token: string;
        tokenId: string;
        expiresAt: Date | string;
    }): Promise<void> {
        await this.ensureSchema();
        const expiresIso = new Date(input.expiresAt).toISOString();
        const customerName = input.customerName?.trim() || 'Valued Client';
        const frontendBaseUrl =
            process.env.FRONTEND_URL ||
            process.env.APP_URL ||
            'http://localhost:3000';
        const queryParams = new URLSearchParams({
            token: input.token,
            ...(input.recipientEmail ? { email: input.recipientEmail } : {}),
        });
        const verifyUrl = `${frontendBaseUrl}/verify-email?${queryParams.toString()}`;

        await this.enqueueEmail({
            customerId: input.customerId,
            recipientEmail: input.recipientEmail ?? null,
            eventKey: `auth:email_verification:${input.tokenId}`,
            templateType: 'email_verification',
            subject: 'Verify your email address — LUXUAR',
            message: [
                `Dear ${customerName},`,
                '',
                'Please verify your email address for your LUXUAR account by clicking the link below:',
                verifyUrl,
                '',
                'Or manually paste your one-time verification token:',
                `Verification token: ${input.token}`,
                `Valid until: ${expiresIso}`,
                '',
                'If you did not create a LUXUAR account, you can safely ignore this message.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
        });

        await this.processOutboxBatch();
    }

    async safelyNotifyEmailVerification(input: {
        customerId: string;
        recipientEmail?: string | null;
        customerName?: string;
        token: string;
        tokenId: string;
        expiresAt: Date | string;
    }): Promise<void> {
        try {
            await this.notifyEmailVerification(input);
        } catch (error) {
            this.logger.warn(
                `Email verification message could not be queued for user ${input.customerId}: ${this.sanitizeError(error)}`,
            );
        }
    }

    /**
     * Enqueues and dispatches a password reset message linked to a one_time_tokens record.
     */
    async notifyPasswordReset(input: {
        customerId: string;
        recipientEmail?: string | null;
        customerName?: string;
        token: string;
        tokenId: string;
        expiresAt: Date | string;
    }): Promise<void> {
        await this.ensureSchema();
        const expiresIso = new Date(input.expiresAt).toISOString();
        const customerName = input.customerName?.trim() || 'Valued Client';

        await this.enqueueEmail({
            customerId: input.customerId,
            recipientEmail: input.recipientEmail ?? null,
            eventKey: `auth:password_reset:${input.tokenId}`,
            templateType: 'password_reset',
            subject: 'Password reset request — LUXUAR',
            message: [
                `Dear ${customerName},`,
                '',
                'We received a request to reset the password for your LUXUAR account.',
                `One-time reset token: ${input.token}`,
                `Valid until: ${expiresIso}`,
                '',
                'If you did not request a password reset, no action is needed and your password will remain unchanged.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
        });

        await this.processOutboxBatch();
    }

    async safelyNotifyPasswordReset(input: {
        customerId: string;
        recipientEmail?: string | null;
        customerName?: string;
        token: string;
        tokenId: string;
        expiresAt: Date | string;
    }): Promise<void> {
        try {
            await this.notifyPasswordReset(input);
        } catch (error) {
            this.logger.warn(
                `Password reset email could not be queued for user ${input.customerId}: ${this.sanitizeError(error)}`,
            );
        }
    }

    private async loadReservationDetails(reservationId: string): Promise<{
        reservationId: string;
        customerId: string;
        customerEmail: string | null;
        customerName: string;
        reservationNumber: string;
        vehicleName: string;
        pickupAt: Date | string | null;
        returnAt: Date | string | null;
        totalAmount: string | number | null;
        depositAmount: string | number | null;
        depositRefundedAmount: string | number | null;
        depositRetainedAmount: string | number | null;
        depositRetentionReason: string | null;
        depositRefundStatus: string | null;
        decisionReason: string | null;
        pickupLocation: string | null;
        returnLocation: string | null;
        vehicleImageUrl?: string | null;
    } | null> {
        const rows = await this.db.query(
            `SELECT r.id AS "reservationId",
                    r.customer_id AS "customerId",
                    u.email AS "customerEmail",
                    TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS "customerName",
                    r.reservation_number AS "reservationNumber",
                    TRIM(CONCAT(b.name, ' ', m.name)) AS "vehicleName",
                    r.pickup_at AS "pickupAt",
                    r.return_at AS "returnAt",
                    r.total_amount AS "totalAmount",
                    r.deposit_amount AS "depositAmount",
                    r.deposit_refunded_amount AS "depositRefundedAmount",
                    r.deposit_retained_amount AS "depositRetainedAmount",
                    r.deposit_retention_reason AS "depositRetentionReason",
                    r.deposit_refund_status AS "depositRefundStatus",
                    r.decision_reason AS "decisionReason",
                    COALESCE(pl.name, vl.name) AS "pickupLocation",
                    COALESCE(rl.name, pl.name, vl.name) AS "returnLocation",
                    (SELECT vi.storage_path FROM vehicle_images vi WHERE vi.vehicle_id = v.id ORDER BY vi.is_primary DESC, vi.created_at ASC LIMIT 1) AS "vehicleImageUrl"
             FROM reservations r
             LEFT JOIN users u ON u.id = r.customer_id
             LEFT JOIN vehicles v ON v.id = r.vehicle_id
             LEFT JOIN vehicle_models m ON m.id = v.model_id
             LEFT JOIN brands b ON b.id = m.brand_id
             LEFT JOIN reservation_preferences p ON p.reservation_id = r.id
             LEFT JOIN rental_locations pl ON pl.id = p.pickup_location_id
             LEFT JOIN rental_locations rl ON rl.id = p.dropoff_location_id
             LEFT JOIN rental_locations vl ON vl.id = v.home_location_id
             WHERE r.id = $1::uuid
             LIMIT 1`,
            [reservationId],
        );
        return rows?.[0] ?? null;
    }

    private async loadReservationDetailsByNumber(
        reservationNumber: string,
    ): Promise<{
        reservationId: string;
        customerId: string;
        customerEmail: string | null;
        customerName: string;
        reservationNumber: string;
        vehicleName: string;
        pickupAt: Date | string | null;
        returnAt: Date | string | null;
        totalAmount: string | number | null;
        decisionReason: string | null;
        pickupLocation: string | null;
        returnLocation: string | null;
        vehicleImageUrl?: string | null;
    } | null> {
        const rows = await this.db.query(
            `SELECT r.id AS "reservationId",
                    r.customer_id AS "customerId",
                    u.email AS "customerEmail",
                    TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS "customerName",
                    r.reservation_number AS "reservationNumber",
                    TRIM(CONCAT(b.name, ' ', m.name)) AS "vehicleName",
                    r.pickup_at AS "pickupAt",
                    r.return_at AS "returnAt",
                    r.total_amount AS "totalAmount",
                    r.decision_reason AS "decisionReason",
                    COALESCE(pl.name, vl.name) AS "pickupLocation",
                    COALESCE(rl.name, pl.name, vl.name) AS "returnLocation",
                    (SELECT vi.storage_path FROM vehicle_images vi WHERE vi.vehicle_id = v.id ORDER BY vi.is_primary DESC, vi.created_at ASC LIMIT 1) AS "vehicleImageUrl"
             FROM reservations r
             LEFT JOIN users u ON u.id = r.customer_id
             LEFT JOIN vehicles v ON v.id = r.vehicle_id
             LEFT JOIN vehicle_models m ON m.id = v.model_id
             LEFT JOIN brands b ON b.id = m.brand_id
             LEFT JOIN reservation_preferences p ON p.reservation_id = r.id
             LEFT JOIN rental_locations pl ON pl.id = p.pickup_location_id
             LEFT JOIN rental_locations rl ON rl.id = p.dropoff_location_id
             LEFT JOIN rental_locations vl ON vl.id = v.home_location_id
             WHERE r.reservation_number = $1
             LIMIT 1`,
            [reservationNumber],
        );
        return rows?.[0] ?? null;
    }

    private async loadRentalDetails(rentalId: string): Promise<{
        rentalId: string;
        contractNumber: string;
        reservationId: string;
        reservationNumber: string;
        customerId: string;
        customerEmail: string | null;
        customerName: string;
        vehicleName: string;
        pickupAgencyName: string;
        returnAgencyName: string;
        startedAtIso: string;
        expectedReturnAtIso: string;
        returnedAtIso: string | null;
        pickupMileageKm: number | null;
        pickupFuelPct: number | null;
        returnMileageKm: number | null;
        returnFuelPct: number | null;
        returnReference: string | null;
    } | null> {
        const rows = await this.db.query(
            `SELECT l.id AS "rentalId",
                    l.contract_number AS "contractNumber",
                    r.id AS "reservationId",
                    r.reservation_number AS "reservationNumber",
                    r.customer_id AS "customerId",
                    u.email AS "customerEmail",
                    TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS "customerName",
                    TRIM(CONCAT(b.name, ' ', m.name)) AS "vehicleName",
                    COALESCE(agency.name, pl.name, vl.name, 'LUXUAR Agency') AS "pickupAgencyName",
                    COALESCE(ret_loc.name, rl.name, agency.name, pl.name, vl.name, 'LUXUAR Agency') AS "returnAgencyName",
                    l.started_at AS "startedAt",
                    l.expected_return_at AS "expectedReturnAt",
                    l.returned_at AS "returnedAt",
                    pi.mileage_km AS "pickupMileageKm",
                    pi.fuel_level_pct AS "pickupFuelPct",
                    COALESCE(ri.mileage_km, ret_i.mileage_km) AS "returnMileageKm",
                    COALESCE(ri.fuel_level_pct, ret_i.fuel_level_pct) AS "returnFuelPct",
                    vr.reference AS "returnReference"
             FROM rentals l
             JOIN reservations r ON r.id = l.reservation_id
             LEFT JOIN users u ON u.id = r.customer_id
             LEFT JOIN vehicles v ON v.id = r.vehicle_id
             LEFT JOIN vehicle_models m ON m.id = v.model_id
             LEFT JOIN brands b ON b.id = m.brand_id
             LEFT JOIN reservation_preferences p ON p.reservation_id = r.id
             LEFT JOIN rental_locations pl ON pl.id = p.pickup_location_id
             LEFT JOIN rental_locations rl ON rl.id = p.dropoff_location_id
             LEFT JOIN rental_locations vl ON vl.id = v.home_location_id
             LEFT JOIN reservation_checkin_credentials credential ON credential.reservation_id = r.id
             LEFT JOIN rental_locations agency ON agency.id = credential.agency_id
             LEFT JOIN inspections pi ON pi.rental_id = l.id AND pi.type = 'handover'
             LEFT JOIN vehicle_returns vr ON vr.rental_id = l.id
             LEFT JOIN rental_locations ret_loc ON ret_loc.id = vr.return_location_id
             LEFT JOIN return_inspections ri ON ri.return_id = vr.id
             LEFT JOIN inspections ret_i ON ret_i.id = vr.inspection_id
             WHERE l.id = $1::uuid
             LIMIT 1`,
            [rentalId],
        );
        const row = rows?.[0];
        if (!row) return null;
        return {
            rentalId: row.rentalId,
            contractNumber: row.contractNumber,
            reservationId: row.reservationId,
            reservationNumber: row.reservationNumber,
            customerId: row.customerId,
            customerEmail: row.customerEmail ?? null,
            customerName: row.customerName?.trim() || 'Valued Client',
            vehicleName: row.vehicleName?.trim() || 'your vehicle',
            pickupAgencyName: row.pickupAgencyName || 'LUXUAR Agency',
            returnAgencyName: row.returnAgencyName || 'LUXUAR Agency',
            startedAtIso: row.startedAt
                ? new Date(row.startedAt).toISOString()
                : new Date().toISOString(),
            expectedReturnAtIso: row.expectedReturnAt
                ? new Date(row.expectedReturnAt).toISOString()
                : '',
            returnedAtIso: row.returnedAt
                ? new Date(row.returnedAt).toISOString()
                : null,
            pickupMileageKm: row.pickupMileageKm ?? null,
            pickupFuelPct: row.pickupFuelPct ?? null,
            returnMileageKm: row.returnMileageKm ?? null,
            returnFuelPct: row.returnFuelPct ?? null,
            returnReference: row.returnReference ?? null,
        };
    }

    private async findNotificationId(
        recipientId: string,
        eventKey: string,
    ): Promise<string | null> {
        const rows: { id: string }[] = await this.db.query(
            `SELECT id FROM user_notifications
             WHERE recipient_id = $1::uuid AND event_key = $2
             LIMIT 1`,
            [recipientId, eventKey],
        );
        return rows?.[0]?.id ?? null;
    }

    private async ensureCustomerNotification(input: {
        recipientId: string;
        category: 'reservations' | 'rentals';
        priority: 'info' | 'success' | 'warning';
        title: string;
        message: string;
        actionUrl: string;
        eventKey: string;
        entityType: string;
        entityId: string;
    }): Promise<string | null> {
        const inserted: { id: string }[] = await this.db.query(
            `INSERT INTO user_notifications
                (recipient_id, category, priority, title, message, action_url,
                 event_key, entity_type, entity_id)
             SELECT u.id, $2::varchar, $3::varchar, $4::varchar, $5::text,
                    $6::varchar, $7::varchar, $8::varchar, $9::uuid
             FROM users u
             WHERE u.id = $1::uuid AND u.status = 'active'
             ON CONFLICT (recipient_id, event_key) DO NOTHING
             RETURNING id`,
            [
                input.recipientId,
                input.category,
                input.priority,
                input.title,
                input.message,
                input.actionUrl,
                input.eventKey,
                input.entityType,
                input.entityId,
            ],
        );
        if (inserted?.[0]?.id) {
            return inserted[0].id;
        }
        return this.findNotificationId(input.recipientId, input.eventKey);
    }

    private async recordDeliveryLog(
        notificationId: string,
        status: 'queued' | 'sent' | 'failed',
        errorMessage: string | null,
    ): Promise<void> {
        try {
            await this.db.query(
                `INSERT INTO notification_delivery_logs
                    (notification_id, channel, status, error_message)
                 VALUES ($1::uuid, 'email', $2::varchar, $3::text)`,
                [notificationId, status, errorMessage],
            );
        } catch {
            // Non-blocking audit log insert
        }
    }

    private createDefaultTransport(
        snapshot: SmtpConfigSnapshot,
    ): EmailTransport {
        if (!snapshot.configured || !snapshot.host) {
            return {
                sendMail: async (payload: EmailMessagePayload) => {
                    extractEnvelopeAddress(payload.to);
                    extractEnvelopeAddress(payload.from);
                    throw new Error(
                        'SMTP delivery is not configured: SMTP_HOST is unset in environment. Real email delivery requires a valid SMTP server (e.g. smtp.gmail.com).',
                    );
                },
            };
        }

        const host = snapshot.host;
        const port = snapshot.port;
        const secure = snapshot.secure;
        const timeoutMs = snapshot.timeoutMs;
        const user = this.getEnvString('SMTP_USER');
        const password = this.getEnvString('SMTP_PASSWORD');

        return {
            sendMail: async (payload: EmailMessagePayload) => {
                return this.sendViaSmtp({
                    host,
                    port,
                    secure,
                    timeoutMs,
                    user,
                    password,
                    payload,
                });
            },
        };
    }

    private async sendViaSmtp(options: {
        host: string;
        port: number;
        secure: boolean;
        timeoutMs: number;
        user?: string;
        password?: string;
        payload: EmailMessagePayload;
    }): Promise<{ messageId: string }> {
        const { host, port, secure, timeoutMs, user, password, payload } =
            options;
        if ((user && !password) || (!user && password)) {
            throw new Error(
                'Incomplete SMTP authentication configuration: both user and password are required',
            );
        }
        const fromEnvelope = extractEnvelopeAddress(payload.from);
        const toEnvelope = extractEnvelopeAddress(payload.to);
        const messageId = `<${payload.outboxId || randomUUID()}@luxuar.hu>`;

        let socket: net.Socket | tls.TLSSocket = secure
            ? tls.connect({ host, port, servername: host })
            : net.createConnection({ host, port });

        let isEncrypted = secure;

        const closeSocket = () => {
            try {
                socket.destroy();
            } catch {
                // ignore
            }
        };

        const readResponse = (
            sock: net.Socket | tls.TLSSocket,
        ): Promise<{ code: number; text: string }> => {
            return new Promise((resolve, reject) => {
                let buffer = '';
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error(`SMTP timeout after ${timeoutMs}ms`));
                }, timeoutMs);

                const onData = (chunk: Buffer | string) => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\r\n');
                    for (let i = 0; i < lines.length - 1; i += 1) {
                        const line = lines[i];
                        if (/^\d{3} /.test(line)) {
                            const code = Number(line.slice(0, 3));
                            cleanup();
                            resolve({ code, text: buffer.trim() });
                            return;
                        }
                    }
                };

                const onError = (err: Error) => {
                    cleanup();
                    reject(err);
                };

                const onClose = () => {
                    cleanup();
                    reject(
                        new Error(
                            'SMTP connection closed unexpectedly by remote host',
                        ),
                    );
                };

                const cleanup = () => {
                    clearTimeout(timer);
                    sock.removeListener('data', onData);
                    sock.removeListener('error', onError);
                    sock.removeListener('close', onClose);
                };

                sock.on('data', onData);
                sock.once('error', onError);
                sock.once('close', onClose);
            });
        };

        const sendCommand = async (
            cmd: string,
            expectedCodes: number[],
        ): Promise<{ code: number; text: string }> => {
            socket.write(`${cmd}\r\n`);
            const res = await readResponse(socket);
            if (!expectedCodes.includes(res.code)) {
                throw new Error(
                    `SMTP unexpected response ${res.code}: ${res.text}`,
                );
            }
            return res;
        };

        try {
            const greeting = await readResponse(socket);
            if (greeting.code !== 220) {
                throw new Error(`SMTP greeting failed: ${greeting.text}`);
            }

            let ehlo = await sendCommand('EHLO luxuar.hu', [250]);

            if (!isEncrypted && /STARTTLS/i.test(ehlo.text)) {
                await sendCommand('STARTTLS', [220]);
                socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
                    const tlsSocket = tls.connect(
                        { socket, servername: host },
                        () => resolve(tlsSocket),
                    );
                    tlsSocket.once('error', reject);
                });
                isEncrypted = true;
                ehlo = await sendCommand('EHLO luxuar.hu', [250]);
            }

            if (user && password) {
                const isLocalhost =
                    host === 'localhost' ||
                    host === '127.0.0.1' ||
                    host === '::1';
                if (!isEncrypted && !isLocalhost) {
                    throw new Error(
                        'Refusing to transmit SMTP credentials over an unencrypted connection',
                    );
                }
                const hasPlain = /AUTH[^\r\n]*\bPLAIN\b/i.test(ehlo.text);
                const hasLogin = /AUTH[^\r\n]*\bLOGIN\b/i.test(ehlo.text);
                if (hasPlain || !hasLogin) {
                    const authToken = Buffer.from(
                        `\u0000${user}\u0000${password}`,
                        'utf8',
                    ).toString('base64');
                    await sendCommand(`AUTH PLAIN ${authToken}`, [235]);
                } else {
                    await sendCommand('AUTH LOGIN', [334]);
                    const userB64 = Buffer.from(user, 'utf8').toString('base64');
                    await sendCommand(userB64, [334]);
                    const passB64 = Buffer.from(password, 'utf8').toString('base64');
                    await sendCommand(passB64, [235]);
                }
            }

            await sendCommand(`MAIL FROM:<${fromEnvelope}>`, [250]);
            await sendCommand(`RCPT TO:<${toEnvelope}>`, [250, 251]);
            await sendCommand('DATA', [354]);

            const textBody = dotStuffBody(payload.text);
            if (payload.html) {
                const boundary = `_luxuar_${payload.outboxId}_alt`;
                const mh = [
                    `From: ${sanitizeHeaderValue(payload.from)}`,
                    `To: <${toEnvelope}>`,
                    `Subject: ${sanitizeHeaderValue(payload.subject)}`,
                    `Message-ID: ${messageId}`,
                    `Date: ${new Date().toUTCString()}`,
                    'MIME-Version: 1.0',
                    `Content-Type: multipart/alternative; boundary="${boundary}"`,
                ];
                const htmlBody = dotStuffBody(payload.html.replace(/\r?\n/g, '\r\n'));
                const dataPayload = [
                    mh.join('\r\n'),
                    '',
                    `--${boundary}`,
                    'Content-Type: text/plain; charset=utf-8',
                    'Content-Transfer-Encoding: 8bit',
                    '',
                    textBody,
                    `--${boundary}`,
                    'Content-Type: text/html; charset=utf-8',
                    'Content-Transfer-Encoding: 8bit',
                    '',
                    htmlBody,
                    `--${boundary}--`,
                    '.',
                ].join('\r\n');
                await sendCommand(dataPayload, [250]);
            } else {
                const headers = [
                    `From: ${sanitizeHeaderValue(payload.from)}`,
                    `To: <${toEnvelope}>`,
                    `Subject: ${sanitizeHeaderValue(payload.subject)}`,
                    `Message-ID: ${messageId}`,
                    `Date: ${new Date().toUTCString()}`,
                    'MIME-Version: 1.0',
                    'Content-Type: text/plain; charset=utf-8',
                    'Content-Transfer-Encoding: 8bit',
                ];
                const dataPayload = `${headers.join('\r\n')}\r\n\r\n${textBody}\r\n.`;
                await sendCommand(dataPayload, [250]);
            }

            try {
                await sendCommand('QUIT', [221]);
            } catch {
                // ignore QUIT close race
            }
            return { messageId };
        } finally {
            closeSocket();
        }
    }

    private getMaxAttempts(): number {
        return this.getEnvNumber('EMAIL_OUTBOX_MAX_ATTEMPTS', 3);
    }

    private getBaseDelayMs(): number {
        return this.getEnvNumber('EMAIL_OUTBOX_BASE_DELAY_MS', 30_000);
    }

    private getScanIntervalMs(): number {
        return this.getEnvNumber('EMAIL_OUTBOX_SCAN_INTERVAL_MS', 30_000);
    }

    private getEnvString(key: string): string | undefined {
        const val = this.configService?.get<string>(key) ?? process.env[key];
        if (typeof val === 'string' && val.trim().length > 0) {
            return val.trim();
        }
        return undefined;
    }

    private getEnvNumber(key: string, fallback: number): number {
        const raw =
            this.configService?.get<number | string>(key) ?? process.env[key];
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    private getEnvBoolean(key: string, fallback: boolean): boolean {
        const raw =
            this.configService?.get<boolean | string>(key) ?? process.env[key];
        if (typeof raw === 'boolean') return raw;
        if (typeof raw === 'string') {
            const norm = raw.trim().toLowerCase();
            if (norm === 'true' || norm === '1') return true;
            if (norm === 'false' || norm === '0') return false;
        }
        return fallback;
    }
}
