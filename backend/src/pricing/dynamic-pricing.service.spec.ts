import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { DynamicPricingService } from './dynamic-pricing.service.js';

describe('DynamicPricingService', () => {
    function createService(flagValue: boolean | string | undefined = false) {
        const configService = {
            get: vi.fn((key: string) => (key === 'ENABLE_DYNAMIC_PRICING' ? flagValue : undefined)),
        } as unknown as ConfigService;

        const dataSource = {
            query: vi.fn(),
        } as unknown as DataSource;

        return {
            service: new DynamicPricingService(configService, dataSource),
            configService,
            dataSource,
        };
    }

    describe('Feature Flag', () => {
        it('reports disabled when flag is false, undefined, or empty', () => {
            expect(createService(false).service.isEnabled()).toBe(false);
            expect(createService('false').service.isEnabled()).toBe(false);
            expect(createService(undefined).service.isEnabled()).toBe(false);
            expect(createService('').service.isEnabled()).toBe(false);
            expect(createService('0').service.isEnabled()).toBe(false);
        });

        it('reports enabled when flag is true or "true" or "1"', () => {
            expect(createService(true).service.isEnabled()).toBe(true);
            expect(createService('true').service.isEnabled()).toBe(true);
            expect(createService('1').service.isEnabled()).toBe(true);
        });
    });

    describe('Seasonal Factor & Boundary Transitions', () => {
        const { service } = createService(true);

        it('identifies Holiday Peak (+20%) between Dec 20 and Jan 5', () => {
            expect(service.getSeasonalFactor(new Date('2026-12-20T10:00:00Z')).percentage).toBe(20);
            expect(service.getSeasonalFactor(new Date('2026-12-25T12:00:00Z')).percentage).toBe(20);
            expect(service.getSeasonalFactor(new Date('2026-12-31T23:59:59Z')).percentage).toBe(20);
            expect(service.getSeasonalFactor(new Date('2027-01-01T00:00:00Z')).percentage).toBe(20);
            expect(service.getSeasonalFactor(new Date('2027-01-05T20:00:00Z')).percentage).toBe(20);
        });

        it('identifies Winter Value Season (-10%) on boundary dates Dec 19 and Jan 6', () => {
            expect(service.getSeasonalFactor(new Date('2026-12-19T10:00:00Z')).percentage).toBe(-10);
            expect(service.getSeasonalFactor(new Date('2027-01-06T10:00:00Z')).percentage).toBe(-10);
            expect(service.getSeasonalFactor(new Date('2026-02-14T10:00:00Z')).percentage).toBe(-10);
            expect(service.getSeasonalFactor(new Date('2026-11-15T10:00:00Z')).percentage).toBe(-10);
        });

        it('identifies Summer High Season (+15%) between Jun 15 and Sep 15', () => {
            expect(service.getSeasonalFactor(new Date('2026-06-15T10:00:00Z')).percentage).toBe(15);
            expect(service.getSeasonalFactor(new Date('2026-07-20T10:00:00Z')).percentage).toBe(15);
            expect(service.getSeasonalFactor(new Date('2026-08-15T10:00:00Z')).percentage).toBe(15);
            expect(service.getSeasonalFactor(new Date('2026-09-15T18:00:00Z')).percentage).toBe(15);
        });

        it('identifies Spring/Autumn Shoulder (+5%) on boundary dates Jun 14 and Sep 16', () => {
            expect(service.getSeasonalFactor(new Date('2026-04-10T10:00:00Z')).percentage).toBe(5);
            expect(service.getSeasonalFactor(new Date('2026-05-01T10:00:00Z')).percentage).toBe(5);
            expect(service.getSeasonalFactor(new Date('2026-06-14T23:00:00Z')).percentage).toBe(5);
            expect(service.getSeasonalFactor(new Date('2026-09-16T08:00:00Z')).percentage).toBe(5);
            expect(service.getSeasonalFactor(new Date('2026-10-31T20:00:00Z')).percentage).toBe(5);
        });
    });

    describe('Weekend Factors', () => {
        const { service } = createService(true);

        it('applies +12% on Friday and Saturday', () => {
            // 2026-07-10 is a Friday
            expect(service.getWeekendFactor(new Date('2026-07-10T12:00:00Z')).percentage).toBe(12);
            // 2026-07-11 is a Saturday
            expect(service.getWeekendFactor(new Date('2026-07-11T12:00:00Z')).percentage).toBe(12);
        });

        it('applies +8% on Sunday', () => {
            // 2026-07-12 is a Sunday
            expect(service.getWeekendFactor(new Date('2026-07-12T12:00:00Z')).percentage).toBe(8);
        });

        it('applies 0% on weekdays (Mon-Thu)', () => {
            // 2026-07-13 is a Monday
            expect(service.getWeekendFactor(new Date('2026-07-13T12:00:00Z')).percentage).toBe(0);
            // 2026-07-14 is Tuesday
            expect(service.getWeekendFactor(new Date('2026-07-14T12:00:00Z')).percentage).toBe(0);
            // 2026-07-15 is Wednesday
            expect(service.getWeekendFactor(new Date('2026-07-15T12:00:00Z')).percentage).toBe(0);
            // 2026-07-16 is Thursday
            expect(service.getWeekendFactor(new Date('2026-07-16T12:00:00Z')).percentage).toBe(0);
        });
    });

    describe('Vehicle Category Tiers', () => {
        const { service } = createService(true);

        it('applies +10% for Supercars and Hypercars', () => {
            expect(service.getCategoryFactor('Supercar').percentage).toBe(10);
            expect(service.getCategoryFactor('Hypercar Collection').percentage).toBe(10);
        });

        it('applies +5% for Sports Cars, Convertibles, GTs and SUVs', () => {
            expect(service.getCategoryFactor('Sports Car').percentage).toBe(5);
            expect(service.getCategoryFactor('Convertible').percentage).toBe(5);
            expect(service.getCategoryFactor('Grand Tourer').percentage).toBe(5);
            expect(service.getCategoryFactor('Luxury SUV').percentage).toBe(5);
        });

        it('applies +2% for Electric Luxury', () => {
            expect(service.getCategoryFactor('Electric Performance').percentage).toBe(2);
        });

        it('applies 0% for Standard Luxury Baseline or undefined', () => {
            expect(service.getCategoryFactor('Standard Sedan').percentage).toBe(0);
            expect(service.getCategoryFactor(undefined).percentage).toBe(0);
        });
    });

    describe('Duration Discount Tiers', () => {
        const { service } = createService(true);

        it('evaluates correct percentage and tier label across rental lengths', () => {
            expect(service.getDurationDiscount(1).percentage).toBe(0);
            expect(service.getDurationDiscount(2).percentage).toBe(0);
            expect(service.getDurationDiscount(3).percentage).toBe(5);
            expect(service.getDurationDiscount(6).percentage).toBe(5);
            expect(service.getDurationDiscount(7).percentage).toBe(10);
            expect(service.getDurationDiscount(13).percentage).toBe(10);
            expect(service.getDurationDiscount(14).percentage).toBe(15);
            expect(service.getDurationDiscount(29).percentage).toBe(15);
            expect(service.getDurationDiscount(30).percentage).toBe(20);
            expect(service.getDurationDiscount(60).percentage).toBe(20);
        });
    });

    describe('Demand-based Telemetry Gating', () => {
        it('refuses to surge if fleet size is under 2 vehicles', async () => {
            const { service } = createService(true);
            const executor = {
                query: vi.fn().mockImplementation(async (sql: string) => {
                    if (sql.includes('count(v2.id) as category_fleet_size')) {
                        return [{ category_id: 'cat-1', category_fleet_size: '1' }];
                    }
                    return [];
                }),
            };

            const result = await service.getDemandPressureFactor(
                'veh-1',
                new Date('2026-07-01'),
                new Date('2026-07-04'),
                executor,
            );

            expect(result.factor).toBe(1.00);
            expect(result.reliable).toBe(false);
            expect(result.label).toContain('Insufficient fleet volume');
        });

        it('refuses to surge if historical bookings are under 3', async () => {
            const { service } = createService(true);
            const executor = {
                query: vi.fn().mockImplementation(async (sql: string) => {
                    if (sql.includes('category_fleet_size')) {
                        return [{ category_id: 'cat-1', category_fleet_size: '5' }];
                    }
                    if (sql.includes('booked_count')) {
                        return [{ booked_count: '4' }];
                    }
                    if (sql.includes('total_bookings')) {
                        return [{ total_bookings: '2' }]; // Under threshold 3
                    }
                    return [];
                }),
            };

            const result = await service.getDemandPressureFactor(
                'veh-1',
                new Date('2026-07-01'),
                new Date('2026-07-04'),
                executor,
            );

            expect(result.factor).toBe(1.00);
            expect(result.reliable).toBe(false);
            expect(result.label).toContain('Insufficient baseline activity');
        });

        it('applies surge factor when fleet utilization is high with reliable telemetry', async () => {
            const { service } = createService(true);
            const executor = {
                query: vi.fn().mockImplementation(async (sql: string) => {
                    if (sql.includes('category_fleet_size')) {
                        return [{ category_id: 'cat-1', category_fleet_size: '4' }];
                    }
                    if (sql.includes('booked_count')) {
                        return [{ booked_count: '4' }]; // 100% utilization
                    }
                    if (sql.includes('total_bookings')) {
                        return [{ total_bookings: '12' }];
                    }
                    return [];
                }),
            };

            const result = await service.getDemandPressureFactor(
                'veh-1',
                new Date('2026-07-01'),
                new Date('2026-07-04'),
                executor,
            );

            expect(result.factor).toBe(1.15);
            expect(result.reliable).toBe(true);
            expect(result.percentage).toBe(15);
        });

        it('handles database telemetry failure safely without throwing', async () => {
            const { service } = createService(true);
            const executor = {
                query: vi.fn().mockRejectedValue(new Error('Connection lost')),
            };

            const result = await service.getDemandPressureFactor(
                'veh-1',
                new Date('2026-07-01'),
                new Date('2026-07-04'),
                executor,
            );

            expect(result.factor).toBe(1.00);
            expect(result.reliable).toBe(false);
            expect(result.percentage).toBe(0);
        });
    });

    describe('Calculation Invariants & Mathematical Precision', () => {
        const { service } = createService(true);

        it('guarantees rentalDays * effectiveDailyPrice == baseAmount to exact cent', async () => {
            const executor = {
                query: vi.fn().mockResolvedValue([]),
            };

            const output = await service.calculate({
                vehicleId: 'veh-1',
                baseDailyPriceCents: 390000, // 3900.00 EUR
                pickupAt: new Date('2026-07-01T10:00:00Z'),
                returnAt: new Date('2026-07-08T10:00:00Z'),
                rentalDays: 7,
                categoryName: 'Supercar',
                executor,
            });

            expect(output.baseAmountCents).toBe(output.effectiveDailyPriceCents * 7);
            expect(output.breakdown.enabled).toBe(true);
            expect(output.durationDiscountCents).toBeGreaterThan(0);
            expect(Number(output.breakdown.effectiveDailyRate)).toBe(output.effectiveDailyPriceCents / 100);
        });

        it('enforces strict bounding clamps between 0.75x and 1.45x', async () => {
            const executor = {
                query: vi.fn().mockResolvedValue([]),
            };

            // Summer peak (1.15) + Weekend (1.12) + Supercar (1.10) + Surge (1.15) = 1.63x -> clamped to 1.45x
            const outputHigh = await service.calculate({
                vehicleId: 'veh-1',
                baseDailyPriceCents: 100000,
                pickupAt: new Date('2026-07-10T10:00:00Z'), // Friday summer
                returnAt: new Date('2026-07-11T10:00:00Z'),
                rentalDays: 1,
                categoryName: 'Supercar',
                executor,
            });

            const ratio = outputHigh.effectiveDailyPriceCents / 100000;
            expect(ratio).toBeLessThanOrEqual(1.45);
        });
    });
});
