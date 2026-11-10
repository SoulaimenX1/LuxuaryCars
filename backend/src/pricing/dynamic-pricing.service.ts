import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import type {
    ApplyPricingRecommendationDto,
    ScopedPricingRuleDto,
} from '../dashboard/dto/pricing-demand.dto.js';

export interface DynamicPricingStatus {
    enabled: boolean;
    source: 'database' | 'environment_fallback';
    updatedAt?: string;
    updatedBy?: string | null;
    activeRules: {
        seasonalPeak: boolean;
        weekendPrime: boolean;
        categoryTiers: number;
        durationPrivilege: number;
        demandTelemetryGated: boolean;
    };
}

export interface DynamicPricingAdjustment {
    code: string;
    label: string;
    type: 'seasonal' | 'weekend' | 'category' | 'demand';
    percentage: number;
    amount: string;
}

export interface DynamicPricingBreakdown {
    enabled: boolean;
    baseDailyRate: string;
    effectiveDailyRate: string;
    averageFactor: number;
    adjustments: DynamicPricingAdjustment[];
    durationDiscount: {
        tier: string;
        percentage: number;
        amount: string;
    } | null;
    taxes: {
        rate: number;
        name: string;
        includedInTotal: boolean;
        amount: string;
    };
}

export interface CalculatePricingInput {
    vehicleId: string;
    baseDailyPriceCents: number;
    pickupAt: Date;
    returnAt: Date;
    rentalDays: number;
    categoryName?: string;
    extraTotalCents?: number;
    promotionPercentage?: number;
    executor?: Pick<DataSource, 'query'>;
}

export interface CalculatePricingOutput {
    effectiveDailyPriceCents: number;
    baseAmountCents: number;
    discountAmountCents: number;
    durationDiscountCents: number;
    promotionDiscountCents: number;
    breakdown: DynamicPricingBreakdown;
}

@Injectable()
export class DynamicPricingService implements OnModuleInit {
    private readonly logger = new Logger(DynamicPricingService.name);
    private runtimeEnabled: boolean | null = null;

    constructor(
        private readonly configService: ConfigService,
        private readonly dataSource: DataSource,
        @Optional() private readonly vehiclesService?: VehiclesService,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.syncFromDatabase();
    }

    /**
     * Synchronize dynamic pricing state from persistent platform_settings table
     */
    async syncFromDatabase(): Promise<boolean> {
        try {
            await this.ensureSettingsRow();
            const rows: Array<{ value: string }> = await this.dataSource.query(
                `SELECT value FROM platform_settings WHERE key = 'dynamic_pricing_enabled' LIMIT 1`,
            );
            if (rows && rows.length > 0) {
                this.runtimeEnabled = rows[0].value === 'true';
            } else {
                const flag = this.configService.get<string | boolean>('ENABLE_DYNAMIC_PRICING');
                this.runtimeEnabled = flag === true || flag === 'true' || flag === '1';
            }
        } catch (error) {
            const flag = this.configService.get<string | boolean>('ENABLE_DYNAMIC_PRICING');
            this.runtimeEnabled = flag === true || flag === 'true' || flag === '1';
            this.logger.warn(`Could not sync dynamic pricing from platform_settings, falling back to environment: ${error instanceof Error ? error.message : String(error)}`);
        }
        return this.runtimeEnabled;
    }

    /**
     * Ensure default settings row exists in platform_settings table
     */
    async ensureSettingsRow(): Promise<void> {
        try {
            await this.dataSource.query(
                `INSERT INTO platform_settings (key, value, category, description)
                 VALUES ('dynamic_pricing_enabled', 'false', 'pricing', 'Master switch for intelligent rule-based dynamic pricing (seasonal, calendar, duration privilege)')
                 ON CONFLICT (key) DO NOTHING`,
            );
        } catch {
            // Ignore if platform_settings is being initialized or unavailable
        }
    }

    /**
     * Check if dynamic pricing feature flag is enabled
     */
    isEnabled(): boolean {
        if (this.runtimeEnabled !== null) {
            return this.runtimeEnabled;
        }
        const flag = this.configService.get<string | boolean>('ENABLE_DYNAMIC_PRICING');
        return flag === true || flag === 'true' || flag === '1';
    }

    /**
     * Get authoritative dynamic pricing status
     */
    async getStatus(): Promise<DynamicPricingStatus> {
        await this.ensureSettingsRow();
        let updatedAt: string | undefined;
        let updatedBy: string | null = null;
        let source: 'database' | 'environment_fallback' = 'environment_fallback';

        try {
            const rows: Array<{ value: string; updated_at: string; updated_by: string | null }> =
                await this.dataSource.query(
                    `SELECT value, updated_at, updated_by FROM platform_settings WHERE key = 'dynamic_pricing_enabled' LIMIT 1`,
                );
            if (rows && rows.length > 0) {
                source = 'database';
                updatedAt = rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : undefined;
                updatedBy = rows[0].updated_by;
            }
        } catch {
            // fallback
        }

        return {
            enabled: this.isEnabled(),
            source,
            updatedAt,
            updatedBy,
            activeRules: {
                seasonalPeak: true,
                weekendPrime: true,
                categoryTiers: 4,
                durationPrivilege: 4,
                demandTelemetryGated: true,
            },
        };
    }

    /**
     * Update dynamic pricing enabled status with runtime immediacy and DB persistence
     */
    async setEnabled(
        enabled: boolean,
        actorId?: string,
    ): Promise<{ success: boolean; enabled: boolean; updatedAt: string; updatedBy: string | null }> {
        this.runtimeEnabled = enabled;

        await this.dataSource.query(
            `INSERT INTO platform_settings (key, value, category, description, updated_by, updated_at)
             VALUES ('dynamic_pricing_enabled', $1, 'pricing', 'Master switch for intelligent rule-based dynamic pricing (seasonal, calendar, duration privilege)', $2::uuid, now())
             ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = now()`,
            [enabled ? 'true' : 'false', actorId || null],
        );

        // Record audit trail entry without sensitive data
        try {
            await this.dataSource.query(
                `INSERT INTO audit_logs (actor_id, action, entity_type, new_values)
                 VALUES ($1::uuid, 'DYNAMIC_PRICING_TOGGLED', 'pricing_settings', $2::jsonb)`,
                [
                    actorId || null,
                    JSON.stringify({
                        enabled,
                        toggledAt: new Date().toISOString(),
                        action: enabled ? 'ACTIVATED' : 'DEACTIVATED',
                    }),
                ],
            );
        } catch (auditErr) {
            this.logger.warn(`Could not log pricing toggle to audit_logs: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
        }

        this.logger.log(`Dynamic pricing ${enabled ? 'ENABLED' : 'DISABLED'} by admin actor ${actorId || 'system'}`);

        return {
            success: true,
            enabled: this.runtimeEnabled,
            updatedAt: new Date().toISOString(),
            updatedBy: actorId || null,
        };
    }

    /**
     * Retrieve all active and historical scoped pricing rules
     */
    async getApprovedPricingRules(): Promise<ScopedPricingRuleDto[]> {
        try {
            const rows = await this.dataSource.query(
                `SELECT value FROM platform_settings WHERE key = 'approved_pricing_rules' LIMIT 1`,
            );
            if (rows?.[0]?.value) {
                const rules: ScopedPricingRuleDto[] = JSON.parse(rows[0].value);
                const missingMeta = rules.some((r) => !r.brand || !r.imageUrl);
                if (missingMeta) {
                    try {
                        const vehicles = await this.dataSource.query(
                            `SELECT v.license_plate, m.name AS model_name, b.name AS brand_name,
                                    c.name AS category_name, vi.storage_path AS primary_image_url
                             FROM vehicles v
                             JOIN vehicle_models m ON m.id = v.model_id
                             JOIN brands b ON b.id = m.brand_id
                             JOIN categories c ON c.id = m.category_id
                             LEFT JOIN LATERAL (
                               SELECT storage_path FROM vehicle_images
                               WHERE vehicle_id = v.id AND media_type = 'image'
                               ORDER BY is_primary DESC, sort_order ASC
                               LIMIT 1
                             ) vi ON true`,
                        );
                        const vMap = new Map<string, { model_name: string; brand_name: string; category_name: string; primary_image_url?: string }>();
                        for (const v of vehicles) {
                            vMap.set(v.license_plate.toUpperCase(), v);
                        }
                        for (const r of rules) {
                            const match = vMap.get(r.licensePlate.toUpperCase());
                            if (match) {
                                if (!r.brand) r.brand = match.brand_name;
                                if (!r.model) r.model = match.model_name;
                                if (!r.category) r.category = match.category_name;
                                if (!r.imageUrl) r.imageUrl = match.primary_image_url;
                            }
                        }
                    } catch {
                        // Keep raw rules if lookup fails
                    }
                }
                return rules;
            }
        } catch (err) {
            this.logger.warn(`Could not load approved_pricing_rules: ${err instanceof Error ? err.message : String(err)}`);
        }
        return [];
    }

    /**
     * Persist scoped pricing rules to platform_settings
     */
    async saveApprovedPricingRules(rules: ScopedPricingRuleDto[]): Promise<void> {
        await this.dataSource.query(
            `INSERT INTO platform_settings (key, value, category, description, updated_at)
             VALUES ('approved_pricing_rules', $1, 'pricing', 'P7.1 Approved Scoped Pricing Rules', NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [JSON.stringify(rules)],
        );
    }

    /**
     * Authoritatively apply a scoped pricing rule with strict safety bounds
     */
    async applyScopedRule(
        dto: ApplyPricingRecommendationDto,
        recommendationId = 'MANUAL_APPROVAL',
        actorId?: string,
    ): Promise<{
        success: boolean;
        ruleId: string;
        recommendationId: string;
        licensePlate: string;
        oldDailyPrice: number;
        newDailyPrice: number;
        appliedAt: string;
        auditLogId?: string;
    }> {
        const cleanPlate = (dto.licensePlate || '').trim().toUpperCase();
        if (!cleanPlate) {
            throw new BadRequestException('License plate is required to apply recommendation');
        }

        const vehicleRows = await this.dataSource.query(
            `SELECT v.id, v.license_plate, v.daily_price, v.status,
                    m.name AS model_name, b.name AS brand_name,
                    c.name AS category_name, vi.storage_path AS primary_image_url
             FROM vehicles v
             JOIN vehicle_models m ON m.id = v.model_id
             JOIN brands b ON b.id = m.brand_id
             JOIN categories c ON c.id = m.category_id
             LEFT JOIN LATERAL (
               SELECT storage_path FROM vehicle_images
               WHERE vehicle_id = v.id AND media_type = 'image'
               ORDER BY is_primary DESC, sort_order ASC, created_at ASC
               LIMIT 1
             ) vi ON true
             WHERE UPPER(v.license_plate) = $1`,
            [cleanPlate],
        );

        if (!vehicleRows || vehicleRows.length === 0) {
            throw new NotFoundException(`Vehicle with license plate ${cleanPlate} not found`);
        }

        const vehicle = vehicleRows[0];
        const oldPrice = Number(vehicle.daily_price);
        const newPrice = Number(dto.approvedPrice);

        if (newPrice <= 0 || !Number.isFinite(newPrice)) {
            throw new BadRequestException('Approved price must be a positive number');
        }

        // Single-step safety guardrail: variance cannot exceed 50%
        const shiftRatio = Math.abs(newPrice - oldPrice) / oldPrice;
        if (shiftRatio > 0.5) {
            throw new BadRequestException(
                `Approved price variance of ${(shiftRatio * 100).toFixed(
                    1,
                )}% exceeds the maximum allowable single-step safety guardrail (50%).`,
            );
        }

        if (newPrice < 50 || newPrice > 50000) {
            throw new BadRequestException('Approved daily price must be between €50 and €50,000');
        }

        // Update vehicle record if vehiclesService is available
        if (this.vehiclesService) {
            await this.vehiclesService.updateVehicle(cleanPlate, { dailyPrice: newPrice });
        } else {
            await this.dataSource.query(
                `UPDATE vehicles SET daily_price = $1, updated_at = NOW() WHERE id = $2`,
                [newPrice, vehicle.id],
            );
        }

        const nowIso = new Date().toISOString();
        const ruleId = `RULE-${cleanPlate.replace(/[^A-Z0-9]/g, '')}-${Date.now().toString(36).toUpperCase()}`;

        const scopedRule: ScopedPricingRuleDto = {
            ruleId,
            recommendationId,
            vehicleId: vehicle.id,
            licensePlate: cleanPlate,
            brand: vehicle.brand_name || '',
            model: vehicle.model_name || '',
            category: vehicle.category_name || '',
            imageUrl: vehicle.primary_image_url || undefined,
            originalDailyPrice: oldPrice,
            approvedDailyPrice: newPrice,
            variancePercent: Number((((newPrice - oldPrice) / oldPrice) * 100).toFixed(1)),
            startDate: dto.startDate || nowIso.slice(0, 10),
            endDate: dto.endDate,
            adminReason: dto.adminReason?.trim() || 'Smart Pricing Recommendation Approved',
            approvedBy: actorId,
            appliedAt: nowIso,
            status: 'active',
        };

        try {
            const existingRules = await this.getApprovedPricingRules();
            existingRules.unshift(scopedRule);
            await this.saveApprovedPricingRules(existingRules);
        } catch (saveErr) {
            this.logger.warn(`Could not save rule to platform_settings: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
        }

        const auditPayload = {
            ruleId,
            recommendationId,
            oldDailyPrice: oldPrice,
            newDailyPrice: newPrice,
            variancePercent: ((newPrice - oldPrice) / oldPrice) * 100,
            adminReason: dto.adminReason?.trim() || 'Smart Pricing Recommendation Approved',
            approvedAt: nowIso,
            startDate: scopedRule.startDate,
            endDate: scopedRule.endDate,
        };

        let auditLogId: string | undefined;
        try {
            const auditRes = await this.dataSource.query(
                `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values, new_values)
                 VALUES ($1, 'SMART_PRICING_RECOMMENDATION_APPROVED', 'vehicle', $2, $3::jsonb, $4::jsonb)
                 RETURNING id`,
                [
                    actorId ?? null,
                    vehicle.id,
                    JSON.stringify({ daily_price: oldPrice }),
                    JSON.stringify(auditPayload),
                ],
            );
            if (auditRes?.[0]?.id) {
                auditLogId = String(auditRes[0].id);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Failed to insert audit log for price change: ${msg}`);
        }

        return {
            success: true,
            ruleId,
            recommendationId,
            licensePlate: cleanPlate,
            oldDailyPrice: oldPrice,
            newDailyPrice: newPrice,
            appliedAt: nowIso,
            auditLogId,
        };
    }

    /**
     * Authoritatively rollback an active pricing rule
     */
    async rollbackPricingRule(
        ruleId: string,
        reason?: string,
        actorId?: string,
    ): Promise<{ success: boolean; rule: ScopedPricingRuleDto; auditLogId?: string }> {
        const rules = await this.getApprovedPricingRules();
        const rule = rules.find((r) => r.ruleId === ruleId);

        if (!rule) {
            throw new NotFoundException(`Pricing rule ${ruleId} not found`);
        }

        if (rule.status === 'rolled_back') {
            throw new BadRequestException(`Pricing rule ${ruleId} is already rolled back`);
        }

        // Restore original daily price on vehicle
        if (this.vehiclesService) {
            await this.vehiclesService.updateVehicle(rule.licensePlate, {
                dailyPrice: rule.originalDailyPrice,
            });
        } else {
            await this.dataSource.query(
                `UPDATE vehicles SET daily_price = $1, updated_at = NOW() WHERE id = $2`,
                [rule.originalDailyPrice, rule.vehicleId],
            );
        }

        const nowIso = new Date().toISOString();
        rule.status = 'rolled_back';
        rule.rolledBackAt = nowIso;
        rule.rolledBackBy = actorId;
        rule.rollbackReason = reason?.trim() || 'Administrative rollback';

        await this.saveApprovedPricingRules(rules);

        let auditLogId: string | undefined;
        try {
            const auditRes = await this.dataSource.query(
                `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_values, new_values)
                 VALUES ($1, 'SMART_PRICING_RULE_ROLLED_BACK', 'pricing_rule', $2, $3::jsonb, $4::jsonb)
                 RETURNING id`,
                [
                    actorId ?? null,
                    rule.ruleId,
                    JSON.stringify({ dailyPrice: rule.approvedDailyPrice }),
                    JSON.stringify({
                        restoredDailyPrice: rule.originalDailyPrice,
                        rollbackReason: rule.rollbackReason,
                        rolledBackAt: nowIso,
                    }),
                ],
            );
            if (auditRes?.[0]?.id) {
                auditLogId = String(auditRes[0].id);
            }
        } catch (err) {
            this.logger.warn(`Failed to insert audit log for rule rollback: ${err instanceof Error ? err.message : String(err)}`);
        }

        return {
            success: true,
            rule,
            auditLogId,
        };
    }

    /**
     * Format integer cents to EUR decimal string (e.g. 12500 -> "125.00")
     */
    formatCents(cents: number): string {
        return (cents / 100).toFixed(2);
    }

    /**
     * Category Factor: Baseline prestige multiplier based on vehicle class
     * Bounded strictly between 0.95 and 1.15
     */
    getCategoryFactor(categoryName?: string): { factor: number; percentage: number; label: string } {
        const normalized = (categoryName || '').toLowerCase().trim();

        if (normalized.includes('hypercar') || normalized.includes('supercar')) {
            return { factor: 1.10, percentage: 10, label: 'Supercar & Hypercar Tier (+10%)' };
        }
        if (normalized.includes('sport') || normalized.includes('convertible')) {
            return { factor: 1.05, percentage: 5, label: 'High Performance Sport Tier (+5%)' };
        }
        if (normalized.includes('grand tourer') || normalized.includes('suv')) {
            return { factor: 1.05, percentage: 5, label: 'Prestige GT & Luxury SUV Tier (+5%)' };
        }
        if (normalized.includes('electric')) {
            return { factor: 1.02, percentage: 2, label: 'Electric Luxury Tier (+2%)' };
        }

        return { factor: 1.00, percentage: 0, label: 'Standard Luxury Baseline (0%)' };
    }

    /**
     * Seasonal Demand Factor for a specific calendar date:
     * - Summer Peak (Jun 15 – Sep 15): +15%
     * - Holiday Peak (Dec 20 – Jan 5): +20%
     * - Spring/Autumn Shoulder (Apr 1 – Jun 14, Sep 16 – Oct 31): +5%
     * - Winter Low Season (Nov 1 – Dec 19, Jan 6 – Mar 31): -10%
     */
    getSeasonalFactor(date: Date): { factor: number; percentage: number; label: string } {
        const month = date.getUTCMonth() + 1; // 1 to 12
        const day = date.getUTCDate();

        // Holiday Peak: Dec 20 to Jan 5
        if ((month === 12 && day >= 20) || (month === 1 && day <= 5)) {
            return { factor: 1.20, percentage: 20, label: 'Holiday Festive Peak (+20%)' };
        }

        // Summer High: Jun 15 to Sep 15
        if ((month === 6 && day >= 15) || month === 7 || month === 8 || (month === 9 && day <= 15)) {
            return { factor: 1.15, percentage: 15, label: 'Summer High Season (+15%)' };
        }

        // Spring / Autumn Shoulder: Apr 1 - Jun 14 or Sep 16 - Oct 31
        if (month === 4 || month === 5 || (month === 6 && day < 15) || (month === 9 && day > 15) || month === 10) {
            return { factor: 1.05, percentage: 5, label: 'Spring/Autumn Shoulder (+5%)' };
        }

        // Winter Low Season: Nov 1 - Dec 19, Jan 6 - Mar 31
        return { factor: 0.90, percentage: -10, label: 'Winter Value Season (-10%)' };
    }

    /**
     * Weekend & Special Date Factor:
     * - Friday & Saturday nights: +12%
     * - Sunday night: +8%
     * - Weekdays (Mon-Thu): 0%
     */
    getWeekendFactor(date: Date): { factor: number; percentage: number; label: string } {
        const dayOfWeek = date.getUTCDay(); // 0 = Sun, 5 = Fri, 6 = Sat

        if (dayOfWeek === 5 || dayOfWeek === 6) {
            return { factor: 1.12, percentage: 12, label: 'Weekend Prime (Fri/Sat +12%)' };
        }
        if (dayOfWeek === 0) {
            return { factor: 1.08, percentage: 8, label: 'Sunday Prime (+8%)' };
        }

        return { factor: 1.00, percentage: 0, label: 'Weekday Standard (0%)' };
    }

    /**
     * Demand-based adjustments ONLY when supported by reliable data:
     * Queries active bookings in the category. Requires at least 2 active vehicles in category
     * and at least 3 historical/future reservations to avoid speculative surges.
     */
    async getDemandPressureFactor(
        vehicleId: string,
        start: Date,
        end: Date,
        executor: Pick<DataSource, 'query'> = this.dataSource,
    ): Promise<{ factor: number; percentage: number; label: string; reliable: boolean }> {
        try {
            // Find category and fleet size for this vehicle
            const categoryRows = await executor.query(
                `SELECT c.id as category_id, count(v2.id) as category_fleet_size
                 FROM vehicles v
                 JOIN vehicle_models m ON m.id = v.model_id
                 JOIN categories c ON c.id = m.category_id
                 JOIN vehicle_models m2 ON m2.category_id = c.id
                 JOIN vehicles v2 ON v2.model_id = m2.id AND v2.status = 'active'
                 WHERE v.id = $1::uuid
                 GROUP BY c.id`,
                [vehicleId],
            );

            if (!categoryRows || categoryRows.length === 0) {
                return { factor: 1.00, percentage: 0, label: 'Baseline Demand (No category telemetry)', reliable: false };
            }

            const categoryId = categoryRows[0].category_id;
            const fleetSize = parseInt(categoryRows[0].category_fleet_size, 10) || 1;

            // Reliable data threshold: at least 2 vehicles in category fleet
            if (fleetSize < 2) {
                return { factor: 1.00, percentage: 0, label: 'Standard Demand (Insufficient fleet volume for surge)', reliable: false };
            }

            // Count overlapping reservations in this category
            const overlapRows = await executor.query(
                `SELECT count(r.id) as booked_count
                 FROM reservations r
                 JOIN vehicles v ON v.id = r.vehicle_id
                 JOIN vehicle_models m ON m.id = v.model_id
                 WHERE m.category_id = $1::uuid
                   AND r.status IN ('confirmed', 'active_rental', 'awaiting_payment', 'pending')
                   AND r.pickup_at < $3 AND r.return_at > $2`,
                [categoryId, start, end],
            );

            const bookedCount = parseInt(overlapRows[0]?.booked_count || '0', 10);
            const totalHistoricalRows = await executor.query(
                `SELECT count(id) as total_bookings FROM reservations WHERE created_at >= NOW() - INTERVAL '90 days'`,
            );
            const totalBookings = parseInt(totalHistoricalRows[0]?.total_bookings || '0', 10);

            // Require at least 3 bookings in 90-day window for reliable signal
            if (totalBookings < 3) {
                return { factor: 1.00, percentage: 0, label: 'Standard Demand (Insufficient baseline activity)', reliable: false };
            }

            const utilization = bookedCount / fleetSize;

            if (utilization >= 0.90) {
                return { factor: 1.15, percentage: 15, label: 'High Demand Surge (Fleet 90%+ Reserved)', reliable: true };
            }
            if (utilization >= 0.75) {
                return { factor: 1.10, percentage: 10, label: 'Moderate Demand Surge (Fleet 75%+ Reserved)', reliable: true };
            }
            if (utilization <= 0.20 && fleetSize >= 3) {
                return { factor: 0.95, percentage: -5, label: 'Off-Peak Fleet Incentive (-5%)', reliable: true };
            }

            return { factor: 1.00, percentage: 0, label: 'Balanced Fleet Demand (0%)', reliable: true };
        } catch (err: unknown) {
            this.logger.warn(`Demand telemetry calculation bypassed safely: ${err instanceof Error ? err.message : String(err)}`);
            return { factor: 1.00, percentage: 0, label: 'Standard Demand (Telemetry offline)', reliable: false };
        }
    }

    /**
     * Rental Duration Discounts:
     * - 1-2 days: 0%
     * - 3-6 days: 5%
     * - 7-13 days: 10%
     * - 14-29 days: 15%
     * - 30+ days: 20%
     */
    getDurationDiscount(rentalDays: number): { percentage: number; tier: string } {
        if (rentalDays >= 30) {
            return { percentage: 20, tier: 'Monthly Executive Hire (30+ Days: -20%)' };
        }
        if (rentalDays >= 14) {
            return { percentage: 15, tier: 'Fortnightly Grand Hire (14+ Days: -15%)' };
        }
        if (rentalDays >= 7) {
            return { percentage: 10, tier: 'Weekly Privilege Hire (7+ Days: -10%)' };
        }
        if (rentalDays >= 3) {
            return { percentage: 5, tier: 'Extended Weekend Hire (3+ Days: -5%)' };
        }
        return { percentage: 0, tier: 'Standard Duration (1-2 Days)' };
    }

    /**
     * Calculate bounded, deterministic dynamic pricing for a rental booking
     */
    async calculate(input: CalculatePricingInput): Promise<CalculatePricingOutput> {
        const {
            vehicleId,
            baseDailyPriceCents,
            pickupAt,
            returnAt,
            rentalDays,
            categoryName,
            extraTotalCents = 0,
            promotionPercentage = 0,
            executor = this.dataSource,
        } = input;

        let resolvedCategory = categoryName;
        if (!resolvedCategory) {
            try {
                const catRows = await executor.query(
                    `SELECT c.name as category_name
                     FROM vehicles v
                     JOIN vehicle_models m ON m.id = v.model_id
                     JOIN categories c ON c.id = m.category_id
                     WHERE v.id = $1::uuid`,
                    [vehicleId],
                );
                resolvedCategory = catRows[0]?.category_name;
            } catch {
                resolvedCategory = undefined;
            }
        }

        const categoryRule = this.getCategoryFactor(resolvedCategory);
        const demandRule = await this.getDemandPressureFactor(vehicleId, pickupAt, returnAt, executor);

        // Calculate day-by-day rate across calendar interval
        let sumDailyCents = 0;
        let sumSeasonalPct = 0;
        let sumWeekendPct = 0;

        for (let i = 0; i < rentalDays; i++) {
            const currentDay = new Date(pickupAt.getTime() + i * 86400000);
            const seasonal = this.getSeasonalFactor(currentDay);
            const weekend = this.getWeekendFactor(currentDay);

            sumSeasonalPct += seasonal.percentage;
            sumWeekendPct += weekend.percentage;

            // Combined factor for this day
            const rawFactor = categoryRule.factor * seasonal.factor * weekend.factor * demandRule.factor;

            // Strict bound: clamped between 0.75x and 1.45x base rate
            const boundedFactor = Math.min(1.45, Math.max(0.75, rawFactor));
            const dayCents = Math.round(baseDailyPriceCents * boundedFactor);
            sumDailyCents += dayCents;
        }

        // Effective daily price: average per day in integer cents
        const effectiveDailyPriceCents = Math.round(sumDailyCents / rentalDays);

        // Base amount = rentalDays * effectiveDailyPriceCents
        // This guarantees: rentalDays * effectiveDailyPrice == baseAmount
        // perfectly fulfilling PostgreSQL check constraint:
        // total_amount = (rental_days * daily_price + extras + delivery - discount)
        const baseAmountCents = effectiveDailyPriceCents * rentalDays;

        // Duration discount on base hire
        const durationRule = this.getDurationDiscount(rentalDays);
        const durationDiscountCents = durationRule.percentage > 0
            ? Math.round((baseAmountCents * durationRule.percentage) / 100)
            : 0;

        // Promotion discount on base + extras
        const promoDiscountCents = promotionPercentage > 0
            ? Math.round(((baseAmountCents + extraTotalCents) * promotionPercentage) / 100)
            : 0;

        // Total discount: sum of duration discount and promotional code discount
        const totalDiscountCents = Math.min(
            baseAmountCents + extraTotalCents,
            durationDiscountCents + promoDiscountCents,
        );

        // Build list of adjustments for transparency
        const adjustments: DynamicPricingAdjustment[] = [];

        if (categoryRule.percentage !== 0) {
            adjustments.push({
                code: 'CATEGORY_TIER',
                label: categoryRule.label,
                type: 'category',
                percentage: categoryRule.percentage,
                amount: this.formatCents(Math.round(baseAmountCents * (categoryRule.percentage / 100))),
            });
        }

        const avgSeasonalPct = Math.round(sumSeasonalPct / rentalDays);
        if (avgSeasonalPct !== 0) {
            adjustments.push({
                code: 'SEASONAL_DEMAND',
                label: `Seasonal Demand (${avgSeasonalPct > 0 ? '+' : ''}${avgSeasonalPct}%)`,
                type: 'seasonal',
                percentage: avgSeasonalPct,
                amount: this.formatCents(Math.round(baseAmountCents * (avgSeasonalPct / 100))),
            });
        }

        const avgWeekendPct = Math.round(sumWeekendPct / rentalDays);
        if (avgWeekendPct !== 0) {
            adjustments.push({
                code: 'WEEKEND_PRIME',
                label: `Weekend Prime Rate (+${avgWeekendPct}%)`,
                type: 'weekend',
                percentage: avgWeekendPct,
                amount: this.formatCents(Math.round(baseAmountCents * (avgWeekendPct / 100))),
            });
        }

        if (demandRule.percentage !== 0) {
            adjustments.push({
                code: 'FLEET_UTILIZATION',
                label: demandRule.label,
                type: 'demand',
                percentage: demandRule.percentage,
                amount: this.formatCents(Math.round(baseAmountCents * (demandRule.percentage / 100))),
            });
        }

        const grandTotalCents = baseAmountCents + extraTotalCents - totalDiscountCents;
        // VAT 20% included in luxury total: amount = grandTotal * 20 / 120
        const vatCents = Math.round((grandTotalCents * 20) / 120);

        const breakdown: DynamicPricingBreakdown = {
            enabled: true,
            baseDailyRate: this.formatCents(baseDailyPriceCents),
            effectiveDailyRate: this.formatCents(effectiveDailyPriceCents),
            averageFactor: Number((effectiveDailyPriceCents / baseDailyPriceCents).toFixed(3)),
            adjustments,
            durationDiscount: durationRule.percentage > 0 ? {
                tier: durationRule.tier,
                percentage: durationRule.percentage,
                amount: this.formatCents(durationDiscountCents),
            } : null,
            taxes: {
                rate: 20,
                name: 'VAT (20% inclusive)',
                includedInTotal: true,
                amount: this.formatCents(vatCents),
            },
        };

        return {
            effectiveDailyPriceCents,
            baseAmountCents,
            discountAmountCents: totalDiscountCents,
            durationDiscountCents,
            promotionDiscountCents: promoDiscountCents,
            breakdown,
        };
    }
}
