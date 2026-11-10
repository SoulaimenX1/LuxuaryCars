import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    hkdfSync,
    randomBytes,
    randomUUID,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { DataSource } from 'typeorm';
import type { Reservation } from '../reservations/entities/reservation.entity.js';
import {
    renderLuxuarEmailHtml,
    renderLuxuarEmailText,
} from './luxuar-email-template.js';

export interface EmailInlineAttachment {
    cid: string;
    filename: string;
    contentType: string;
    contentBase64: string;
}

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
    | 'password_reset'
    | 'invoice_issued';

export interface EmailMessagePayload {
    outboxId: string;
    to: string;
    from: string;
    subject: string;
    text: string;
    html?: string | null;
    inlineAttachments?: EmailInlineAttachment[];
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
    htmlMessage?: string | null;
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
    html_message?: string | null;
    event_key: string | null;
    template_type: string | null;
    notification_id: string | null;
    attempt_count: number;
    max_attempts: number;
}

const EMAIL_REGEX = /^[^\s@<\r\n]+@[^\s@>\r\n]+\.[^\s@>\r\n]+$/;

const TEST_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
    'luxuar-test.hu',
    'test.luxuar.hu',
    'example.com',
    'example.org',
    'example.net',
    'test.com',
    'localhost',
    'local',
    'test.local',
    'mailpit.local',
]);

export function isTestRecipient(email?: string | null): boolean {
    if (!email || typeof email !== 'string') return false;
    const clean = email.trim().toLowerCase();
    const atIndex = clean.lastIndexOf('@');
    if (atIndex === -1) return false;
    const domain = clean.slice(atIndex + 1).replace(/>$/, '').trim();
    if (!domain) return false;
    if (
        domain.endsWith('.test') ||
        domain.endsWith('.example') ||
        domain.endsWith('.invalid') ||
        domain.endsWith('.localhost') ||
        domain === 'localhost'
    ) {
        return true;
    }
    for (const testDomain of TEST_EMAIL_DOMAINS) {
        if (domain === testDomain || domain.endsWith(`.${testDomain}`)) {
            return true;
        }
    }
    return false;
}

export const OUTBOX_CIPHERTEXT_PREFIX = 'enc:v1:';
export const REDACTED_OUTBOX_MESSAGE = '[REDACTED AFTER DELIVERY]';
const OUTBOX_DEFAULT_AAD = 'luxuar:customer_email_outbox:v1';
const EPHEMERAL_TEST_KEY = randomBytes(32);

export const SENSITIVE_OUTBOX_TEMPLATES: ReadonlySet<string> = new Set([
    'email_verification',
    'password_reset',
    'check_in_code',
]);

export function isEncryptedOutboxContent(value?: string | null): boolean {
    return typeof value === 'string' && value.startsWith(OUTBOX_CIPHERTEXT_PREFIX);
}

export function isSensitiveOutboxTemplate(templateType?: string | null): boolean {
    return (
        typeof templateType === 'string' &&
        SENSITIVE_OUTBOX_TEMPLATES.has(templateType.trim())
    );
}

export function containsSensitiveTokenContent(value?: string | null): boolean {
    if (!value || typeof value !== 'string') return false;
    return (
        /(?:verify-email|reset-password)\?[^\s"'<>]*\btoken=/i.test(value) ||
        /\b(?:Verification token|One-time reset token|One-Time Token):\s*\S+/i.test(
            value,
        ) ||
        /\bone-time check-in code[^:\r\n]*:\s*\S+/i.test(value)
    );
}

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

    private isMailpitActive(): boolean {
        const nodeEnv = (
            this.getEnvString('NODE_ENV') ?? 'development'
        ).toLowerCase();
        if (nodeEnv === 'production') {
            return false;
        }
        return this.getEnvBoolean('MAILPIT_ENABLED', false);
    }

    private getMailpitSmtpHost(): string {
        const candidate = (
            this.getEnvString('MAILPIT_SMTP_HOST') ?? '127.0.0.1'
        ).toLowerCase();
        if (
            candidate === '127.0.0.1' ||
            candidate === 'localhost' ||
            candidate === '::1'
        ) {
            return candidate;
        }
        throw new Error(
            `Refusing non-local MAILPIT_SMTP_HOST: ${candidate}`,
        );
    }

    getSmtpConfigSnapshot(recipientEmail?: string): SmtpConfigSnapshot {
        const isTest = recipientEmail ? isTestRecipient(recipientEmail) : true;
        const mailpitActive = this.isMailpitActive();
        const host = this.getEnvString('SMTP_HOST');
        const user = this.getEnvString('SMTP_USER');
        const password = this.getEnvString('SMTP_PASSWORD');
        const hasRealSmtp = Boolean(host);

        // Mailpit takes precedence for test recipients or when real SMTP is not configured in non-production
        if (mailpitActive && (isTest || !hasRealSmtp)) {
            const mailpitHost = this.getMailpitSmtpHost();
            const mailpitPort = this.getEnvNumber('MAILPIT_SMTP_PORT', 1025);
            return {
                configured: true,
                host: mailpitHost,
                port: mailpitPort,
                secure: false,
                authEnabled: false,
                user: null,
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

        return {
            configured: hasRealSmtp,
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
        const encryptionKey = this.getEnvString('EMAIL_OUTBOX_ENCRYPTION_KEY');
        const jwtSecret = this.getEnvString('JWT_SECRET');

        for (const secret of [password, encryptionKey, jwtSecret]) {
            if (secret && secret.length > 0) {
                sanitized = sanitized.split(secret).join('[REDACTED]');
                const base64Secret = Buffer.from(secret, 'utf8').toString('base64');
                sanitized = sanitized.split(base64Secret).join('[REDACTED]');
                const base64UrlSecret = Buffer.from(secret, 'utf8').toString('base64url');
                sanitized = sanitized.split(base64UrlSecret).join('[REDACTED]');
            }
        }
        if (user && password) {
            const plainToken = Buffer.from(
                `\u0000${user}\u0000${password}`,
                'utf8',
            ).toString('base64');
            sanitized = sanitized.split(plainToken).join('[REDACTED]');
        }

        // Redact verification/reset URLs, raw tokens, check-in codes, and encrypted blobs
        sanitized = sanitized.replace(
            /((?:[?&]|\b)token=)[^&\s"'<>]+/gi,
            '$1[REDACTED]',
        );
        sanitized = sanitized.replace(
            /((?:Verification token|One-time reset token|One-Time Token|Check-In Code)\s*:\s*)\S+/gi,
            '$1[REDACTED]',
        );
        sanitized = sanitized.replace(
            /(one-time check-in code[^:\r\n]*:\s*)\S+/gi,
            '$1[REDACTED]',
        );
        sanitized = sanitized.replace(
            /enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g,
            '[REDACTED_CIPHERTEXT]',
        );

        return sanitized.slice(0, 500);
    }

    private resolveEncryptionKey(): Buffer {
        const explicitKey = this.getEnvString('EMAIL_OUTBOX_ENCRYPTION_KEY');
        if (explicitKey !== undefined) {
            if (explicitKey.length < 32) {
                throw new Error(
                    'Invalid EMAIL_OUTBOX_ENCRYPTION_KEY: must be at least 32 characters',
                );
            }
            return Buffer.from(
                hkdfSync(
                    'sha256',
                    Buffer.from(explicitKey, 'utf8'),
                    Buffer.from('luxuar-email-outbox-salt-v1', 'utf8'),
                    Buffer.from('luxuar-email-outbox-aes-256-gcm-explicit-v1', 'utf8'),
                    32,
                ),
            );
        }

        const jwtSecret = this.getEnvString('JWT_SECRET');
        if (jwtSecret && jwtSecret.length >= 32) {
            return Buffer.from(
                hkdfSync(
                    'sha256',
                    Buffer.from(jwtSecret, 'utf8'),
                    Buffer.from('luxuar-email-outbox-salt-v1', 'utf8'),
                    Buffer.from('luxuar-email-outbox-aes-256-gcm-jwt-fallback-v1', 'utf8'),
                    32,
                ),
            );
        }

        const nodeEnv =
            this.configService?.get<string>('NODE_ENV') ??
            process.env.NODE_ENV ??
            'development';
        if (nodeEnv === 'production') {
            throw new Error(
                'Outbox encryption key is not configured: set EMAIL_OUTBOX_ENCRYPTION_KEY or JWT_SECRET',
            );
        }

        return EPHEMERAL_TEST_KEY;
    }

    shouldProtectContent(
        templateType?: string | null,
        message?: string | null,
        htmlMessage?: string | null,
    ): boolean {
        return (
            isSensitiveOutboxTemplate(templateType) ||
            isEncryptedOutboxContent(message) ||
            isEncryptedOutboxContent(htmlMessage) ||
            containsSensitiveTokenContent(message) ||
            containsSensitiveTokenContent(htmlMessage)
        );
    }

    encryptOutboxContent(
        plaintext: string,
        aadContext: string = OUTBOX_DEFAULT_AAD,
    ): string {
        if (isEncryptedOutboxContent(plaintext)) {
            return plaintext;
        }
        const key = this.resolveEncryptionKey();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv, {
            authTagLength: 16,
        });
        cipher.setAAD(Buffer.from(aadContext, 'utf8'));
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();
        return `${OUTBOX_CIPHERTEXT_PREFIX}${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted.toString('base64url')}`;
    }

    decryptOutboxContent(
        stored: string,
        aadContext: string = OUTBOX_DEFAULT_AAD,
    ): string {
        if (!isEncryptedOutboxContent(stored)) {
            // Legacy plaintext records are read safely without destructive migration
            return stored;
        }
        const body = stored.slice(OUTBOX_CIPHERTEXT_PREFIX.length);
        const parts = body.split(':');
        if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] === undefined) {
            throw new Error(
                'Outbox payload decryption failed: malformed ciphertext envelope',
            );
        }
        try {
            const iv = Buffer.from(parts[0], 'base64url');
            const authTag = Buffer.from(parts[1], 'base64url');
            const ciphertext = Buffer.from(parts[2], 'base64url');
            if (iv.length !== 12 || authTag.length !== 16) {
                throw new Error('Invalid IV or authentication tag length');
            }
            const key = this.resolveEncryptionKey();
            const decipher = createDecipheriv('aes-256-gcm', key, iv, {
                authTagLength: 16,
            });
            decipher.setAAD(Buffer.from(aadContext, 'utf8'));
            decipher.setAuthTag(authTag);
            const decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]);
            return decrypted.toString('utf8');
        } catch {
            throw new Error(
                'Outbox payload decryption failed: invalid key or tampered ciphertext',
            );
        }
    }

    async ensureSchema(): Promise<void> {
        if (this.schemaEnsured) return;
        try {
            await this.db.query(`
                ALTER TABLE customer_email_outbox
                  ADD COLUMN IF NOT EXISTS event_key varchar(180),
                  ADD COLUMN IF NOT EXISTS template_type varchar(40),
                  ADD COLUMN IF NOT EXISTS recipient_email varchar(255),
                  ADD COLUMN IF NOT EXISTS html_message text,
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
        const protectAtRest = this.shouldProtectContent(
            input.templateType,
            input.message,
            input.htmlMessage,
        );
        const storedMessage = protectAtRest
            ? this.encryptOutboxContent(input.message)
            : input.message;
        const storedHtmlMessage =
            input.htmlMessage != null && input.htmlMessage.length > 0
                ? protectAtRest
                    ? this.encryptOutboxContent(input.htmlMessage)
                    : input.htmlMessage
                : (input.htmlMessage ?? null);

        // If `ReservationsService.createReservation` already inserted a legacy row
        // without `event_key` for this exact customer, upgrade that row
        // in place instead of creating a duplicate outbox record.
        if (input.templateType === 'booking_created') {
            const upgraded = await this.db.query(
                `UPDATE customer_email_outbox
                 SET subject = $2,
                     message = $8,
                     event_key = $3,
                     template_type = $4,
                     notification_id = COALESCE(notification_id, $5::uuid),
                     max_attempts = $6,
                     html_message = COALESCE($7::text, html_message),
                     updated_at = now()
                 WHERE id = (
                     SELECT id FROM customer_email_outbox
                     WHERE customer_id = $1::uuid
                       AND (subject = $2 OR subject = 'Reservation request received')
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
                    storedHtmlMessage,
                    storedMessage,
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
                     max_attempts, next_attempt_at, updated_at, html_message)
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
                        now(),
                        $9::text
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
                    storedMessage,
                    eventKey,
                    input.templateType,
                    input.notificationId ?? null,
                    maxAttempts,
                    storedHtmlMessage,
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
                                o.html_message,
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

                const sensitiveRow = this.shouldProtectContent(
                    row.template_type,
                    row.message,
                    row.html_message,
                );

                try {
                    const toAddress = extractEnvelopeAddress(recipient);
                    const rowSnapshot = this.getSmtpConfigSnapshot(toAddress);
                    const transport =
                        this.customTransport ?? this.createDefaultTransport(rowSnapshot);

                    if (row.message === REDACTED_OUTBOX_MESSAGE) {
                        throw new Error(
                            'Sensitive outbox message content was already purged after delivery and cannot be resent',
                        );
                    }
                    const plainText = this.decryptOutboxContent(row.message);
                    if (plainText === REDACTED_OUTBOX_MESSAGE) {
                        throw new Error(
                            'Sensitive outbox message content was already purged after delivery and cannot be resent',
                        );
                    }
                    let htmlToSend =
                        row.html_message && row.html_message.trim()
                            ? this.decryptOutboxContent(row.html_message)
                            : null;
                    if (!htmlToSend || !htmlToSend.trim()) {
                        try {
                            htmlToSend = renderLuxuarEmailHtml({
                                kicker: 'LUXUAR NOTIFICATION',
                                heading: sanitizeHeaderValue(row.subject),
                                customerName: 'Valued Client',
                                introMessage: plainText,
                                signoff: 'Kind regards, The LUXUAR Team',
                            });
                        } catch {
                            htmlToSend = null;
                        }
                    }
                    await transport.sendMail({
                        outboxId: row.id,
                        to: toAddress,
                        from: rowSnapshot.from,
                        subject: sanitizeHeaderValue(row.subject),
                        text: plainText,
                        html: htmlToSend,
                        eventKey: row.event_key ?? null,
                        templateType: row.template_type ?? null,
                    });

                    await this.db.query(
                        `UPDATE customer_email_outbox
                         SET status = 'sent',
                             recipient_email = COALESCE(recipient_email, $2),
                             sent_at = now(),
                             attempt_count = $3,
                             message = CASE WHEN $4::boolean THEN $5::text ELSE message END,
                             html_message = CASE WHEN $4::boolean THEN NULL ELSE html_message END,
                             last_error = NULL,
                             locked_at = NULL,
                             updated_at = now()
                         WHERE id = $1::uuid`,
                        [
                            row.id,
                            toAddress,
                            nextAttemptCount,
                            sensitiveRow,
                            REDACTED_OUTBOX_MESSAGE,
                        ],
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

                    // Protect legacy plaintext sensitive records at rest if they remain in 'pending' or 'failed' state
                    let atRestMessage = row.message;
                    let atRestHtml = row.html_message ?? null;
                    if (
                        sensitiveRow &&
                        row.message !== REDACTED_OUTBOX_MESSAGE
                    ) {
                        try {
                            if (!isEncryptedOutboxContent(row.message)) {
                                atRestMessage = this.encryptOutboxContent(
                                    row.message,
                                );
                            }
                            if (
                                row.html_message &&
                                !isEncryptedOutboxContent(row.html_message)
                            ) {
                                atRestHtml = this.encryptOutboxContent(
                                    row.html_message,
                                );
                            }
                        } catch {
                            // Keep existing row payload if encryption key is unavailable
                        }
                    }

                    if (exhausted) {
                        await this.db.query(
                            `UPDATE customer_email_outbox
                             SET status = 'failed',
                                 attempt_count = $2,
                                 last_error = $3,
                                 message = COALESCE($4::text, message),
                                 html_message = $5::text,
                                 locked_at = NULL,
                                 updated_at = now()
                             WHERE id = $1::uuid`,
                            [
                                row.id,
                                nextAttemptCount,
                                sanitizedError,
                                atRestMessage,
                                atRestHtml,
                            ],
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
                                 message = COALESCE($5::text, message),
                                 html_message = $6::text,
                                 locked_at = NULL,
                                 updated_at = now()
                             WHERE id = $1::uuid`,
                            [
                                row.id,
                                nextAttemptCount,
                                delayMs,
                                sanitizedError,
                                atRestMessage,
                                atRestHtml,
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
        const pickupAt = details?.pickupAt
            ? new Date(details.pickupAt).toISOString()
            : 'Scheduled pick-up';
        const returnAt = details?.returnAt
            ? new Date(details.returnAt).toISOString()
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
        const frontendBaseUrl = (
            this.configService?.get<string>('FRONTEND_URL') ??
            process.env.FRONTEND_URL ??
            'http://localhost:3000'
        ).replace(/\/$/, '');
        const paymentUrl = `${frontendBaseUrl}/account/payments/${reservationNumber}`;
        const vehiclesUrl = `${frontendBaseUrl}/vehicles`;
        const reservationsUrl = `${frontendBaseUrl}/account/reservations`;
        const vehiclePhotoUrl = this.resolveVehicleImageUrl(details?.vehiclePhoto);

        if (event === 'awaiting_payment') {
            const htmlMessage = renderLuxuarEmailHtml({
                kicker: 'RESERVATION UPDATE',
                heading: 'Your reservation has been approved.',
                customerName,
                introMessage: `Your reservation request ${reservationNumber} has been approved by LUXUAR Concierge!`,
                detailsTitle: 'RESERVATION SUMMARY',
                vehicleName,
                vehiclePhotoUrl,
                rows: [
                    { label: 'Reference', value: reservationNumber },
                    { label: 'Rental Dates', value: `${pickupAt} to ${returnAt}` },
                    { label: 'Rental Price', value: totalAmount },
                    { label: 'Security Deposit', value: depositFormatted },
                    { label: 'Grand Total Payable', value: grandTotal },
                    { label: 'Status', value: 'Awaiting Payment', isStatus: true },
                ],
                postMessage:
                    'PAYMENT DEADLINE: You have exactly 24 hours to complete your secure payment. Once verified by Stripe, your reservation will immediately transition to CONFIRMED.',
                ctaButton: {
                    label: 'COMPLETE SECURE PAYMENT →',
                    url: paymentUrl,
                },
                signoff: 'Kind regards, The LUXUAR Team',
            });

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
                    'Kind regards, The LUXUAR Team',
                ].join('\n'),
                htmlMessage,
            });
        } else if (event === 'cancelled_unpaid') {
            const htmlMessage = renderLuxuarEmailHtml({
                kicker: 'RESERVATION UPDATE',
                heading: 'Your reservation has been cancelled.',
                customerName,
                introMessage:
                    'Your reservation has been cancelled because the payment deadline expired without a verified payment.',
                detailsTitle: 'RESERVATION DETAILS',
                vehicleName,
                vehiclePhotoUrl,
                rows: [
                    { label: 'Reference', value: reservationNumber },
                    {
                        label: 'Status',
                        value: 'Cancelled — Unpaid',
                        isStatus: true,
                    },
                ],
                postMessage:
                    'You are welcome to explore our collection and submit a new reservation request.',
                ctaButton: {
                    label: 'EXPLORE THE COLLECTION →',
                    url: vehiclesUrl,
                },
                signoff: 'Kind regards, The LUXUAR Team',
            });

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
                    'Your reservation has been cancelled because the payment deadline expired without a verified payment.',
                    '',
                    'RESERVATION DETAILS',
                    `• Vehicle: ${vehicleName}`,
                    `• Reference: ${reservationNumber}`,
                    '• Status: Cancelled — Unpaid',
                    '',
                    'You are welcome to explore our collection and submit a new reservation request:',
                    vehiclesUrl,
                    '',
                    'Kind regards, The LUXUAR Team',
                ].join('\n'),
                htmlMessage,
            });
        } else if (event === 'active_rental') {
            const htmlMessage = renderLuxuarEmailHtml({
                kicker: 'RENTAL UPDATE',
                heading: 'Your rental is now active.',
                customerName,
                introMessage: `Your rental for ${vehicleName} (Reservation ${reservationNumber}) is now active.`,
                detailsTitle: 'RENTAL DETAILS',
                vehicleName,
                vehiclePhotoUrl,
                rows: [
                    { label: 'Reference', value: reservationNumber },
                    {
                        label: 'Scheduled Return',
                        value: `${returnAt} at ${returnLocation}`,
                    },
                    { label: 'Status', value: 'Active Rental', isStatus: true },
                ],
                postMessage: 'Have an exceptional journey with LUXUAR.',
                ctaButton: {
                    label: 'VIEW RESERVATION DETAILS →',
                    url: reservationsUrl,
                },
                signoff: 'Kind regards, The LUXUAR Team',
            });

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
                    'Kind regards, The LUXUAR Team',
                ].join('\n'),
                htmlMessage,
            });
        } else if (event === 'completed') {
            const refundedAmount =
                details?.depositRefundedAmount != null
                    ? `EUR ${Number(details.depositRefundedAmount).toFixed(2)}`
                    : 'EUR 0.00';
            const retainedAmount =
                details?.depositRetainedAmount != null
                    ? `EUR ${Number(details.depositRetainedAmount).toFixed(2)}`
                    : 'EUR 0.00';
            const reason =
                details?.depositRetentionReason?.trim() ||
                (Number(details?.depositRetainedAmount || 0) > 0
                    ? 'Documented vehicle return damage'
                    : 'No damage detected');
            const status = details?.depositRefundStatus || 'refunded';

            const htmlMessage = renderLuxuarEmailHtml({
                kicker: 'RENTAL COMPLETED',
                heading: 'Rental Completed & Security Deposit Processed',
                customerName,
                introMessage: `The return of vehicle ${vehicleName} for reservation ${reservationNumber} has been finalized.`,
                detailsTitle: 'SECURITY DEPOSIT STATEMENT',
                vehicleName,
                vehiclePhotoUrl,
                rows: [
                    { label: 'Reference', value: reservationNumber },
                    { label: 'Initial Deposit', value: depositFormatted },
                    { label: 'Documented Deduction', value: retainedAmount },
                    { label: 'Reason / Notes', value: reason },
                    { label: 'Refunded Amount', value: refundedAmount },
                    { label: 'Stripe Refund Status', value: status, isStatus: true },
                ],
                postMessage:
                    'Thank you for traveling with LUXUAR. We look forward to welcoming you on your next journey.',
                ctaButton: {
                    label: 'VIEW RECEIPT & STATEMENT →',
                    url: paymentUrl,
                },
                signoff: 'Kind regards, The LUXUAR Team',
            });

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
                    'Kind regards, The LUXUAR Team',
                ].join('\n'),
                htmlMessage,
            });
        } else if (event === 'confirmed') {
            const htmlMessage = renderLuxuarEmailHtml({
                kicker: 'RESERVATION CONFIRMATION',
                heading: 'Your reservation is confirmed.',
                customerName,
                introMessage: `Your payment for reservation ${reservationNumber} has been successfully verified via Stripe! We look forward to welcoming you.`,
                detailsTitle: 'BOOKING DETAILS',
                vehicleName,
                vehiclePhotoUrl,
                rows: [
                    { label: 'Reference', value: reservationNumber },
                    { label: 'Pick-up Date', value: `${pickupAt} (${pickupLocation})` },
                    { label: 'Return Date', value: `${returnAt} (${returnLocation})` },
                    {
                        label: 'Total Paid',
                        value: `${grandTotal} (Rental: ${totalAmount} + Deposit: ${depositFormatted})`,
                    },
                    { label: 'Status', value: 'Confirmed — Paid', isStatus: true },
                ],
                postMessage:
                    'Your receipt and booking voucher are available in your account.',
                ctaButton: {
                    label: 'VIEW RESERVATION DETAILS →',
                    url: paymentUrl,
                },
                signoff: 'Kind regards, The LUXUAR Team',
            });

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
                htmlMessage,
            });
        } else if (event === 'cancelled') {
            const htmlMessage = renderLuxuarEmailHtml({
                kicker: 'RESERVATION UPDATE',
                heading: 'Your reservation has been cancelled.',
                customerName,
                introMessage: `Your reservation ${reservationNumber} for ${vehicleName} has been cancelled.`,
                detailsTitle: 'RESERVATION DETAILS',
                vehicleName,
                vehiclePhotoUrl,
                rows: [
                    { label: 'Reference', value: reservationNumber },
                    {
                        label: 'Scheduled Pick-up',
                        value: `${pickupAt} (${pickupLocation})`,
                    },
                    { label: 'Status', value: 'Cancelled', isStatus: true },
                ],
                postMessage:
                    'You are welcome to explore our collection and submit a new reservation request.',
                ctaButton: {
                    label: 'EXPLORE THE COLLECTION →',
                    url: vehiclesUrl,
                },
                signoff: 'Kind regards, The LUXUAR Team',
            });

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
                htmlMessage,
            });
        } else if (event === 'rejected') {
            const reason =
                reservation.decisionReason?.trim() ||
                details?.decisionReason?.trim() ||
                'Vehicle scheduling conflict';

            const htmlMessage = renderLuxuarEmailHtml({
                kicker: 'RESERVATION UPDATE',
                heading: 'Reservation Request Declined',
                customerName,
                introMessage: `Thank you for your interest in LUXUAR. Regrettably, your reservation request ${reservationNumber} for ${vehicleName} could not be approved at this time.\nReason: ${reason}.`,
                detailsTitle: 'RESERVATION DETAILS',
                vehicleName,
                vehiclePhotoUrl,
                rows: [
                    { label: 'Reference', value: reservationNumber },
                    { label: 'Status', value: 'Declined', isStatus: true },
                ],
                postMessage:
                    'No payment was collected, and any provisional hold on your vehicle has been released. We warmly invite you to select another vehicle from our fleet.',
                ctaButton: {
                    label: 'EXPLORE THE COLLECTION →',
                    url: vehiclesUrl,
                },
                signoff: 'Kind regards, The LUXUAR Team',
            });

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
                    `${vehiclesUrl}`,
                    '',
                    'LUXUAR Concierge Team',
                ].join('\n'),
                htmlMessage,
            });
        } else if (event === 'created') {
            const pickupFormatted = details?.pickupAt
                ? new Date(details.pickupAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                  })
                : pickupAt;
            const returnFormatted = details?.returnAt
                ? new Date(details.returnAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                  })
                : returnAt;

            const htmlMessage = renderLuxuarEmailHtml({
                kicker: 'RESERVATION RECEIVED',
                heading: 'Your reservation request has been received.',
                customerName,
                introMessage: `Thank you for choosing LUXUAR. We have received your reservation request ${reservationNumber} for ${vehicleName}.`,
                detailsTitle: 'RESERVATION DETAILS',
                vehicleName,
                vehiclePhotoUrl,
                rows: [
                    { label: 'Reference', value: reservationNumber },
                    { label: 'Pickup Date', value: pickupFormatted },
                    { label: 'Return Date', value: returnFormatted },
                    { label: 'Collection Agency', value: pickupLocation },
                    { label: 'Status', value: 'Pending Approval', isStatus: true },
                ],
                postMessage:
                    'Our administration team is currently reviewing your request. You will receive an email as soon as your booking is approved, with a secure link to complete payment.',
                ctaButton: {
                    label: 'VIEW YOUR RESERVATIONS →',
                    url: reservationsUrl,
                },
                signoff: 'Kind regards, The LUXUAR Team',
            });

            await this.enqueueEmail({
                customerId,
                recipientEmail: details?.customerEmail ?? null,
                eventKey: `reservation:${reservation.id}:created`,
                templateType: 'booking_created',
                notificationId,
                subject: `Reservation Received — Pending Approval`,
                message: [
                    `Dear ${customerName},`,
                    '',
                    `Thank you for choosing LUXUAR. We have received your reservation request ${reservationNumber} for ${vehicleName}.`,
                    '',
                    'RESERVATION DETAILS',
                    `• Vehicle: ${vehicleName}`,
                    `• Reference: ${reservationNumber}`,
                    `• Pickup Date: ${pickupFormatted}`,
                    `• Return Date: ${returnFormatted}`,
                    `• Collection Agency: ${pickupLocation}`,
                    '• Status: Pending Approval',
                    '',
                    'Our administration team is currently reviewing your request.',
                    'You will receive an email as soon as your booking is approved, with a secure link to complete payment.',
                    '',
                    'Kind regards, The LUXUAR Team',
                ].join('\n'),
                htmlMessage,
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

        const htmlMessage = renderLuxuarEmailHtml({
            kicker: 'RESERVATION UPDATE',
            heading: 'Reservation Cancelled (No-Show)',
            customerName,
            introMessage: `Reservation ${reservationNumber} for ${vehicleName} was marked as a no-show because check-in was not completed before the pick-up deadline.`,
            detailsTitle: 'RESERVATION DETAILS',
            vehicleName,
            vehiclePhotoUrl: this.resolveVehicleImageUrl(details?.vehiclePhoto),
            rows: [
                { label: 'Reference', value: reservationNumber },
                { label: 'Status', value: 'Cancelled — No-Show', isStatus: true },
            ],
            postMessage:
                'The reserved vehicle has been released back into fleet availability. You are welcome to explore our collection and submit a new reservation request.',
            ctaButton: {
                label: 'EXPLORE THE COLLECTION →',
                url: `${(this.configService?.get<string>('FRONTEND_URL') ?? 'http://localhost:3000').replace(/\/$/, '')}/vehicles`,
            },
            signoff: 'Kind regards, The LUXUAR Team',
        });

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
            htmlMessage,
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

        const htmlMessage = renderLuxuarEmailHtml({
            kicker: 'CHECK-IN DETAILS',
            heading: 'Your Check-In Code',
            customerName,
            introMessage: `Your one-time check-in code for reservation ${normalizedNumber} (${vehicleName}) is ready.`,
            detailsTitle: 'CHECK-IN DETAILS',
            vehicleName,
            vehiclePhotoUrl: this.resolveVehicleImageUrl(details?.vehiclePhoto),
            rows: [
                { label: 'Reference', value: normalizedNumber },
                { label: 'Check-In Code', value: input.code, isStatus: true },
                { label: 'Pick-Up Agency', value: pickupLocation },
                { label: 'Code Valid Until', value: expiresIso },
            ],
            postMessage:
                'Present this code along with your driving licence and identity document at the agency desk.',
            signoff: 'Kind regards, The LUXUAR Team',
        });

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
            htmlMessage,
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

        const htmlMessage = renderLuxuarEmailHtml({
            kicker: 'RENTAL ACTIVE',
            heading: 'Check-In Completed — Rental Active',
            customerName: rental.customerName,
            introMessage: `Your vehicle check-in and handover for reservation ${rental.reservationNumber} is complete.`,
            detailsTitle: 'HANDOVER DETAILS',
            vehicleName: rental.vehicleName,
            vehiclePhotoUrl: this.resolveVehicleImageUrl(rental.vehiclePhoto),
            rows: [
                { label: 'Rental Contract', value: rental.contractNumber },
                { label: 'Pick-Up Agency', value: rental.pickupAgencyName },
                { label: 'Handover Time', value: rental.startedAtIso },
                {
                    label: 'Expected Return',
                    value: `${rental.expectedReturnAtIso} at ${rental.returnAgencyName}`,
                },
                {
                    label: 'Recorded Mileage',
                    value: `${rental.pickupMileageKm ?? 'N/A'} km`,
                },
                {
                    label: 'Fuel Level',
                    value: `${rental.pickupFuelPct ?? 'N/A'}%`,
                },
            ],
            postMessage: 'Wishing you an exceptional journey with LUXUAR.',
            ctaButton: {
                label: 'VIEW RESERVATION DETAILS →',
                url: `${(this.configService?.get<string>('FRONTEND_URL') ?? 'http://localhost:3000').replace(/\/$/, '')}/account/reservations`,
            },
            signoff: 'Kind regards, The LUXUAR Team',
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
            htmlMessage,
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

        const htmlMessage = renderLuxuarEmailHtml({
            kicker: 'RETURN CONFIRMATION',
            heading: 'Vehicle Return Registered',
            customerName: rental.customerName,
            introMessage: `We confirm the return of your ${rental.vehicleName} for reservation ${rental.reservationNumber}.`,
            detailsTitle: 'RETURN INSPECTION DETAILS',
            vehicleName: rental.vehicleName,
            vehiclePhotoUrl: this.resolveVehicleImageUrl(rental.vehiclePhoto),
            rows: [
                { label: 'Rental Contract', value: rental.contractNumber },
                { label: 'Return Reference', value: returnRef },
                { label: 'Return Agency', value: rental.returnAgencyName },
                {
                    label: 'Returned At',
                    value: rental.returnedAtIso ?? new Date().toISOString(),
                },
                {
                    label: 'Return Mileage',
                    value: `${rental.returnMileageKm ?? 'N/A'} km`,
                },
                {
                    label: 'Return Fuel Level',
                    value: `${rental.returnFuelPct ?? 'N/A'}%`,
                },
                {
                    label: 'Automatic Return Fees',
                    value: `EUR ${autoCharges}`,
                },
                {
                    label: 'Damage Assessment',
                    value: `EUR ${damageEst}`,
                },
            ],
            postMessage:
                'Thank you for choosing LUXUAR. We look forward to welcoming you on your next journey.',
            signoff: 'Kind regards, The LUXUAR Team',
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
            htmlMessage,
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

        const htmlMessage = renderLuxuarEmailHtml({
            kicker: 'RENTAL CLOSED',
            heading: 'Rental Contract Closed',
            customerName: rental.customerName,
            introMessage: `Your rental contract ${rental.contractNumber} (reservation ${rental.reservationNumber}, ${rental.vehicleName}) has been finalized and closed.`,
            detailsTitle: 'RENTAL SUMMARY',
            vehicleName: rental.vehicleName,
            vehiclePhotoUrl: this.resolveVehicleImageUrl(rental.vehiclePhoto),
            rows: [
                { label: 'Rental Contract', value: rental.contractNumber },
                {
                    label: 'Reservation Reference',
                    value: rental.reservationNumber,
                },
                { label: 'Status', value: 'Closed', isStatus: true },
            ],
            postMessage:
                'All invoice balances and security deposit settlements have been completed. We look forward to welcoming you again.',
            ctaButton: {
                label: 'EXPLORE FLEET →',
                url: `${(this.configService?.get<string>('FRONTEND_URL') ?? 'http://localhost:3000').replace(/\/$/, '')}/vehicles`,
            },
            signoff: 'Kind regards, The LUXUAR Team',
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
            htmlMessage,
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
     * Enqueues and dispatches a branded invoice notification when a final invoice is issued.
     */
    async notifyInvoiceIssued(
        rentalId: string,
        invoiceNumber: string,
        totalAmountEur: string,
    ): Promise<void> {
        await this.ensureSchema();
        const rental = await this.loadRentalDetails(rentalId);
        if (!rental) return;

        const frontendBaseUrl = (
            this.configService?.get<string>('FRONTEND_URL') ??
            process.env.FRONTEND_URL ??
            'http://localhost:3000'
        ).replace(/\/$/, '');
        const rentalsUrl = `${frontendBaseUrl}/account/rentals`;

        const notificationEventKey = `invoice:${invoiceNumber}:issued:customer`;
        const notificationId = await this.ensureCustomerNotification({
            recipientId: rental.customerId,
            category: 'payments',
            priority: 'info',
            title: `Final invoice ${invoiceNumber} issued`,
            message: `Your final invoice ${invoiceNumber} for rental ${rental.contractNumber} (${rental.vehicleName}) has been issued. Total: EUR ${totalAmountEur}.`,
            actionUrl: '/account/rentals',
            eventKey: notificationEventKey,
            entityType: 'rental',
            entityId: rental.rentalId,
        });

        const rows = [
            { label: 'Invoice Number', value: invoiceNumber },
            { label: 'Rental Contract', value: rental.contractNumber },
            { label: 'Reservation Reference', value: rental.reservationNumber },
            {
                label: 'Total Invoiced Amount',
                value: `EUR ${Number(totalAmountEur).toFixed(2)}`,
            },
            { label: 'Status', value: 'Issued', isStatus: true },
        ];

        const htmlMessage = renderLuxuarEmailHtml({
            kicker: 'FINANCIAL STATEMENT',
            heading: 'Final Invoice Issued',
            customerName: rental.customerName,
            introMessage: `Your final invoice for rental contract ${rental.contractNumber} (${rental.vehicleName}) has been finalized and issued by LUXUAR Accounting.`,
            detailsTitle: 'INVOICE SUMMARY',
            vehicleName: rental.vehicleName,
            vehiclePhotoUrl: this.resolveVehicleImageUrl(rental.vehiclePhoto),
            rows,
            postMessage:
                'You can view and download your official PDF invoice directly from your LUXUAR account portal at any time.',
            ctaButton: {
                label: 'VIEW MY RENTALS & INVOICES →',
                url: rentalsUrl,
            },
            signoff: 'Kind regards, The LUXUAR Finance Team',
        });

        const plainText = renderLuxuarEmailText({
            kicker: 'FINANCIAL STATEMENT',
            heading: 'Final Invoice Issued',
            customerName: rental.customerName,
            introMessage: `Your final invoice for rental contract ${rental.contractNumber} (${rental.vehicleName}) has been finalized and issued by LUXUAR Accounting.`,
            detailsTitle: 'INVOICE SUMMARY',
            vehicleName: rental.vehicleName,
            rows: [
                { label: 'Invoice Number', value: invoiceNumber },
                { label: 'Rental Contract', value: rental.contractNumber },
                { label: 'Reservation Reference', value: rental.reservationNumber },
                {
                    label: 'Total Invoiced Amount',
                    value: `EUR ${Number(totalAmountEur).toFixed(2)}`,
                },
                { label: 'Status', value: 'Issued' },
            ],
            postMessage:
                'You can view and download your official PDF invoice directly from your LUXUAR account portal at any time.',
            ctaButton: {
                label: 'VIEW MY RENTALS & INVOICES',
                url: rentalsUrl,
            },
            signoff: 'Kind regards, The LUXUAR Finance Team',
        });

        await this.enqueueEmail({
            customerId: rental.customerId,
            recipientEmail: rental.customerEmail,
            eventKey: `invoice:${invoiceNumber}:issued`,
            templateType: 'invoice_issued',
            notificationId,
            subject: `Final Invoice ${invoiceNumber} — LUXUAR Rental Contract ${rental.contractNumber}`,
            message: plainText,
            htmlMessage,
        });

        await this.processOutboxBatch();
    }

    async safelyNotifyInvoiceIssued(
        rentalId: string,
        invoiceNumber: string,
        totalAmountEur: string,
    ): Promise<void> {
        try {
            await this.notifyInvoiceIssued(
                rentalId,
                invoiceNumber,
                totalAmountEur,
            );
        } catch (error) {
            this.logger.warn(
                `Invoice email could not be queued for rental ${rentalId}: ${this.sanitizeError(error)}`,
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

        const htmlMessage = renderLuxuarEmailHtml({
            kicker: 'SECURITY & VERIFICATION',
            heading: 'Verify Your Email Address',
            customerName,
            introMessage:
                'Thank you for registering with LUXUAR. Please click the button below to verify your email address and activate your bespoke car rental access.',
            detailsTitle: 'SECURITY DETAILS',
            rows: [
                { label: 'Registered Email', value: input.recipientEmail || 'Registered Client' },
                { label: 'Security Link', value: 'Single-use secure verification', isStatus: true },
                { label: 'Validity Period', value: '5 minutes from issuance' },
            ],
            postMessage:
                'If you did not request this account registration, please disregard this email. Your email address will not be activated without verification.',
            ctaButton: {
                label: 'VERIFY EMAIL',
                url: verifyUrl,
            },
            signoff: 'Kind regards, The LUXUAR Team',
        });

        await this.enqueueEmail({
            customerId: input.customerId,
            recipientEmail: input.recipientEmail ?? null,
            eventKey: `auth:email_verification:${input.tokenId}`,
            templateType: 'email_verification',
            subject: 'Verify your email address — LUXUAR',
            message: [
                `Dear ${customerName},`,
                '',
                'Thank you for registering with LUXUAR.',
                'Please verify your email address to activate your account by clicking the secure link below:',
                '',
                verifyUrl,
                '',
                'This single-use link is valid for 5 minutes.',
                'If you did not create a LUXUAR account, you can safely ignore this message.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
            htmlMessage,
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
        const frontendBaseUrl =
            process.env.FRONTEND_URL ||
            process.env.APP_URL ||
            'http://localhost:3000';
        const queryParams = new URLSearchParams({
            token: input.token,
            ...(input.recipientEmail ? { email: input.recipientEmail } : {}),
        });
        const resetUrl = `${frontendBaseUrl}/reset-password?${queryParams.toString()}`;

        const htmlMessage = renderLuxuarEmailHtml({
            kicker: 'ACCOUNT SECURITY',
            heading: 'Password Reset Request',
            customerName,
            introMessage:
                'We received a request to reset the password for your LUXUAR account.',
            detailsTitle: 'RESET CREDENTIALS',
            rows: [
                { label: 'One-Time Token', value: input.token, isStatus: true },
                { label: 'Valid Until', value: expiresIso },
            ],
            postMessage:
                'If you did not request a password reset, no action is needed and your password will remain unchanged.',
            ctaButton: {
                label: 'RESET YOUR PASSWORD →',
                url: resetUrl,
            },
            signoff: 'Kind regards, The LUXUAR Team',
        });

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
                'To reset your password, please click the link below:',
                resetUrl,
                '',
                'Or manually enter your one-time reset token on the reset page:',
                `One-time reset token: ${input.token}`,
                `Valid until: ${expiresIso}`,
                '',
                'If you did not request a password reset, no action is needed and your password will remain unchanged.',
                '',
                'LUXUAR Concierge',
            ].join('\n'),
            htmlMessage,
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
        vehiclePhoto?: string | null;
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
                    img.storage_path AS "vehiclePhoto"
             FROM reservations r
             LEFT JOIN users u ON u.id = r.customer_id
             LEFT JOIN vehicles v ON v.id = r.vehicle_id
             LEFT JOIN vehicle_models m ON m.id = v.model_id
             LEFT JOIN brands b ON b.id = m.brand_id
             LEFT JOIN LATERAL (
                 SELECT storage_path FROM vehicle_images
                 WHERE vehicle_id = v.id
                 ORDER BY is_primary DESC, sort_order ASC
                 LIMIT 1
             ) img ON true
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
        vehiclePhoto?: string | null;
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
                    img.storage_path AS "vehiclePhoto"
             FROM reservations r
             LEFT JOIN users u ON u.id = r.customer_id
             LEFT JOIN vehicles v ON v.id = r.vehicle_id
             LEFT JOIN vehicle_models m ON m.id = v.model_id
             LEFT JOIN brands b ON b.id = m.brand_id
             LEFT JOIN LATERAL (
                 SELECT storage_path FROM vehicle_images
                 WHERE vehicle_id = v.id
                 ORDER BY is_primary DESC, sort_order ASC
                 LIMIT 1
             ) img ON true
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
        vehiclePhoto?: string | null;
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
                    vr.reference AS "returnReference",
                    img.storage_path AS "vehiclePhoto"
             FROM rentals l
             JOIN reservations r ON r.id = l.reservation_id
             LEFT JOIN users u ON u.id = r.customer_id
             LEFT JOIN vehicles v ON v.id = r.vehicle_id
             LEFT JOIN vehicle_models m ON m.id = v.model_id
             LEFT JOIN brands b ON b.id = m.brand_id
             LEFT JOIN LATERAL (
                 SELECT storage_path FROM vehicle_images
                 WHERE vehicle_id = v.id
                 ORDER BY is_primary DESC, sort_order ASC
                 LIMIT 1
             ) img ON true
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
            vehiclePhoto: row.vehiclePhoto ?? null,
        };
    }

    private resolveVehicleImageUrl(storagePath?: string | null): string | null {
        if (!storagePath || typeof storagePath !== 'string') return null;
        const trimmed = storagePath.trim();
        if (!trimmed) return null;
        if (/^https?:\/\//i.test(trimmed)) {
            return trimmed;
        }
        const frontendBaseUrl = (
            this.configService?.get<string>('FRONTEND_URL') ??
            process.env.FRONTEND_URL ??
            'http://localhost:3000'
        ).replace(/\/$/, '');
        const cleanPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
        return `${frontendBaseUrl}${cleanPath}`;
    }

    private extractLocalInlineAttachments(html?: string | null): {
        html: string | null;
        attachments: EmailInlineAttachment[];
    } {
        if (!html || !html.trim()) {
            return { html: null, attachments: [] };
        }
        let processedHtml = html;
        const attachments: EmailInlineAttachment[] = [];

        const imgRegex = /src="((?:https?:\/\/[^"]+)?\/vehicles\/([a-zA-Z0-9._-]+))"/g;
        let match: RegExpExecArray | null;
        let idx = 0;

        while ((match = imgRegex.exec(html)) !== null) {
            const fullUrl = match[1];
            const filename = path.basename(match[2]);
            if (!filename || filename.includes('..')) continue;

            const candidatePaths = [
                path.resolve(process.cwd(), '../frontend/public/vehicles', filename),
                path.resolve(process.cwd(), 'frontend/public/vehicles', filename),
            ];
            if (process.env.VEHICLE_IMAGES_DIR) {
                candidatePaths.unshift(
                    path.resolve(process.env.VEHICLE_IMAGES_DIR, filename),
                );
            }

            let foundPath: string | null = null;
            for (const candidate of candidatePaths) {
                try {
                    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                        foundPath = candidate;
                        break;
                    }
                } catch {
                    // ignore file access error
                }
            }

            if (!foundPath) continue;

            try {
                const fileBuf = fs.readFileSync(foundPath);
                const ext = path.extname(filename).toLowerCase();
                const contentType =
                    ext === '.jpg' || ext === '.jpeg'
                        ? 'image/jpeg'
                        : ext === '.webp'
                          ? 'image/webp'
                          : 'image/png';
                idx += 1;
                const cid =
                    idx === 1
                        ? 'vehicle-photo@luxuar.hu'
                        : `vehicle-photo-${idx}@luxuar.hu`;
                const rawB64 = fileBuf.toString('base64');
                const wrappedB64 = rawB64.replace(/(.{76})/g, '$1\r\n');

                attachments.push({
                    cid,
                    filename,
                    contentType,
                    contentBase64: wrappedB64,
                });

                processedHtml = processedHtml
                    .split(`src="${fullUrl}"`)
                    .join(`src="cid:${cid}"`);
            } catch {
                // Fallback to original URL if file read fails
            }
        }

        return { html: processedHtml, attachments };
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
        category: 'reservations' | 'rentals' | 'payments' | 'security' | 'fleet' | 'general';
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
        const user = snapshot.authEnabled
            ? this.getEnvString('SMTP_USER')
            : undefined;
        const password = snapshot.authEnabled
            ? this.getEnvString('SMTP_PASSWORD')
            : undefined;

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

            let dataPayload: string;
            if (payload.html && payload.html.trim().length > 0) {
                const inlineResolved = this.extractLocalInlineAttachments(
                    payload.html,
                );
                const finalHtml = inlineResolved.html ?? payload.html;
                const allAttachments = [
                    ...(payload.inlineAttachments ?? []),
                    ...inlineResolved.attachments,
                ];
                const altBoundary = `----=_Part_Alt_${randomUUID().replace(/-/g, '')}`;

                if (allAttachments.length > 0) {
                    const relBoundary = `----=_Part_Rel_${randomUUID().replace(/-/g, '')}`;
                    const headers = [
                        `From: ${sanitizeHeaderValue(payload.from)}`,
                        `To: <${toEnvelope}>`,
                        `Subject: ${sanitizeHeaderValue(payload.subject)}`,
                        `Message-ID: ${messageId}`,
                        `Date: ${new Date().toUTCString()}`,
                        'MIME-Version: 1.0',
                        `Content-Type: multipart/related; type="multipart/alternative"; boundary="${relBoundary}"`,
                    ];
                    const parts: string[] = [
                        `--${relBoundary}`,
                        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
                        '',
                        `--${altBoundary}`,
                        'Content-Type: text/plain; charset=utf-8',
                        'Content-Transfer-Encoding: 8bit',
                        '',
                        dotStuffBody(payload.text),
                        `--${altBoundary}`,
                        'Content-Type: text/html; charset=utf-8',
                        'Content-Transfer-Encoding: 8bit',
                        '',
                        dotStuffBody(finalHtml),
                        `--${altBoundary}--`,
                    ];
                    for (const att of allAttachments) {
                        parts.push(
                            `--${relBoundary}`,
                            `Content-Type: ${att.contentType}; name="${att.filename}"`,
                            'Content-Transfer-Encoding: base64',
                            `Content-ID: <${att.cid}>`,
                            `Content-Disposition: inline; filename="${att.filename}"`,
                            '',
                            att.contentBase64,
                        );
                    }
                    parts.push(`--${relBoundary}--`);
                    dataPayload = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n.`;
                } else {
                    const headers = [
                        `From: ${sanitizeHeaderValue(payload.from)}`,
                        `To: <${toEnvelope}>`,
                        `Subject: ${sanitizeHeaderValue(payload.subject)}`,
                        `Message-ID: ${messageId}`,
                        `Date: ${new Date().toUTCString()}`,
                        'MIME-Version: 1.0',
                        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
                    ];
                    const parts = [
                        `--${altBoundary}`,
                        'Content-Type: text/plain; charset=utf-8',
                        'Content-Transfer-Encoding: 8bit',
                        '',
                        dotStuffBody(payload.text),
                        `--${altBoundary}`,
                        'Content-Type: text/html; charset=utf-8',
                        'Content-Transfer-Encoding: 8bit',
                        '',
                        dotStuffBody(finalHtml),
                        `--${altBoundary}--`,
                    ];
                    dataPayload = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n.`;
                }
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
                dataPayload = `${headers.join('\r\n')}\r\n\r\n${dotStuffBody(payload.text)}\r\n.`;
            }
            await sendCommand(dataPayload, [250]);

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

    /**
     * Retrieves live outbox operational metrics for administrative monitoring.
     */
    async getOutboxMetrics(): Promise<{
        totalCount: number;
        pendingCount: number;
        sentCount: number;
        failedCount: number;
        deliverySlaRate: number;
        smtpConfig: {
            isConfigured: boolean;
            host: string | null;
            port: number;
            secure: boolean;
            from: string;
        };
    }> {
        await this.ensureSchema();
        const counts = await this.db.query(`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
            FROM customer_email_outbox;
        `);

        const row = counts?.[0] ?? { total: 0, pending: 0, sent: 0, failed: 0 };
        const total = Number(row.total || 0);
        const pending = Number(row.pending || 0);
        const sent = Number(row.sent || 0);
        const failed = Number(row.failed || 0);

        const deliveredAndFailed = sent + failed;
        const deliverySlaRate = deliveredAndFailed > 0
            ? Math.round((sent / deliveredAndFailed) * 1000) / 10
            : 100;

        const smtp = this.getSmtpConfigSnapshot();
        return {
            totalCount: total,
            pendingCount: pending,
            sentCount: sent,
            failedCount: failed,
            deliverySlaRate,
            smtpConfig: {
                // SmtpConfigSnapshot exposes `configured`; there is no TLS policy
                // setting in the SMTP configuration, so none is reported.
                isConfigured: smtp.configured,
                host: smtp.host,
                port: smtp.port,
                secure: smtp.secure,
                from: smtp.from,
            },
        };
    }

    /**
     * Returns paginated outbox items with optional status filtering and search.
     */
    async getOutboxItems(options?: {
        status?: string;
        search?: string;
        limit?: number;
        offset?: number;
    }): Promise<{
        items: Array<{
            id: string;
            customerId: string;
            recipientEmail: string;
            subject: string;
            templateType: string | null;
            status: string;
            attemptCount: number;
            maxAttempts: number;
            nextAttemptAt: string | null;
            lastError: string | null;
            createdAt: string;
            sentAt: string | null;
        }>;
        total: number;
    }> {
        await this.ensureSchema();
        const limit = Math.min(Math.max(1, options?.limit ?? 30), 100);
        const offset = Math.max(0, options?.offset ?? 0);

        const conditions: string[] = ['1=1'];
        const params: any[] = [];
        let pIndex = 1;

        if (options?.status && ['pending', 'sent', 'failed'].includes(options.status)) {
            conditions.push(`o.status = $${pIndex++}`);
            params.push(options.status);
        }

        if (options?.search && options.search.trim().length > 0) {
            conditions.push(`(o.subject ILIKE $${pIndex} OR o.recipient_email ILIKE $${pIndex} OR u.email ILIKE $${pIndex})`);
            params.push(`%${options.search.trim()}%`);
            pIndex++;
        }

        const whereSql = conditions.join(' AND ');

        const countRes = await this.db.query(
            `SELECT COUNT(*)::int AS count
             FROM customer_email_outbox o
             LEFT JOIN users u ON u.id = o.customer_id
             WHERE ${whereSql}`,
            params,
        );
        const total = Number(countRes?.[0]?.count || 0);

        const rows = await this.db.query(
            `SELECT o.id,
                    o.customer_id AS "customerId",
                    COALESCE(o.recipient_email, u.email, 'unknown') AS "recipientEmail",
                    o.subject,
                    o.template_type AS "templateType",
                    o.status,
                    COALESCE(o.attempt_count, 0) AS "attemptCount",
                    COALESCE(o.max_attempts, 3) AS "maxAttempts",
                    o.next_attempt_at AS "nextAttemptAt",
                    o.last_error AS "lastError",
                    o.created_at AS "createdAt",
                    o.sent_at AS "sentAt"
             FROM customer_email_outbox o
             LEFT JOIN users u ON u.id = o.customer_id
             WHERE ${whereSql}
             ORDER BY o.created_at DESC
             LIMIT $${pIndex++} OFFSET $${pIndex++}`,
            [...params, limit, offset],
        );

        const sanitizedRows = rows.map((r: any) => ({
            ...r,
            lastError: r.lastError ? this.sanitizeError(r.lastError) : null,
        }));

        return { items: sanitizedRows, total };
    }

    /**
     * Safely resets a failed or stuck email outbox row for immediate retry.
     */
    async retryOutboxItem(id: string): Promise<{ success: boolean; message: string }> {
        await this.ensureSchema();
        const result = await this.db.query(
            `UPDATE customer_email_outbox
             SET status = 'pending',
                 attempt_count = 0,
                 next_attempt_at = now(),
                 last_error = NULL,
                 locked_at = NULL,
                 updated_at = now()
             WHERE id = $1::uuid
               AND status != 'sent'
               AND message != $2
             RETURNING id, recipient_email, subject`,
            [id, REDACTED_OUTBOX_MESSAGE],
        );

        if (!result || result.length === 0) {
            return {
                success: false,
                message: 'Outbox email record not found or already delivered.',
            };
        }

        await this.processOutboxBatch(5).catch(() => {});

        return { success: true, message: 'Email re-enqueued for delivery.' };
    }
}
