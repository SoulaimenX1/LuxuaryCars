import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().trim().min(1).optional(),
);

const optionalSecretString = z.preprocess(
    (val) => (typeof val === 'string' && val === '' ? undefined : val),
    z.string().min(1).optional(),
);

const optionalEncryptionKeyString = z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z
        .string()
        .trim()
        .min(32, 'EMAIL_OUTBOX_ENCRYPTION_KEY must be at least 32 characters')
        .optional(),
);

const booleanFromEnv = z.preprocess((val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
        const normalized = val.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') return true;
        if (normalized === 'false' || normalized === '0' || normalized === '') return false;
    }
    return val;
}, z.boolean());

export const envSchema = z
    .object({
        // Application environment
        NODE_ENV: z
            .enum([
                'development',
                'test',
                'production',
            ])
            .default('development'),

        // Application port
        PORT: z.coerce
            .number()
            .int()
            .min(1)
            .max(65535)
            .default(3001),

        // PostgreSQL configuration
        DB_HOST: z
            .string()
            .min(1),

        DB_PORT: z.coerce
            .number()
            .int()
            .min(1)
            .max(65535)
            .default(5432),

        DB_USERNAME: z
            .string()
            .min(1),

        DB_PASSWORD: z
            .string()
            .min(1),

        DB_DATABASE: z
            .string()
            .min(1),

        // Vehicle rental fallback used only when no physical assignment exists.
        DEFAULT_RENTAL_AGENCY_CODE: z
            .string()
            .regex(/^[A-Z0-9-]{2,40}$/)
            .default('BUD-SHOWROOM'),

        NO_SHOW_GRACE_PERIOD_MINUTES: z.coerce
            .number()
            .int()
            .min(1)
            .max(1440)
            .default(120),

        NO_SHOW_SCAN_INTERVAL_MS: z.coerce
            .number()
            .int()
            .min(1000)
            .max(3600000)
            .default(60000),

        // Transactional Email & SMTP configuration
        SMTP_HOST: optionalNonEmptyString,

        SMTP_PORT: z.coerce
            .number()
            .int()
            .min(1)
            .max(65535)
            .default(587),

        SMTP_SECURE: booleanFromEnv.default(false),

        SMTP_USER: optionalNonEmptyString,

        SMTP_PASSWORD: optionalSecretString,

        SMTP_FROM: z
            .string()
            .trim()
            .min(3)
            .max(255)
            .regex(/^[^\r\n]+$/, 'SMTP_FROM must not contain CR/LF characters')
            .default('LUXUAR Concierge <no-reply@luxuar.hu>'),

        SMTP_TIMEOUT_MS: z.coerce
            .number()
            .int()
            .min(1000)
            .max(60000)
            .default(10000),

        // Local Mailpit SMTP override (development/test only; preserves SMTP_* Gmail credentials)
        MAILPIT_ENABLED: booleanFromEnv.default(false),

        MAILPIT_SMTP_HOST: z
            .string()
            .trim()
            .min(1)
            .default('127.0.0.1'),

        MAILPIT_SMTP_PORT: z.coerce
            .number()
            .int()
            .min(1)
            .max(65535)
            .default(1025),

        MAILPIT_HTTP_URL: z
            .string()
            .trim()
            .min(1)
            .default('http://127.0.0.1:8025'),

        EMAIL_OUTBOX_MAX_ATTEMPTS: z.coerce
            .number()
            .int()
            .min(1)
            .max(10)
            .default(3),

        EMAIL_OUTBOX_BASE_DELAY_MS: z.coerce
            .number()
            .int()
            .min(100)
            .max(3600000)
            .default(30000),

        EMAIL_OUTBOX_SCAN_INTERVAL_MS: z.coerce
            .number()
            .int()
            .min(1000)
            .max(3600000)
            .default(30000),

        EMAIL_OUTBOX_ENCRYPTION_KEY: optionalEncryptionKeyString,

        // JWT authentication & token lifetimes
        JWT_SECRET: z
            .string()
            .min(32),

        JWT_ACCESS_EXPIRES_IN_SECONDS: z.coerce
            .number()
            .int()
            .min(60)
            .max(86400)
            .default(900),

        JWT_REFRESH_EXPIRES_IN_SECONDS: z.coerce
            .number()
            .int()
            .min(300)
            .max(7776000)
            .default(2592000),

        PASSWORD_RESET_EXPIRES_IN_SECONDS: z.coerce
            .number()
            .int()
            .min(300)
            .max(86400)
            .default(3600),

        // Email verification links are valid for exactly 5 minutes
        // (hard maximum; may only be shortened, never extended).
        EMAIL_VERIFICATION_EXPIRES_IN_SECONDS: z.coerce
            .number()
            .int()
            .min(60)
            .max(300)
            .default(300),

        // WebAuthn / Passkeys configuration
        WEBAUTHN_RP_ID: z.string().trim().min(1).default('localhost'),
        WEBAUTHN_RP_NAME: z.string().trim().min(1).default('LUXUAR Car Rental'),
        WEBAUTHN_ORIGIN: z.string().trim().min(1).default('http://localhost:3000'),

        // Feature flags
        ENABLE_DYNAMIC_PRICING: booleanFromEnv.default(false),
        ENABLE_PREDICTIVE_ANALYTICS: booleanFromEnv.default(false),

        // Stripe Checkout configuration
        STRIPE_SECRET_KEY: optionalSecretString,
        STRIPE_WEBHOOK_SECRET: optionalSecretString,
        STRIPE_TEST_MODE: booleanFromEnv.default(true),
        FRONTEND_URL: z.string().trim().min(1).default('http://localhost:3000'),
    })
    .passthrough()
    .superRefine((env, ctx) => {
        if ((env.SMTP_USER && !env.SMTP_PASSWORD) || (!env.SMTP_USER && env.SMTP_PASSWORD)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['SMTP_PASSWORD'],
                message: 'Both SMTP_USER and SMTP_PASSWORD must be provided together when SMTP authentication is enabled',
            });
        }
        if (
            env.MAILPIT_ENABLED &&
            !['127.0.0.1', 'localhost', '::1'].includes(
                env.MAILPIT_SMTP_HOST.trim().toLowerCase(),
            )
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['MAILPIT_SMTP_HOST'],
                message: 'MAILPIT_SMTP_HOST must be bound to localhost (127.0.0.1, localhost, or ::1)',
            });
        }
    });

export type Env = z.infer<typeof envSchema>;
