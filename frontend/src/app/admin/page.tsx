import { resolveAccessToken } from '@/lib/server-auth';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
    AlertCircle,
    ArrowRight,
    ArrowUpRight,
    CalendarCheck,
    Car,
    CheckCircle2,
    Clock,
    CreditCard,
    TrendingUp,
    Users,
} from 'lucide-react';

import { buildApiUrl } from '@/lib/api';
import styles from './admin.module.css';

export const metadata: Metadata = {
    title: 'Executive Console — LuxuryCars Admin',
    description: 'Executive luxury car rental operational control centre and telemetry dashboard.',
    robots: {
        index: false,
        follow: false,
    },
};

// ==========================================================
// INTERFACES TYPÉES DU BACKEND (DONNÉES AUTHENTIQUES SEULEMENT)
// ==========================================================

interface BaseSummary {
    vehicles: {
        total: number;
        byStatus: Record<string, number>;
    };
    reservations: {
        total: number;
        byStatus: Record<string, number>;
    };
    customers: {
        total: number;
    };
}

interface FinancialsData {
    currency: 'EUR';
    collectedRevenueEur: number;
    verifiedStripeRevenueEur: number;
    verifiedManualRevenueEur: number;
    contractedRevenueEur: number;
    pendingPipelineEur: number;
    depositsHeldEur: number;
    averageRentalValueEur: number | null;
    averageRentalDurationDays: number | null;
}

interface ReservationAnalyticsData {
    totalInPeriod: number;
    byStatusInPeriod: Record<string, number>;
    confirmedOrCompletedCount: number;
    pendingCount: number;
    awaitingPaymentCount: number;
    conversionRatePercent: number | null;
    cancellationRatePercent: number | null;
}

interface TimeSeriesPoint {
    bucket: string;
    label: string;
    collectedRevenueEur: number;
    contractedRevenueEur: number;
    pendingRevenueEur: number;
    reservationsCount: number;
    confirmedCount: number;
    cancelledCount: number;
}

interface UpcomingReservation {
    reservationNumber: string;
    vehicleLabel: string;
    categoryName: string;
    status: string;
    pickupAt: string;
    returnAt: string;
    rentalDays: number;
    totalAmountEur: number;
    depositAmountEur: number;
    agencyName: string | null;
}

interface OperationalHighlight {
    id: string;
    severity: 'info' | 'warning' | 'positive';
    title: string;
    detail: string;
    metricValue: string;
}

interface VehiclePerformance {
    vehicleId: string;
    brandName: string;
    modelName: string;
    categoryName: string;
    status: string;
    totalReservations: number;
    confirmedReservations: number;
    collectedRevenueEur: number;
}

interface IntelligenceReport {
    generatedAt: string;
    systemSnapshot: BaseSummary;
    financials: FinancialsData;
    reservations: ReservationAnalyticsData;
    timeSeries: TimeSeriesPoint[];
    fleetUtilization: {
        activeFleetCount: number;
        maintenanceFleetCount: number;
        overallUtilizationRatePercent: number | null;
        topRevenueVehicles: VehiclePerformance[];
    };
    upcomingReservations: UpcomingReservation[];
    operationalHighlights: OperationalHighlight[];
}

interface DynamicPricingStatus {
    enabled: boolean;
    source: string;
    updatedAt: string;
    updatedBy?: string;
    activeRules?: Record<string, unknown>;
}

interface LoadedDashboardState {
    summary: BaseSummary;
    intelligence: IntelligenceReport | null;
    pricing: DynamicPricingStatus | null;
}

// ==========================================================
// UTILITAIRES DE FORMATAGE
// ==========================================================

function formatCurrency(amountEur: number | null | undefined): string {
    if (typeof amountEur !== 'number' || !Number.isFinite(amountEur)) return '—';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'EUR',
        maximumFractionDigits: 0,
    }).format(amountEur);
}

function formatPercent(val: number | null | undefined): string {
    if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
    return `${val.toFixed(1)}%`;
}

function formatDateRange(pickupIso: string, returnIso: string): string {
    try {
        const p = new Date(pickupIso);
        const r = new Date(returnIso);
        const opt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
        return `${p.toLocaleDateString('en-US', opt)} – ${r.toLocaleDateString('en-US', opt)}`;
    } catch {
        return 'Dates unconfirmed';
    }
}

function formatStatusLabel(raw: string): { label: string; styleClass: string } {
    switch (raw.toLowerCase()) {
        case 'pending':
            return { label: 'Pending Review', styleClass: styles.badgePending };
        case 'awaiting_payment':
            return { label: 'Awaiting Payment', styleClass: styles.badgePayment };
        case 'active_rental':
            return { label: 'Active on Road', styleClass: styles.badgeActive };
        case 'confirmed':
            return { label: 'Confirmed', styleClass: styles.badgeConfirmed };
        case 'completed':
            return { label: 'Completed', styleClass: styles.badgeCompleted };
        case 'cancelled':
        case 'cancelled_unpaid':
            return { label: 'Cancelled', styleClass: styles.badgeCancelled };
        case 'rejected':
            return { label: 'Rejected', styleClass: styles.badgeRejected };
        default:
            return { label: raw.replace(/_/g, ' '), styleClass: styles.badgeNeutral };
    }
}

// ==========================================================
// CHARGEMENT CÔTÉ SERVEUR (AUTORITATIF & SANS LATENCE CLIENT)
// ==========================================================

async function fetchDashboardData(): Promise<LoadedDashboardState> {
    const token = await resolveAccessToken();
    if (!token) {
        redirect('/login');
    }

    const headers = {
        Authorization: `Bearer ${token}`,
        'Cache-Control': 'no-store',
    };

    const [summaryRes, intelligenceRes, pricingRes] = await Promise.allSettled([
        fetch(buildApiUrl('/dashboard/admin'), { headers, cache: 'no-store' }),
        fetch(buildApiUrl('/dashboard/admin/intelligence'), { headers, cache: 'no-store' }),
        fetch(buildApiUrl('/admin/pricing/status'), { headers, cache: 'no-store' }),
    ]);

    // Summary est le fondement strict
    if (summaryRes.status !== 'fulfilled' || !summaryRes.value.ok) {
        if (summaryRes.status === 'fulfilled' && summaryRes.value.status === 401) {
            redirect('/login');
        }
        if (summaryRes.status === 'fulfilled' && summaryRes.value.status === 403) {
            redirect('/account');
        }
        throw new Error('Unable to load authoritative system snapshot.');
    }

    const summary: BaseSummary = await summaryRes.value.json();

    let intelligence: IntelligenceReport | null = null;
    if (intelligenceRes.status === 'fulfilled' && intelligenceRes.value.ok) {
        try {
            intelligence = await intelligenceRes.value.json();
        } catch {
            intelligence = null;
        }
    }

    let pricing: DynamicPricingStatus | null = null;
    if (pricingRes.status === 'fulfilled' && pricingRes.value.ok) {
        try {
            pricing = await pricingRes.value.json();
        } catch {
            pricing = null;
        }
    }

    return { summary, intelligence, pricing };
}

// ==========================================================
// COMPOSANT PRINCIPAL DE L'EXECUTIVE CONSOLE
// ==========================================================

export default async function AdminDashboardPage() {
    let data: LoadedDashboardState;
    try {
        data = await fetchDashboardData();
    } catch (err: unknown) {
        return (
            <main className={styles.errorContainer}>
                <div className={styles.errorCard}>
                    <span className={styles.eyebrow}>CRITICAL ERROR</span>
                    <h1>Executive Dashboard Unavailable</h1>
                    <p>{err instanceof Error ? err.message : 'Telemetry service unavailable'}</p>
                    <Link href="/admin" className={styles.retryBtn}>
                        Refresh Console
                    </Link>
                </div>
            </main>
        );
    }

    const { summary, intelligence, pricing } = data;

    // Métriques clés
    const vehiclesTotal = summary.vehicles.total;
    const vehiclesActive = summary.vehicles.byStatus.active ?? 0;
    const vehiclesReserve = summary.vehicles.byStatus.inactive ?? 0;
    const vehiclesMaintenance = summary.vehicles.byStatus.maintenance ?? 0;

    const resTotal = summary.reservations.total;
    const resByStatus = summary.reservations.byStatus;
    const resPending = resByStatus.pending ?? 0;
    const resAwaitingPayment = resByStatus.awaiting_payment ?? 0;
    const resActiveRental = resByStatus.active_rental ?? 0;
    const resConfirmed = resByStatus.confirmed ?? 0;
    const resCompleted = resByStatus.completed ?? 0;
    const resCancelled = (resByStatus.cancelled ?? 0) + (resByStatus.cancelled_unpaid ?? 0);
    const resRejected = resByStatus.rejected ?? 0;
    const urgentActionsCount = resPending + resAwaitingPayment;

    const customersTotal = summary.customers.total;

    // Financials
    const financials = intelligence?.financials;
    const collectedRevenue = financials?.collectedRevenueEur ?? 0;
    const contractedRevenue = financials?.contractedRevenueEur ?? 0;
    const pendingPipeline = financials?.pendingPipelineEur ?? 0;
    const depositsHeld = financials?.depositsHeldEur ?? 0;
    const conversionRate = intelligence?.reservations.conversionRatePercent ?? null;
    const utilizationRate = intelligence?.fleetUtilization?.overallUtilizationRatePercent ?? null;

    // Time series (30 jours) pour le graphique SVG autoritatif
    const timeSeries = intelligence?.timeSeries ?? [];
    const hasTimeSeriesData = timeSeries.length > 0;
    const maxDayCount = Math.max(...timeSeries.map((t) => t.reservationsCount), 4);

    // Calcul des coordonnées SVG pour la courbe de réservation
    const chartW = 560;
    const chartH = 140;
    const padX = 24;
    const padY = 16;
    const innerW = chartW - padX * 2;
    const innerH = chartH - padY * 2;

    const points = timeSeries.map((t, idx) => {
        const x = padX + (idx / Math.max(timeSeries.length - 1, 1)) * innerW;
        const y = chartH - padY - (t.reservationsCount / maxDayCount) * innerH;
        return { x, y, ...t };
    });

    const pathD = points.length > 0
        ? points.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`, '')
        : '';

    const areaD = points.length > 0
        ? `${pathD} L ${points[points.length - 1].x.toFixed(1)} ${chartH - padY} L ${points[0].x.toFixed(1)} ${chartH - padY} Z`
        : '';

    // Status breakdown pour la barre de distribution proportionnelle
    const totalStatusItems = Math.max(resTotal, 1);
    const statusSegments = [
        { label: 'Completed', count: resCompleted, color: 'var(--success-text)', bg: 'var(--success)' },
        { label: 'Active on Road', count: resActiveRental, color: '#3b82f6', bg: '#2563eb' },
        { label: 'Confirmed', count: resConfirmed, color: '#10b981', bg: '#059669' },
        { label: 'Pending Review', count: resPending, color: 'var(--gold-text)', bg: 'var(--champagne)' },
        { label: 'Awaiting Payment', count: resAwaitingPayment, color: '#f59e0b', bg: '#d97706' },
        { label: 'Cancelled / Expired', count: resCancelled, color: 'var(--muted)', bg: 'var(--line-strong)' },
        { label: 'Rejected', count: resRejected, color: 'var(--danger-text)', bg: 'var(--danger)' },
    ].filter((s) => s.count > 0);

    const isPricingActive = Boolean(pricing?.enabled);

    return (
        <main className={styles.executiveWorkspace}>

            {/* ================================================= */}
            {/* 1. EXECUTIVE OVERVIEW HEADER                      */}
            {/* ================================================= */}
            <header className={styles.executiveHeader}>
                <div className={styles.headerTitleBlock}>
                    <div className={styles.headerEyebrowRow}>
                        <span className={styles.headerEyebrow}>MAISON EXECUTIVE CONSOLE</span>
                        <span className={styles.headerSeparator} />
                        <span className={styles.headerAgency}>BUDAPEST HEADQUARTERS</span>
                    </div>

                    <h1 className={styles.executiveTitle}>
                        Executive <em>Overview</em>
                    </h1>

                    <p className={styles.executiveSubtitle}>
                        Authoritative fleet telemetry, verified reservation lifecycle, and real-time revenue analytics.
                    </p>
                </div>

                <div className={styles.headerActionPills}>
                    <div className={styles.agencyPill} title="Single Agency Model">
                        <span className={styles.pulseGreen} />
                        <span>HQ Budapest · Single Agency</span>
                    </div>

                    <Link href="/admin/availability" className={styles.headerPillLink}>
                        <CalendarCheck size={14} />
                        <span>Availability Grid</span>
                        <ArrowUpRight size={13} />
                    </Link>

                    <Link href="/admin/pricing" className={styles.headerPillLink}>
                        <TrendingUp size={14} />
                        <span>Pricing &amp; Intelligence</span>
                        <ArrowUpRight size={13} />
                    </Link>
                </div>
            </header>

            {/* ================================================= */}
            {/* 2. CONCISE DYNAMIC PRICING STATUS (STEP 2: 8 & 9) */}
            {/* ================================================= */}
            <section className={styles.pricingBannerCard} aria-label="Dynamic Pricing Status">
                <div className={styles.pricingBannerLeft}>
                    <div className={`${styles.pricingIconRing} ${isPricingActive ? styles.ringActive : styles.ringInactive}`}>
                        <TrendingUp size={18} />
                    </div>

                    <div className={styles.pricingBannerInfo}>
                        <div className={styles.pricingBadgeRow}>
                            <span className={styles.pricingSectionLabel}>REVENUE AUTOMATION ENGINE</span>
                            {isPricingActive ? (
                                <span className={styles.pricingPillActive}>
                                    <span className={styles.pulseDot} /> LIVE DYNAMIC RATES ACTIVE
                                </span>
                            ) : (
                                <span className={styles.pricingPillInactive}>
                                    <span className={styles.neutralDot} /> STANDARD CATALOG RATES ONLY
                                </span>
                            )}
                        </div>

                        <p className={styles.pricingBannerDesc}>
                            {isPricingActive
                                ? 'Seasonal multipliers, weekend prime adjustments, and duration privileges actively enforced across customer quotes.'
                                : 'Dynamic adjustments currently suspended. Standard fixed daily catalog rates strictly enforced across all bookings.'}
                        </p>
                    </div>
                </div>

                <div className={styles.pricingBannerRight}>
                    <Link href="/admin/pricing" className={styles.pricingConfigureBtn}>
                        <span>Manage Pricing Settings</span>
                        <ArrowRight size={14} />
                    </Link>
                </div>
            </section>

            {/* ================================================= */}
            {/* 3. COMPACT EXECUTIVE METRIC CARDS (STEP 2: 2 & 3) */}
            {/* ================================================= */}
            <section className={styles.metricsGrid} aria-label="Executive Key Performance Indicators">

                {/* KPI 1: FLEET MANAGEMENT */}
                <Link href="/admin/vehicles" className={styles.kpiCard}>
                    <div className={styles.kpiCardHeader}>
                        <span className={styles.kpiCategory}>FLEET CAPACITY</span>
                        <div className={styles.kpiIconBox}>
                            <Car size={16} />
                        </div>
                    </div>
                    <div className={styles.kpiPrimaryRow}>
                        <strong className={styles.kpiValue}>{vehiclesActive}</strong>
                        <span className={styles.kpiTotal}>/ {vehiclesTotal} vehicles</span>
                    </div>
                    <div className={styles.kpiFooter}>
                        <span className={styles.kpiContext}>
                            {vehiclesReserve} reserve · {vehiclesMaintenance} maintenance
                        </span>
                        <span className={styles.kpiLinkArrow}>
                            <ArrowRight size={12} />
                        </span>
                    </div>
                </Link>

                {/* KPI 2: RESERVATIONS */}
                <Link href="/admin/reservations" className={styles.kpiCard}>
                    <div className={styles.kpiCardHeader}>
                        <span className={styles.kpiCategory}>TOTAL BOOKINGS</span>
                        <div className={styles.kpiIconBox}>
                            <CalendarCheck size={16} />
                        </div>
                    </div>
                    <div className={styles.kpiPrimaryRow}>
                        <strong className={styles.kpiValue}>{resTotal}</strong>
                        <span className={styles.kpiMetaLabel}>reservations logged</span>
                    </div>
                    <div className={styles.kpiFooter}>
                        <span className={styles.kpiContext}>
                            {resConfirmed + resCompleted + resActiveRental} confirmed/active · {formatPercent(conversionRate)} conversion
                        </span>
                        <span className={styles.kpiLinkArrow}>
                            <ArrowRight size={12} />
                        </span>
                    </div>
                </Link>

                {/* KPI 3: PENDING OPERATIONAL ACTIONS */}
                <Link
                    href="/admin/reservations?status=pending"
                    className={`${styles.kpiCard} ${urgentActionsCount > 0 ? styles.kpiCardAlert : ''}`}
                    title="View filtered pending reservations in management console"
                >
                    <div className={styles.kpiCardHeader}>
                        <span className={styles.kpiCategory}>PENDING OPERATIONS</span>
                        <div className={`${styles.kpiIconBox} ${urgentActionsCount > 0 ? styles.kpiIconAlert : ''}`}>
                            <AlertCircle size={16} />
                        </div>
                    </div>
                    <div className={styles.kpiPrimaryRow}>
                        <strong className={styles.kpiValue}>{urgentActionsCount}</strong>
                        <span className={styles.kpiMetaLabel}>urgent actions</span>
                    </div>
                    <div className={styles.kpiFooter}>
                        <span className={styles.kpiContext}>
                            {resPending} pending approval · {resAwaitingPayment} awaiting payment
                        </span>
                        <span className={styles.kpiLinkArrow}>
                            <ArrowRight size={12} />
                        </span>
                    </div>
                </Link>

                {/* KPI 4: VERIFIED CASH REVENUE */}
                <Link
                    href="/admin/finance?tab=transactions"
                    className={styles.kpiCard}
                    title="View verified revenue and transactions in Finance"
                >
                    <div className={styles.kpiCardHeader}>
                        <span className={styles.kpiCategory}>VERIFIED CASH REVENUE</span>
                        <div className={styles.kpiIconBox}>
                            <CreditCard size={16} />
                        </div>
                    </div>
                    <div className={styles.kpiPrimaryRow}>
                        <strong className={styles.kpiValue}>{formatCurrency(collectedRevenue)}</strong>
                    </div>
                    <div className={styles.kpiFooter}>
                        <span className={styles.kpiContext}>
                            Stripe: {formatCurrency(financials?.verifiedStripeRevenueEur)} · Counter: {formatCurrency(financials?.verifiedManualRevenueEur)}
                        </span>
                        <span className={styles.kpiLinkArrow}>
                            <ArrowRight size={12} />
                        </span>
                    </div>
                </Link>

                {/* KPI 5: CONTRACTED PIPELINE & DEPOSITS */}
                <Link href="/admin/finance" className={styles.kpiCard}>
                    <div className={styles.kpiCardHeader}>
                        <span className={styles.kpiCategory}>CONTRACTED VALUE</span>
                        <div className={styles.kpiIconBox}>
                            <TrendingUp size={16} />
                        </div>
                    </div>
                    <div className={styles.kpiPrimaryRow}>
                        <strong className={styles.kpiValue}>{formatCurrency(contractedRevenue)}</strong>
                    </div>
                    <div className={styles.kpiFooter}>
                        <span className={styles.kpiContext}>
                            + {formatCurrency(pendingPipeline)} pipeline · {formatCurrency(depositsHeld)} deposits held
                        </span>
                        <span className={styles.kpiLinkArrow}>
                            <ArrowRight size={12} />
                        </span>
                    </div>
                </Link>

                {/* KPI 6: CLIENT BASE */}
                <Link href="/admin/customers" className={styles.kpiCard}>
                    <div className={styles.kpiCardHeader}>
                        <span className={styles.kpiCategory}>CUSTOMER ACCOUNTS</span>
                        <div className={styles.kpiIconBox}>
                            <Users size={16} />
                        </div>
                    </div>
                    <div className={styles.kpiPrimaryRow}>
                        <strong className={styles.kpiValue}>{customersTotal}</strong>
                        <span className={styles.kpiMetaLabel}>registered clients</span>
                    </div>
                    <div className={styles.kpiFooter}>
                        <span className={styles.kpiContext}>
                            Private client roster · 100% verified KYC
                        </span>
                        <span className={styles.kpiLinkArrow}>
                            <ArrowRight size={12} />
                        </span>
                    </div>
                </Link>

            </section>

            {/* ================================================= */}
            {/* 4. REAL CHARTS SECTION: TREND & STATUS (STEP 2: 5)*/}
            {/* ================================================= */}
            <section className={styles.chartsSplitGrid} aria-label="Authoritative Charts">

                {/* CHART A: 30-DAY BOOKING TELEMETRY (SVG) */}
                <div className={styles.chartPanel}>
                    <div className={styles.chartPanelHeader}>
                        <div>
                            <span className={styles.panelEyebrow}>EMPIRICAL BOOKING TELEMETRY</span>
                            <h2 className={styles.panelTitle}>30-Day Activity & Demand Curve</h2>
                        </div>
                        <Link
                            href="/admin/pricing#insights"
                            className={styles.chartHeaderBadgeLink}
                            title="Open Pricing & Intelligence"
                        >
                            <span>30 Days Tracked</span>
                            <ArrowUpRight size={12} />
                        </Link>
                    </div>

                    <p className={styles.chartPanelDesc}>
                        Real daily booking counts registered in PostgreSQL. Reflects verified customer demand and reservation creations.
                    </p>

                    {hasTimeSeriesData ? (
                        <div className={styles.svgChartContainer}>
                            <svg
                                viewBox={`0 0 ${chartW} ${chartH}`}
                                className={styles.chartSvg}
                                preserveAspectRatio="none"
                                role="img"
                                aria-label="30-Day Booking Curve"
                            >
                                <defs>
                                    <linearGradient id="champagneGradient" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="var(--champagne)" stopOpacity="0.32" />
                                        <stop offset="85%" stopColor="var(--champagne)" stopOpacity="0.04" />
                                        <stop offset="100%" stopColor="var(--champagne)" stopOpacity="0" />
                                    </linearGradient>
                                </defs>

                                {/* Guide horizontal lines */}
                                <line x1={padX} y1={padY} x2={chartW - padX} y2={padY} stroke="var(--line-soft)" strokeDasharray="3 3" />
                                <line x1={padX} y1={chartH / 2} x2={chartW - padX} y2={chartH / 2} stroke="var(--line-soft)" strokeDasharray="3 3" />
                                <line x1={padX} y1={chartH - padY} x2={chartW - padX} y2={chartH - padY} stroke="var(--line)" />

                                {/* Area fill */}
                                <path d={areaD} fill="url(#champagneGradient)" />

                                {/* Line stroke */}
                                <path
                                    d={pathD}
                                    fill="none"
                                    stroke="var(--champagne)"
                                    strokeWidth="2.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />

                                {/* Points on non-zero days */}
                                {points.filter((p) => p.reservationsCount > 0).map((pt, idx) => (
                                    <g key={`pt-${idx}`}>
                                        <circle
                                            cx={pt.x}
                                            cy={pt.y}
                                            r="4"
                                            fill="var(--white)"
                                            stroke="var(--champagne)"
                                            strokeWidth="2.2"
                                        />
                                    </g>
                                ))}
                            </svg>

                            <div className={styles.chartDateAxis}>
                                <span>{timeSeries[0]?.label ?? 'Day 1'}</span>
                                <span>{timeSeries[Math.floor(timeSeries.length / 2)]?.label ?? 'Day 15'}</span>
                                <span>{timeSeries[timeSeries.length - 1]?.label ?? 'Day 30'}</span>
                            </div>

                            <div className={styles.chartSummaryFooter}>
                                <div className={styles.chartSummaryItem}>
                                    <span className={styles.summaryLabel}>30-DAY BOOKINGS</span>
                                    <strong className={styles.summaryVal}>{resTotal}</strong>
                                </div>
                                <div className={styles.chartSummaryItem}>
                                    <span className={styles.summaryLabel}>CONFIRMED</span>
                                    <strong className={styles.summaryVal}>{resConfirmed + resCompleted}</strong>
                                </div>
                                <div className={styles.chartSummaryItem}>
                                    <span className={styles.summaryLabel}>COLLECTED REVENUE</span>
                                    <strong className={styles.summaryVal}>{formatCurrency(collectedRevenue)}</strong>
                                </div>
                                <div className={styles.chartSummaryItem}>
                                    <span className={styles.summaryLabel}>AVG. DAILY RATE</span>
                                    <strong className={styles.summaryVal}>{formatCurrency(financials?.averageRentalValueEur)}</strong>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.sparseState}>
                            <Clock size={20} />
                            <span>Telemetry history currently sparse. Recording live bookings.</span>
                        </div>
                    )}
                </div>

                {/* CHART B: RESERVATION LIFECYCLE DISTRIBUTION */}
                <div className={styles.chartPanel}>
                    <div className={styles.chartPanelHeader}>
                        <div>
                            <span className={styles.panelEyebrow}>LIFECYCLE TELEMETRY</span>
                            <h2 className={styles.panelTitle}>Reservation Status Distribution</h2>
                        </div>
                        <Link
                            href="/admin/reservations"
                            className={styles.chartHeaderBadgeLink}
                            title="Open All Reservations"
                        >
                            <span>{resTotal} Total Bookings</span>
                            <ArrowUpRight size={12} />
                        </Link>
                    </div>

                    <p className={styles.chartPanelDesc}>
                        Comprehensive breakdown of all reservation lifecycle states from initial customer checkout to completion.
                    </p>

                    {/* Proportional Multi-Segment Progress Bar */}
                    <div className={styles.distributionBarContainer} role="progressbar" aria-label="Status Distribution">
                        {statusSegments.map((seg, idx) => {
                            const pct = ((seg.count / totalStatusItems) * 100).toFixed(1);
                            return (
                                <div
                                    key={idx}
                                    className={styles.distributionBarSegment}
                                    style={{ width: `${pct}%`, backgroundColor: seg.bg }}
                                    title={`${seg.label}: ${seg.count} (${pct}%)`}
                                />
                            );
                        })}
                    </div>

                    {/* Status Legend & Breakdown Roster */}
                    <div className={styles.statusLegendRoster}>
                        {statusSegments.map((seg, idx) => {
                            const pct = ((seg.count / totalStatusItems) * 100).toFixed(1);
                            return (
                                <div key={idx} className={styles.legendRow}>
                                    <div className={styles.legendRowLeft}>
                                        <span className={styles.legendDot} style={{ backgroundColor: seg.bg }} />
                                        <span className={styles.legendName}>{seg.label}</span>
                                    </div>
                                    <div className={styles.legendRowRight}>
                                        <strong className={styles.legendCount}>{seg.count}</strong>
                                        <span className={styles.legendPct}>({pct}%)</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Conversion & Cancellation Rate Footer */}
                    <div className={styles.conversionFooter}>
                        <div className={styles.conversionBox}>
                            <CheckCircle2 size={15} className={styles.successIcon} />
                            <div>
                                <span className={styles.convLabel}>CONVERSION RATE</span>
                                <strong className={styles.convValue}>{formatPercent(conversionRate)}</strong>
                            </div>
                        </div>

                        <div className={styles.conversionBox}>
                            <AlertCircle size={15} className={styles.warningIcon} />
                            <div>
                                <span className={styles.convLabel}>CANCELLATION RATE</span>
                                <strong className={styles.convValue}>{formatPercent(intelligence?.reservations.cancellationRatePercent)}</strong>
                            </div>
                        </div>

                        {utilizationRate !== null && (
                            <div className={styles.conversionBox}>
                                <Car size={15} className={styles.neutralIcon} />
                                <div>
                                    <span className={styles.convLabel}>FLEET UTILIZATION</span>
                                    <strong className={styles.convValue}>{formatPercent(utilizationRate)}</strong>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

            </section>

            {/* ================================================= */}
            {/* 5. RECENT RESERVATIONS & OPERATIONAL ACTIONS      */}
            {/* ================================================= */}
            <section className={styles.operationalGrid} aria-label="Operational Actions & Roster">

                {/* SECTION A: RECENT & UPCOMING BOOKINGS */}
                <div className={styles.actionPanel}>
                    <div className={styles.actionPanelHeader}>
                        <div>
                            <span className={styles.panelEyebrow}>IMMOBILISATION ROSTER</span>
                            <h2 className={styles.panelTitle}>Recent & Upcoming Bookings</h2>
                        </div>
                        <Link href="/admin/reservations" className={styles.panelHeaderLink}>
                            <span>View All</span>
                            <ArrowRight size={13} />
                        </Link>
                    </div>

                    {intelligence?.upcomingReservations && intelligence.upcomingReservations.length > 0 ? (
                        <div className={styles.bookingsTableWrapper}>
                            <table className={styles.bookingsTable}>
                                <thead>
                                    <tr>
                                        <th>REFERENCE</th>
                                        <th>VEHICLE</th>
                                        <th>RENTAL DATES</th>
                                        <th className={styles.thRight}>AMOUNT</th>
                                        <th className={styles.thRight}>STATUS</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {intelligence.upcomingReservations.slice(0, 5).map((booking) => {
                                        const badge = formatStatusLabel(booking.status);
                                        const inspectUrl = `/admin/reservations?focus=${encodeURIComponent(booking.reservationNumber)}`;
                                        return (
                                            <tr key={booking.reservationNumber} className={styles.bookingRow}>
                                                <td className={styles.tdRef}>
                                                    <Link
                                                        href={inspectUrl}
                                                        className={styles.refLink}
                                                        title={`Inspect reservation ${booking.reservationNumber}`}
                                                    >
                                                        {booking.reservationNumber}
                                                    </Link>
                                                </td>
                                                <td className={styles.tdVehicle}>
                                                    <Link
                                                        href={inspectUrl}
                                                        className={styles.vehicleLink}
                                                        title={`Inspect reservation ${booking.reservationNumber}`}
                                                    >
                                                        <strong>{booking.vehicleLabel}</strong>
                                                        <span>{booking.categoryName}</span>
                                                    </Link>
                                                </td>
                                                <td className={styles.tdDates}>
                                                    <span>{formatDateRange(booking.pickupAt, booking.returnAt)}</span>
                                                    <span className={styles.tdDuration}>({booking.rentalDays} days)</span>
                                                </td>
                                                <td className={`${styles.tdAmount} ${styles.tdRight}`}>
                                                    <strong>{formatCurrency(booking.totalAmountEur)}</strong>
                                                    <span>Dep: {formatCurrency(booking.depositAmountEur)}</span>
                                                </td>
                                                <td className={`${styles.tdStatus} ${styles.thRight}`}>
                                                    <Link
                                                        href={inspectUrl}
                                                        className={styles.statusBadgeLink}
                                                        title={`Inspect reservation ${booking.reservationNumber}`}
                                                    >
                                                        <span className={`${styles.tableBadge} ${badge.styleClass}`}>
                                                            {badge.label}
                                                        </span>
                                                    </Link>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className={styles.emptyBookings}>
                            <Clock size={24} />
                            <p>No upcoming reservations currently scheduled in this window.</p>
                            <Link href="/admin/reservations" className={styles.emptyLink}>
                                Open Reservations Console →
                            </Link>
                        </div>
                    )}
                </div>

                {/* SECTION B: PRIORITY OPERATIONAL ACTIONS & INSIGHTS */}
                <div className={styles.actionPanel}>
                    <div className={styles.actionPanelHeader}>
                        <div>
                            <span className={styles.panelEyebrow}>DISPATCHER PRIORITY ACTIONS</span>
                            <h2 className={styles.panelTitle}>Operations Risk & Quick Actions</h2>
                        </div>
                        <Link
                            href="/admin/reservations?status=pending"
                            className={styles.panelHeaderBadgeLink}
                            title="View pending operational actions"
                        >
                            {urgentActionsCount} Pending
                        </Link>
                    </div>

                    <div className={styles.highlightsContainer}>
                        {intelligence?.operationalHighlights && intelligence.operationalHighlights.length > 0 ? (
                            intelligence.operationalHighlights.map((hl) => (
                                <div
                                    key={hl.id}
                                    className={`${styles.highlightCard} ${
                                        hl.severity === 'warning'
                                            ? styles.hlWarning
                                            : hl.severity === 'positive'
                                              ? styles.hlPositive
                                              : styles.hlInfo
                                    }`}
                                >
                                    <div className={styles.hlHeader}>
                                        <span className={styles.hlTitle}>{hl.title}</span>
                                        <span className={styles.hlMetric}>{hl.metricValue}</span>
                                    </div>
                                    <p className={styles.hlDetail}>{hl.detail}</p>
                                </div>
                            ))
                        ) : (
                            <div className={styles.hlInfo}>
                                <span className={styles.hlTitle}>All Systems Nominal</span>
                                <p className={styles.hlDetail}>No critical risk or overdue items detected by the operational monitor.</p>
                            </div>
                        )}
                    </div>

                    {/* Executive Direct Action Links */}
                    <div className={styles.quickActionNav}>
                        <span className={styles.quickNavLabel}>EXECUTIVE ROUTING</span>
                        <div className={styles.quickNavGrid}>
                            <Link
                                href="/admin/reservations?status=pending"
                                className={styles.quickNavBtn}
                                title="Open reservations filtered by Pending Approval"
                            >
                                <span>Pending Booking Approvals</span>
                                <ArrowRight size={13} />
                            </Link>
                            <Link
                                href="/admin/finance?tab=requests&filter=pending"
                                className={styles.quickNavBtn}
                                title="Open Finance Agency Payment Requests and Holds Queue"
                            >
                                <span>Payment & Security Holds</span>
                                <ArrowRight size={13} />
                            </Link>
                            <Link
                                href="/admin/availability"
                                className={styles.quickNavBtn}
                                title="Open Fleet Real-Time Availability Calendar"
                            >
                                <span>Real-Time Fleet Calendar</span>
                                <ArrowRight size={13} />
                            </Link>
                            <Link
                                href="/admin/pricing#insights"
                                className={styles.quickNavBtn}
                                title="Open Pricing & Intelligence"
                            >
                                <span>Pricing &amp; Intelligence</span>
                                <ArrowRight size={13} />
                            </Link>
                        </div>
                    </div>
                </div>

            </section>

        </main>
    );
}
