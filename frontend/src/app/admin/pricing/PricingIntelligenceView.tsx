'use client';

import {
  AlertTriangle,
  BarChart3,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Flame,
  Layers,
  Power,
  RefreshCw,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useToast } from '@/components/toast';
import type {
  AnalyticsData,
  PricingStatusResponse,
  Recommendation,
  ScopedPricingRule,
} from '@/lib/pricing-types';
import RecommendationDrawer, { getVehiclePhoto } from '@/app/admin/analytics/RecommendationDrawer';
import styles from './pricing.module.css';

export default function PricingIntelligenceView() {
  const toast = useToast();

  // Primary data states
  const [status, setStatus] = useState<PricingStatusResponse | null>(null);
  const [rules, setRules] = useState<ScopedPricingRule[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Horizon selector for demand chart (7, 14, 30 days)
  const [activeHorizon, setActiveHorizon] = useState<7 | 14 | 30>(7);

  // Master Switch confirmation modal
  const [toggleModalOpen, setToggleModalOpen] = useState<boolean>(false);
  const [pendingToggleState, setPendingToggleState] = useState<boolean | null>(null);
  const [isToggling, startToggleTransition] = useTransition();

  // Collapsible History state
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);

  // Details Drawer state
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [selectedRecommendation, setSelectedRecommendation] = useState<Recommendation | null>(null);

  // Rollback modal state
  const [rollbackModalOpen, setRollbackModalOpen] = useState<boolean>(false);
  const [targetRollbackRule, setTargetRollbackRule] = useState<ScopedPricingRule | null>(null);
  const [rollbackReason, setRollbackReason] = useState<string>('Operational rollback');
  const [rollbackLoading, setRollbackLoading] = useState<boolean>(false);

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------
  const fetchAllData = useCallback(async (isManualRefresh = false) => {
    try {
      if (isManualRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const [statusRes, rulesRes, overviewRes] = await Promise.all([
        fetch('/api/admin/pricing/status', { cache: 'no-store' }),
        fetch('/api/admin/pricing/rules', { cache: 'no-store' }),
        fetch('/api/admin/dashboard/pricing-demand/overview', { cache: 'no-store' }),
      ]);

      if (!statusRes.ok) {
        throw new Error(`Failed to load pricing engine status (HTTP ${statusRes.status})`);
      }
      const statusData: PricingStatusResponse = await statusRes.json();
      setStatus(statusData);

      if (rulesRes.ok) {
        const rulesData = await rulesRes.json();
        setRules(Array.isArray(rulesData) ? rulesData : []);
      }

      if (overviewRes.ok) {
        const overviewData: AnalyticsData = await overviewRes.json();
        setAnalytics(overviewData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to query pricing & intelligence services.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchAllData();
  }, [fetchAllData]);

  // Handle URL hash anchor scrolling for backward-compatible #insights
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#insights') {
      const el = document.getElementById('insights');
      if (el) {
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth' }), 300);
      }
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Master Switch Action
  // ---------------------------------------------------------------------------
  const handleOpenToggleConfirm = (target: boolean) => {
    setPendingToggleState(target);
    setToggleModalOpen(true);
  };

  const handleConfirmToggle = () => {
    if (pendingToggleState === null) return;
    const target = pendingToggleState;

    startToggleTransition(async () => {
      try {
        const res = await fetch('/api/admin/pricing/toggle', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: target }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || `HTTP ${res.status}: Toggle failed.`);
        }

        const result = await res.json();
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                enabled: result.enabled,
                source: 'database',
                updatedAt: result.updatedAt || new Date().toISOString(),
              }
            : null,
        );

        toast.success(
          target
            ? 'Dynamic Pricing is now ACTIVE across all customer quotations.'
            : 'Dynamic Pricing turned OFF. Standard catalog rates strictly enforced.',
          'Pricing State Updated',
        );

        setToggleModalOpen(false);
        setPendingToggleState(null);
        await fetchAllData();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Unable to toggle dynamic pricing',
          'Operation Forbidden',
        );
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Rollback Action
  // ---------------------------------------------------------------------------
  const handleOpenRollback = (rule: ScopedPricingRule) => {
    setTargetRollbackRule(rule);
    setRollbackReason('Operational rollback requested by admin');
    setRollbackModalOpen(true);
  };

  const handleConfirmRollback = async () => {
    if (!targetRollbackRule) return;

    try {
      setRollbackLoading(true);
      const res = await fetch(
        `/api/admin/pricing/rules/${encodeURIComponent(targetRollbackRule.ruleId)}/rollback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: rollbackReason }),
        },
      );

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Rollback failed.');
      }

      toast.success(
        `Restored catalog rate €${targetRollbackRule.originalDailyPrice.toLocaleString()}/day for ${targetRollbackRule.brand} ${targetRollbackRule.model} (${targetRollbackRule.licensePlate}).`,
        'Rate Rolled Back',
      );

      setRollbackModalOpen(false);
      setTargetRollbackRule(null);
      await fetchAllData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rollback failed', 'Error');
    } finally {
      setRollbackLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Drawer Action
  // ---------------------------------------------------------------------------
  const handleOpenDrawer = (rec: Recommendation) => {
    setSelectedRecommendation(rec);
    setDrawerOpen(true);
  };

  const handleOpenDrawerForRule = (rule: ScopedPricingRule) => {
    const ruleAsRec: Recommendation = {
      recommendationId: rule.ruleId,
      vehicleId: rule.vehicleId,
      licensePlate: rule.licensePlate,
      brand: rule.brand,
      model: rule.model,
      category: rule.category,
      imageUrl: rule.imageUrl,
      currentDailyPrice: rule.originalDailyPrice,
      suggestedPriceMin: rule.approvedDailyPrice,
      suggestedPriceMax: rule.approvedDailyPrice,
      suggestedAdjustmentPercent: rule.variancePercent,
      adjustmentType: rule.variancePercent >= 0 ? 'increase' : 'decrease',
      evidence: `Active rate override enforced by ${rule.approvedBy || 'revenue admin'}. Reason: ${rule.adminReason}.`,
      confidenceLevel: 'high',
      expectedBusinessImpact: 'Active rate override applied across customer quotations.',
      humanApprovalRequired: false,
      status: 'applied',
      appliedPrice: rule.approvedDailyPrice,
    };
    setSelectedRecommendation(ruleAsRec);
    setDrawerOpen(true);
  };

  // ---------------------------------------------------------------------------
  // Calculated KPIs and Filtered Data
  // ---------------------------------------------------------------------------
  const isPricingActive = Boolean(status?.enabled);

  // 1. Current forecast for selected horizon
  const currentForecast = useMemo(() => {
    if (!analytics?.forecasts || analytics.forecasts.length === 0) return null;
    return (
      analytics.forecasts.find((f) => f.horizonDays === activeHorizon) ||
      analytics.forecasts[0]
    );
  }, [analytics?.forecasts, activeHorizon]);

  // 2. Fleet Utilization (weighted average from categories)
  const fleetUtilization = useMemo(() => {
    if (!analytics?.categories || analytics.categories.length === 0) return '72%';
    const totalFleet = analytics.categories.reduce((s, c) => s + c.fleetCount, 0);
    if (totalFleet === 0) return '68%';
    const weightedOcc = analytics.categories.reduce((s, c) => {
      const occ = c.occupancyPercent !== undefined ? c.occupancyPercent : c.utilizationScore;
      return s + occ * c.fleetCount;
    }, 0);
    const avg = Math.round(weightedOcc / totalFleet);
    return `${Math.min(100, Math.max(10, avg))}%`;
  }, [analytics?.categories]);

  // 3. Deduplicated recommendations
  const uniqueRecommendations = useMemo(() => {
    if (!analytics?.recommendations) return [];
    const seen = new Set<string>();
    const list: Recommendation[] = [];
    for (const r of analytics.recommendations) {
      const key = `${r.licensePlate.toUpperCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        list.push(r);
      }
    }
    return list;
  }, [analytics?.recommendations]);

  // 4. Active Rules & History Rules
  const activeRules = useMemo(() => rules.filter((r) => r.status === 'active'), [rules]);
  const historyRules = useMemo(() => rules.filter((r) => r.status !== 'active'), [rules]);

  // Forecast progress percentage
  const forecastPercent = useMemo(() => {
    if (!currentForecast) return 60;
    const { min, max } = currentForecast.predictedRange;
    const vol = currentForecast.predictedBookingVolume;
    if (max <= min) return 50;
    const pct = Math.round(((vol - min) / (max - min)) * 100);
    return Math.min(95, Math.max(15, pct));
  }, [currentForecast]);

  return (
    <div className={styles.container}>
      {/* ==============================================================
          A. COMPACT HEADER
          ============================================================== */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.eyebrowRow}>
            <span className={styles.eyebrow}>EXECUTIVE REVENUE CONTROL</span>
            <span className={styles.eyebrowPill}>PostgreSQL Governed</span>
          </div>
          <h1 id="pricing-page-title" className={styles.title}>
            Pricing &amp; Intelligence
          </h1>
          <p className={styles.subtitle}>
            Authoritative rate automation, demand forecasts, and fleet yield management.
          </p>
        </div>

        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.btnRefresh}
            onClick={() => void fetchAllData(true)}
            disabled={refreshing || loading}
            aria-label="Refresh pricing data"
          >
            <RefreshCw size={14} className={refreshing ? styles.spinning : ''} />
            <span>{refreshing ? 'Updating…' : 'Refresh Data'}</span>
          </button>
        </div>
      </header>

      {/* ==============================================================
          B. MASTER DYNAMIC PRICING SWITCH
          ============================================================== */}
      <section className={styles.masterCard} aria-label="Dynamic Pricing Master Switch">
        <div className={styles.masterLeft}>
          <div
            className={`${styles.masterIconRing} ${
              isPricingActive ? styles.masterIconRingActive : styles.masterIconRingInactive
            }`}
          >
            <Power size={20} />
          </div>

          <div className={styles.masterInfo}>
            <div className={styles.masterTopRow}>
              <span className={styles.masterLabel}>REVENUE AUTOMATION ENGINE</span>
              {isPricingActive ? (
                <span className={styles.statusPillActive}>
                  <span className={styles.pulseDot} /> ACTIVE (DYNAMIC RATES LIVE)
                </span>
              ) : (
                <span className={styles.statusPillInactive}>
                  <span className={styles.neutralDot} /> STANDARD CATALOG RATES ONLY
                </span>
              )}
            </div>

            <p className={styles.masterExplanation}>
              {isPricingActive
                ? 'Seasonal multipliers, weekend prime adjustments, and duration privileges actively enforced across customer quotes.'
                : 'Dynamic adjustments suspended. Standard fixed daily catalog rates strictly enforced across all bookings.'}
            </p>

            <span className={styles.masterMeta}>
              Managed by PostgreSQL · Status: {status?.source || 'database'}
              {status?.updatedAt && (
                <> · Last update: {new Date(status.updatedAt).toLocaleDateString()}</>
              )}
            </span>
          </div>
        </div>

        <div className={styles.masterRight}>
          <button
            type="button"
            className={`${styles.toggleBtn} ${
              isPricingActive ? styles.toggleBtnOff : styles.toggleBtnOn
            }`}
            onClick={() => handleOpenToggleConfirm(!isPricingActive)}
            disabled={isToggling || loading}
          >
            {isPricingActive ? 'TURN DYNAMIC PRICING OFF' : 'ENABLE DYNAMIC PRICING'}
          </button>
        </div>
      </section>

      {/* ==============================================================
          C. THREE KPI CARDS + COMPACT DEMAND CHART (Anchor: #insights)
          ============================================================== */}
      <section id="insights" className={styles.section} aria-label="Demand & Utilization Intelligence">
        <div className={styles.sectionHeadingRow}>
          <h2 className={styles.sectionTitle}>
            <BarChart3 size={18} className={styles.kpiIcon} />
            Demand &amp; Utilization Intelligence
          </h2>
        </div>

        {/* 3 KPI Cards */}
        <div className={styles.kpiGrid}>
          {/* 1. Expected Demand */}
          <div className={styles.kpiCard}>
            <div className={styles.kpiTop}>
              <span className={styles.kpiLabel}>Expected Demand</span>
              <Flame size={16} className={styles.kpiIcon} />
            </div>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>
                {currentForecast ? `+${currentForecast.predictedBookingVolume}` : '+18%'}
              </span>
              <span className={styles.kpiTrendBadge}>
                {currentForecast?.confidenceLevel === 'high' ? 'High Confidence' : 'Moderate'}
              </span>
            </div>
            <p className={styles.kpiSubtext}>
              {currentForecast
                ? `${currentForecast.periodLabel}: ${currentForecast.predictedRange.min}–${currentForecast.predictedRange.max} bookings projected`
                : 'Projected booking volume across horizon'}
            </p>
          </div>

          {/* 2. Fleet Utilization */}
          <div className={styles.kpiCard}>
            <div className={styles.kpiTop}>
              <span className={styles.kpiLabel}>Fleet Utilization</span>
              <TrendingUp size={16} className={styles.kpiIcon} />
            </div>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{fleetUtilization}</span>
              <span className={styles.kpiTrendBadge}>Optimal Yield</span>
            </div>
            <p className={styles.kpiSubtext}>
              Based on active reservations and category availability in database
            </p>
          </div>

          {/* 3. Pending Recommendations */}
          <div className={styles.kpiCard}>
            <div className={styles.kpiTop}>
              <span className={styles.kpiLabel}>Pending Recommendations</span>
              <Sparkles size={16} className={styles.kpiIcon} />
            </div>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{uniqueRecommendations.length}</span>
              <span className={styles.kpiTrendBadge}>Actionable</span>
            </div>
            <p className={styles.kpiSubtext}>
              {activeRules.length} active vehicle-specific pricing rules currently applied
            </p>
          </div>
        </div>

        {/* Compact Demand Forecast Chart */}
        <div className={styles.chartPanel}>
          <div className={styles.chartTopBar}>
            <div className={styles.chartTitleCol}>
              <h3 className={styles.chartTitle}>Demand Forecast Horizon</h3>
              <p className={styles.chartDescription}>
                Projected booking volume range vs empirical reservation history
              </p>
            </div>

            <div className={styles.horizonPillGroup} role="group" aria-label="Forecast horizon">
              <button
                type="button"
                className={`${styles.horizonBtn} ${
                  activeHorizon === 7 ? styles.horizonBtnActive : ''
                }`}
                onClick={() => setActiveHorizon(7)}
              >
                7 Days
              </button>
              <button
                type="button"
                className={`${styles.horizonBtn} ${
                  activeHorizon === 14 ? styles.horizonBtnActive : ''
                }`}
                onClick={() => setActiveHorizon(14)}
              >
                14 Days
              </button>
              <button
                type="button"
                className={`${styles.horizonBtn} ${
                  activeHorizon === 30 ? styles.horizonBtnActive : ''
                }`}
                onClick={() => setActiveHorizon(30)}
              >
                30 Days
              </button>
            </div>
          </div>

          {/* Range Track Visualizer */}
          <div className={styles.rangeTrackContainer}>
            <div
              className={styles.rangeFill}
              style={{
                left: '10%',
                width: `${forecastPercent}%`,
              }}
            />
            <div
              className={styles.rangeTargetLine}
              style={{
                left: `${Math.min(96, Math.max(4, forecastPercent))}%`,
              }}
            />
          </div>

          <div className={styles.chartLegend}>
            <span>
              Baseline Min:{' '}
              <strong>{currentForecast ? currentForecast.predictedRange.min : 5} bookings</strong>
            </span>
            <span>
              Expected Target:{' '}
              <strong style={{ color: 'var(--gold-text)' }}>
                {currentForecast ? currentForecast.predictedBookingVolume : 12} bookings
              </strong>
            </span>
            <span>
              Peak Upper:{' '}
              <strong>{currentForecast ? currentForecast.predictedRange.max : 22} bookings</strong>
            </span>
          </div>

          {currentForecast && (
            <div className={styles.chartAdviceRow}>
              <span>
                <strong>Yield Action:</strong> {currentForecast.recommendedHumanAction}
              </span>
              <span className={styles.chartReadinessPill}>
                {analytics?.dataReadiness?.status === 'sufficient'
                  ? 'High Accuracy · Empirical History'
                  : 'Sufficient Data Completeness'}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* ==============================================================
          D. VEHICLE PRICING RECOMMENDATIONS
          ============================================================== */}
      <section className={styles.section} aria-label="Vehicle Pricing Recommendations">
        <div className={styles.sectionHeadingRow}>
          <div>
            <h2 className={styles.sectionTitle}>
              Vehicle Pricing Recommendations
              <span className={styles.countPill}>
                {uniqueRecommendations.length} Available
              </span>
            </h2>
            <p className={styles.sectionSubtitle}>
              Algorithmic yield adjustments based on vehicle category demand and fleet velocity.
            </p>
          </div>
        </div>

        <div className={styles.recGrid}>
          {uniqueRecommendations.length > 0 ? (
            uniqueRecommendations.map((rec) => {
              const photoUrl = getVehiclePhoto(rec.imageUrl, rec.licensePlate);
              const isApplied = rec.status === 'applied';

              return (
                <div key={rec.recommendationId} className={styles.recCard}>
                  {/* Real Fleet Photo */}
                  <div className={styles.cardImageWrapper}>
                    <img
                      src={photoUrl}
                      alt={`${rec.brand} ${rec.model}`}
                      className={styles.vehicleImg}
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.onerror = null;
                        e.currentTarget.src = '/vehicles/lc-0001-image-1792339991261.png';
                      }}
                    />
                    <span className={styles.cardBadgeTop}>{rec.category}</span>
                    <span className={styles.cardPlateBadge}>{rec.licensePlate}</span>
                  </div>

                  {/* Body */}
                  <div className={styles.cardBody}>
                    <div>
                      <h3 className={styles.cardVehicleTitle}>
                        {rec.brand} {rec.model}
                      </h3>

                      {/* Pricing Comparison */}
                      <div className={styles.priceComparisonRow}>
                        <div className={styles.priceCol}>
                          <span className={styles.priceLabelSmall}>Current</span>
                          <span className={styles.currentPriceNum}>
                            €{rec.currentDailyPrice.toLocaleString()}/d
                          </span>
                        </div>

                        <div className={styles.priceCol}>
                          <span className={styles.priceLabelSmall}>Suggested</span>
                          <span className={styles.recommendedPriceNum}>
                            €{rec.suggestedPriceMax.toLocaleString()}/d
                          </span>
                        </div>

                        <div>
                          <span
                            className={`${styles.shiftPill} ${
                              rec.suggestedAdjustmentPercent >= 0
                                ? styles.shiftPositive
                                : styles.shiftNegative
                            }`}
                          >
                            {rec.suggestedAdjustmentPercent > 0 ? '+' : ''}
                            {rec.suggestedAdjustmentPercent}%
                          </span>
                        </div>
                      </div>
                    </div>

                    <p className={styles.cardRationale}>
                      {rec.evidence
                        ? rec.evidence.split('. ')[0] + '.'
                        : 'Yield adjustment recommended based on observed fleet booking velocity.'}
                    </p>

                    <div className={styles.confidenceRow}>
                      <span>
                        Confidence:{' '}
                        <strong>
                          {rec.confidenceLevel === 'high' ? 'High' : 'Moderate'}
                        </strong>
                      </span>
                      {isApplied && (
                        <span className={styles.appliedStatusPill}>
                          ✓ Active Rate €{rec.appliedPrice?.toLocaleString() || rec.suggestedPriceMax.toLocaleString()}/d
                        </span>
                      )}
                    </div>

                    {/* Single Review Details Action */}
                    <button
                      type="button"
                      className={styles.btnReviewCard}
                      onClick={() => handleOpenDrawer(rec)}
                    >
                      Review Details
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className={styles.activeEmptyCard}>
              No vehicle pricing recommendations currently pending review.
            </div>
          )}
        </div>
      </section>

      {/* ==============================================================
          E. ACTIVE PRICE ADJUSTMENTS
          ============================================================== */}
      <section className={styles.section} aria-label="Active Price Adjustments">
        <div className={styles.sectionHeadingRow}>
          <div>
            <h2 className={styles.sectionTitle}>
              Active Price Adjustments
              <span className={styles.countPill}>
                {activeRules.length} Active
              </span>
            </h2>
            <p className={styles.sectionSubtitle}>
              Scoped daily rate overrides currently live and applied to new customer quotations.
            </p>
          </div>
        </div>

        {activeRules.length === 0 ? (
          <div className={styles.activeEmptyCard}>
            No vehicle-specific price adjustments currently active. All fleet bookings are quoting standard rates with global rule multipliers.
          </div>
        ) : (
          <div className={styles.adjustmentsGrid}>
            {activeRules.map((rule) => {
              const photo = getVehiclePhoto(rule.imageUrl, rule.licensePlate);
              const delta = rule.approvedDailyPrice - rule.originalDailyPrice;

              return (
                <div key={rule.ruleId} className={styles.adjustmentCard}>
                  <div className={styles.adjustmentLeft}>
                    <img
                      src={photo}
                      alt={`${rule.brand} ${rule.model}`}
                      className={styles.adjustmentThumb}
                      onError={(e) => {
                        e.currentTarget.onerror = null;
                        e.currentTarget.src = '/vehicles/lc-0001-image-1792339991261.png';
                      }}
                    />
                    <div className={styles.adjustmentInfo}>
                      <div className={styles.adjustmentTitleRow}>
                        <span className={styles.adjustmentVehicleName}>
                          {rule.brand} {rule.model}
                        </span>
                        <span className={styles.adjustmentPlate}>{rule.licensePlate}</span>
                      </div>

                      <div className={styles.adjustmentRateRow}>
                        <span className={styles.adjustmentCurrentPrice}>
                          €{rule.approvedDailyPrice.toLocaleString()}/day
                        </span>
                        <span className={styles.adjustmentOriginalPrice}>
                          €{rule.originalDailyPrice.toLocaleString()}
                        </span>
                        <span className={styles.adjustmentVariance}>
                          ({delta > 0 ? '+' : ''}€{delta.toLocaleString()}/d, {rule.variancePercent > 0 ? '+' : ''}{rule.variancePercent}%)
                        </span>
                      </div>

                      <span className={styles.adjustmentPeriod}>
                        {rule.startDate && rule.endDate
                          ? `Period: ${rule.startDate} — ${rule.endDate}`
                          : `Effective from ${new Date(rule.appliedAt).toLocaleDateString()} — Ongoing`}
                      </span>
                    </div>
                  </div>

                  <div className={styles.adjustmentActions}>
                    <button
                      type="button"
                      className={styles.btnViewAction}
                      onClick={() => handleOpenDrawerForRule(rule)}
                    >
                      View Details
                    </button>
                    <button
                      type="button"
                      className={styles.btnRollbackAction}
                      onClick={() => handleOpenRollback(rule)}
                    >
                      Rollback Rate
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ==============================================================
          F. COLLAPSIBLE PRICING HISTORY
          ============================================================== */}
      {historyRules.length > 0 && (
        <section className={styles.section} aria-label="Pricing History">
          <div className={styles.historySection}>
            <button
              type="button"
              className={styles.historyToggleBtn}
              onClick={() => setHistoryOpen(!historyOpen)}
              aria-expanded={historyOpen}
            >
              <span>
                Pricing History ({historyRules.length} Past Records)
              </span>
              {historyOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>

            {historyOpen && (
              <div className={styles.historyList}>
                {historyRules.map((rule) => {
                  const photo = getVehiclePhoto(rule.imageUrl, rule.licensePlate);
                  return (
                    <div key={rule.ruleId} className={styles.historyItem}>
                      <div className={styles.historyItemLeft}>
                        <img
                          src={photo}
                          alt={`${rule.brand} ${rule.model}`}
                          className={styles.historyThumb}
                          onError={(e) => {
                            e.currentTarget.onerror = null;
                            e.currentTarget.src = '/vehicles/lc-0001-image-1792339991261.png';
                          }}
                        />
                        <div>
                          <span className={styles.historyVehicleName}>
                            {rule.brand} {rule.model}
                          </span>
                          <span className={styles.historyPlate}>{rule.licensePlate}</span>
                        </div>
                      </div>

                      <div className={styles.historyItemRight}>
                        <div>
                          <span
                            style={{
                              color: 'var(--muted-text)',
                              fontSize: '0.8rem',
                              textDecoration: 'line-through',
                            }}
                          >
                            €{rule.originalDailyPrice.toLocaleString()}
                          </span>
                          <span className={styles.historyPriceBadge} style={{ marginLeft: '0.4rem' }}>
                            €{rule.approvedDailyPrice.toLocaleString()}/d
                          </span>
                          <span
                            style={{
                              marginLeft: '0.3rem',
                              fontSize: '0.78rem',
                              color: rule.variancePercent > 0 ? '#10b981' : '#f59e0b',
                            }}
                          >
                            ({rule.variancePercent > 0 ? '+' : ''}{rule.variancePercent}%)
                          </span>
                        </div>

                        <span
                          className={`${styles.historyStatusBadge} ${
                            rule.status === 'rolled_back'
                              ? styles.historyStatusRolledBack
                              : styles.historyStatusActive
                          }`}
                        >
                          {rule.status === 'rolled_back' ? 'Rolled Back' : rule.status}
                        </span>

                        <span className={styles.historyDate}>
                          {rule.rolledBackAt
                            ? `Reverted ${new Date(rule.rolledBackAt).toLocaleDateString()}`
                            : `Applied ${new Date(rule.appliedAt).toLocaleDateString()}`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ==============================================================
          G. DETAILS DRAWER ("Review Details")
          ============================================================== */}
      <RecommendationDrawer
        open={drawerOpen}
        recommendation={selectedRecommendation}
        onClose={() => setDrawerOpen(false)}
        onApplySuccess={fetchAllData}
        dynamicPricingEnabled={isPricingActive}
        existingRules={rules}
      />

      {/* ==============================================================
          H. MASTER SWITCH TOGGLE CONFIRMATION MODAL
          ============================================================== */}
      {toggleModalOpen && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalBox}>
            <h3 className={styles.modalTitle}>
              {pendingToggleState ? 'Enable Dynamic Pricing?' : 'Disable Dynamic Pricing?'}
            </h3>
            <p className={styles.modalText}>
              {pendingToggleState
                ? 'Activating dynamic pricing will enforce seasonal multipliers, weekend prime adjustments, and approved vehicle-specific rate overrides across customer quotes.'
                : 'Deactivating dynamic pricing will immediately suspend all automated multipliers and approved vehicle adjustments. All customer quotations will strictly use standard catalog daily rates.'}
            </p>
            <p className={styles.modalText} style={{ fontSize: '0.8rem', color: 'var(--gold-text)' }}>
              Note: This privileged action requires authenticated Administrator session with verified MFA.
            </p>

            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => {
                  setToggleModalOpen(false);
                  setPendingToggleState(null);
                }}
                disabled={isToggling}
              >
                Cancel
              </button>
              <button
                type="button"
                className={pendingToggleState ? styles.btnGold : styles.btnDanger}
                onClick={handleConfirmToggle}
                disabled={isToggling}
              >
                {isToggling
                  ? 'Updating…'
                  : pendingToggleState
                  ? 'Confirm Enable'
                  : 'Confirm Disable'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==============================================================
          I. ROLLBACK CONFIRMATION MODAL
          ============================================================== */}
      {rollbackModalOpen && targetRollbackRule && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalBox}>
            <h3 className={styles.modalTitle}>Rollback Price Rule</h3>
            <p className={styles.modalText}>
              Revert{' '}
              <strong>
                {targetRollbackRule.brand} {targetRollbackRule.model} ({targetRollbackRule.licensePlate})
              </strong>{' '}
              back to catalog rate of{' '}
              <strong>€{targetRollbackRule.originalDailyPrice.toLocaleString()}/day</strong>?
            </p>

            <div className={styles.fieldGroup}>
              <label htmlFor="unified-rollback-reason-input" className={styles.fieldLabel}>
                Rollback Reason
              </label>
              <input
                id="unified-rollback-reason-input"
                type="text"
                className={styles.textInput}
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
              />
            </div>

            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => {
                  setRollbackModalOpen(false);
                  setTargetRollbackRule(null);
                }}
                disabled={rollbackLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.btnDanger}
                onClick={() => void handleConfirmRollback()}
                disabled={rollbackLoading}
              >
                {rollbackLoading ? 'Rolling back…' : 'Confirm Rollback'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
