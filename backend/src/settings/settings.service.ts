import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface PlatformSettingsValues {
    paymentHoldWindowHours: number;
    vatRatePercentage: number;
    supercarMinAge: number;
    hypercarMinAge: number;
    minLicenceYears: number;
    depositHoldDays: number;
    showroomOpensAt: string;
    showroomClosesAt: string;
    supportPhone: string;
    supportEmail: string;
    baseCurrency: string;
    strictLicenceVerification: boolean;
    dynamicPricingEnabled?: boolean;
    predictiveAnalyticsEnabled?: boolean;
    updatedAt?: string;
    updatedBy?: string | null;
}

const DEFAULT_SETTINGS: Record<string, { value: string; category: string; description: string }> = {
    payment_hold_window_hours: {
        value: '24',
        category: 'reservations',
        description: 'Hours before an unpaid approved reservation hold automatically releases',
    },
    vat_rate_percentage: {
        value: '20',
        category: 'finance',
        description: 'Standard VAT percentage rate applicable to rental contracts',
    },
    supercar_min_age: {
        value: '25',
        category: 'eligibility',
        description: 'Minimum driver age requirement for Supercar category vehicles',
    },
    hypercar_min_age: {
        value: '28',
        category: 'eligibility',
        description: 'Minimum driver age requirement for Hypercar category vehicles',
    },
    min_licence_years: {
        value: '2',
        category: 'eligibility',
        description: 'Minimum required years of driving licence tenure',
    },
    deposit_hold_days: {
        value: '7',
        category: 'finance',
        description: 'Default maximum retention period for pre-authorized security deposits',
    },
    showroom_opens_at: {
        value: '08:00',
        category: 'operations',
        description: 'Daily opening time for showroom operations and vehicle handover',
    },
    showroom_closes_at: {
        value: '20:00',
        category: 'operations',
        description: 'Daily closing time for showroom operations and vehicle handover',
    },
    support_phone: {
        value: '+33 1 42 68 55 00',
        category: 'general',
        description: 'Official concierge telephone line displayed on contracts and receipts',
    },
    support_email: {
        value: 'concierge@luxuar.com',
        category: 'general',
        description: 'Official customer support and notification sender email address',
    },
    base_currency: {
        value: 'EUR',
        category: 'finance',
        description: 'Primary institutional accounting and contract settlement currency',
    },
    strict_licence_verification: {
        value: 'true',
        category: 'security',
        description: 'Enforce front and back photographic licence verification prior to vehicle release',
    },
    dynamic_pricing_enabled: {
        value: 'false',
        category: 'pricing',
        description: 'Master switch for intelligent rule-based dynamic pricing (seasonal, calendar, duration privilege)',
    },
    predictive_analytics_enabled: {
        value: 'false',
        category: 'analytics',
        description: 'Master switch for executive predictive demand forecasts, fleet utilization trends, and booking insights',
    },
};

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class SettingsService implements OnModuleInit {
    private readonly logger = new Logger(SettingsService.name);
    private schemaEnsured = false;

    constructor(private readonly db: DataSource) {}

    async onModuleInit(): Promise<void> {
        await this.ensureSchema();
    }

    async ensureSchema(): Promise<void> {
        if (this.schemaEnsured) return;

        try {
            await this.db.query(`
                CREATE TABLE IF NOT EXISTS platform_settings (
                    key varchar(100) PRIMARY KEY,
                    value text NOT NULL,
                    category varchar(50) NOT NULL DEFAULT 'general',
                    description text,
                    updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
                    updated_at timestamptz NOT NULL DEFAULT now()
                );
            `);

            // Seed default settings if table is empty
            const existing = await this.db.query(`SELECT COUNT(*)::int AS count FROM platform_settings;`);
            if (Number(existing?.[0]?.count || 0) === 0) {
                for (const [key, item] of Object.entries(DEFAULT_SETTINGS)) {
                    await this.db.query(
                        `INSERT INTO platform_settings (key, value, category, description)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (key) DO NOTHING`,
                        [key, item.value, item.category, item.description],
                    );
                }
                this.logger.log('Default platform settings seeded successfully.');
            }

            this.schemaEnsured = true;
        } catch (error) {
            this.logger.warn(`Could not ensure platform_settings table: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async getSettings(): Promise<PlatformSettingsValues> {
        await this.ensureSchema();

        const rows: Array<{ key: string; value: string; updated_at: string; updated_by: string | null }> =
            await this.db.query(`SELECT key, value, updated_at, updated_by FROM platform_settings;`);

        const map = new Map<string, string>();
        let latestUpdatedAt: string | undefined;
        let latestUpdatedBy: string | null = null;

        for (const row of rows) {
            map.set(row.key, row.value);
            if (!latestUpdatedAt || new Date(row.updated_at) > new Date(latestUpdatedAt)) {
                latestUpdatedAt = new Date(row.updated_at).toISOString();
                latestUpdatedBy = row.updated_by;
            }
        }

        const getVal = (key: string, defaultVal: string): string => map.get(key) ?? defaultVal;

        return {
            paymentHoldWindowHours: parseInt(getVal('payment_hold_window_hours', '24'), 10) || 24,
            vatRatePercentage: parseFloat(getVal('vat_rate_percentage', '20')) || 20,
            supercarMinAge: parseInt(getVal('supercar_min_age', '25'), 10) || 25,
            hypercarMinAge: parseInt(getVal('hypercar_min_age', '28'), 10) || 28,
            minLicenceYears: parseInt(getVal('min_licence_years', '2'), 10) || 2,
            depositHoldDays: parseInt(getVal('deposit_hold_days', '7'), 10) || 7,
            showroomOpensAt: getVal('showroom_opens_at', '08:00'),
            showroomClosesAt: getVal('showroom_closes_at', '20:00'),
            supportPhone: getVal('support_phone', '+33 1 42 68 55 00'),
            supportEmail: getVal('support_email', 'concierge@luxuar.com'),
            baseCurrency: getVal('base_currency', 'EUR'),
            strictLicenceVerification: getVal('strict_licence_verification', 'true') === 'true',
            dynamicPricingEnabled: getVal('dynamic_pricing_enabled', 'false') === 'true',
            predictiveAnalyticsEnabled: getVal('predictive_analytics_enabled', 'false') === 'true',
            updatedAt: latestUpdatedAt,
            updatedBy: latestUpdatedBy,
        };
    }

    async updateSettings(
        input: Partial<PlatformSettingsValues>,
        actorId?: string,
    ): Promise<PlatformSettingsValues> {
        await this.ensureSchema();

        const updates: Array<{ key: string; value: string }> = [];

        if (input.paymentHoldWindowHours !== undefined) {
            const h = Number(input.paymentHoldWindowHours);
            if (isNaN(h) || h < 1 || h > 168) {
                throw new BadRequestException('Payment hold window must be between 1 and 168 hours.');
            }
            updates.push({ key: 'payment_hold_window_hours', value: Math.round(h).toString() });
        }

        if (input.vatRatePercentage !== undefined) {
            const vat = Number(input.vatRatePercentage);
            if (isNaN(vat) || vat < 0 || vat > 60) {
                throw new BadRequestException('VAT rate percentage must be between 0% and 60%.');
            }
            updates.push({ key: 'vat_rate_percentage', value: vat.toString() });
        }

        if (input.supercarMinAge !== undefined) {
            const age = Number(input.supercarMinAge);
            if (isNaN(age) || age < 18 || age > 50) {
                throw new BadRequestException('Supercar minimum age must be between 18 and 50 years.');
            }
            updates.push({ key: 'supercar_min_age', value: Math.round(age).toString() });
        }

        if (input.hypercarMinAge !== undefined) {
            const age = Number(input.hypercarMinAge);
            if (isNaN(age) || age < 21 || age > 65) {
                throw new BadRequestException('Hypercar minimum age must be between 21 and 65 years.');
            }
            updates.push({ key: 'hypercar_min_age', value: Math.round(age).toString() });
        }

        if (input.minLicenceYears !== undefined) {
            const tenure = Number(input.minLicenceYears);
            if (isNaN(tenure) || tenure < 1 || tenure > 15) {
                throw new BadRequestException('Minimum licence tenure must be between 1 and 15 years.');
            }
            updates.push({ key: 'min_licence_years', value: Math.round(tenure).toString() });
        }

        if (input.depositHoldDays !== undefined) {
            const d = Number(input.depositHoldDays);
            if (isNaN(d) || d < 1 || d > 60) {
                throw new BadRequestException('Deposit retention period must be between 1 and 60 days.');
            }
            updates.push({ key: 'deposit_hold_days', value: Math.round(d).toString() });
        }

        if (input.showroomOpensAt !== undefined) {
            if (!TIME_REGEX.test(input.showroomOpensAt.trim())) {
                throw new BadRequestException('Showroom opening time must follow 24h format HH:MM.');
            }
            updates.push({ key: 'showroom_opens_at', value: input.showroomOpensAt.trim() });
        }

        if (input.showroomClosesAt !== undefined) {
            if (!TIME_REGEX.test(input.showroomClosesAt.trim())) {
                throw new BadRequestException('Showroom closing time must follow 24h format HH:MM.');
            }
            updates.push({ key: 'showroom_closes_at', value: input.showroomClosesAt.trim() });
        }

        if (input.supportPhone !== undefined) {
            const phone = input.supportPhone.trim();
            if (phone.length < 5 || phone.length > 40) {
                throw new BadRequestException('Support phone must be between 5 and 40 characters.');
            }
            updates.push({ key: 'support_phone', value: phone });
        }

        if (input.supportEmail !== undefined) {
            const email = input.supportEmail.trim();
            if (!EMAIL_REGEX.test(email)) {
                throw new BadRequestException('Support email must be a valid email address.');
            }
            updates.push({ key: 'support_email', value: email });
        }

        if (input.baseCurrency !== undefined) {
            const curr = input.baseCurrency.trim().toUpperCase();
            if (!['EUR', 'USD', 'GBP', 'CHF', 'AED'].includes(curr)) {
                throw new BadRequestException('Base currency must be one of EUR, USD, GBP, CHF, AED.');
            }
            updates.push({ key: 'base_currency', value: curr });
        }

        if (input.strictLicenceVerification !== undefined) {
            updates.push({
                key: 'strict_licence_verification',
                value: input.strictLicenceVerification ? 'true' : 'false',
            });
        }

        if (input.dynamicPricingEnabled !== undefined) {
            updates.push({
                key: 'dynamic_pricing_enabled',
                value: input.dynamicPricingEnabled ? 'true' : 'false',
            });
        }

        if (input.predictiveAnalyticsEnabled !== undefined) {
            updates.push({
                key: 'predictive_analytics_enabled',
                value: input.predictiveAnalyticsEnabled ? 'true' : 'false',
            });
        }

        if (updates.length === 0) {
            return this.getSettings();
        }

        const oldSettings = await this.getSettings();

        // Perform atomic upsert of updated settings
        for (const item of updates) {
            await this.db.query(
                `INSERT INTO platform_settings (key, value, updated_by, updated_at)
                 VALUES ($1, $2, $3::uuid, now())
                 ON CONFLICT (key) DO UPDATE
                 SET value = EXCLUDED.value,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = now()`,
                [item.key, item.value, actorId || null],
            );
        }

        const newSettings = await this.getSettings();

        // Record audit trail event in PostgreSQL audit_logs
        try {
            await this.db.query(
                `INSERT INTO audit_logs (actor_id, action, entity_type, old_values, new_values)
                 VALUES ($1::uuid, 'PLATFORM_SETTINGS_UPDATED', 'platform_settings', $2::jsonb, $3::jsonb)`,
                [
                    actorId || null,
                    JSON.stringify(oldSettings),
                    JSON.stringify(newSettings),
                ],
            );
        } catch (auditError) {
            this.logger.warn(`Failed to log settings update to audit_logs: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
        }

        return newSettings;
    }
}
