'use client';

import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useToast } from '@/components/toast';
import type { PricingStatusResponse, ScopedPricingRule } from '@/lib/pricing-types';
import { getVehiclePhoto } from '@/app/admin/analytics/RecommendationDrawer';
import styles from './dynamic-pricing-control.module.css';

function DynamicPricingControlInternal() {
  const toast = useToast();

  const [status, setStatus] = useState<PricingStatusResponse | null>(null);
  const [rules, setRules] = useState<ScopedPricingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Global Toggle Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingTargetState, setPendingTargetState] = useState<boolean | null>(null);
  const [isUpdating, startUpdate] = useTransition();

  // Scoped Rule Rollback Modal State
  const [rollbackModalOpen, setRollbackModalOpen] = useState(false);
  const [rollbackTargetRule, setRollbackTargetRule] = useState<ScopedPricingRule | null>(null);
  const [rollbackReason, setRollbackReason] = useState('Operational rollback');
  const [rollbackLoading, setRollbackLoading] = useState(false);

  // Collapsible History State
  const [historyOpen, setHistoryOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const [resStatus, resRules] = await Promise.all([
        fetch('/api/admin/pricing/status', { cache: 'no-store' }),
        fetch('/api/admin/pricing/rules', { cache: 'no-store' }),
      ]);

      if (!resStatus.ok) {
        throw new Error(`Failed to load dynamic pricing status (${resStatus.status})`);
      }
      const data: PricingStatusResponse = await resStatus.json();
      setStatus(data);

      if (resRules.ok) {
        const rulesData = await resRules.json();
        setRules(Array.isArray(rulesData) ? rulesData : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to query dynamic pricing status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleOpenConfirm = (target: boolean) => {
    setPendingTargetState(target);
    setModalOpen(true);
  };

  const handleCancel = () => {
    setModalOpen(false);
    setPendingTargetState(null);
  };

  const handleConfirmToggle = () => {
    if (pendingTargetState === null) return;
    const target = pendingTargetState;

    startUpdate(async () => {
      try {
        const res = await fetch('/api/admin/pricing/toggle', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: target }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || `HTTP ${res.status}`);
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
            : 'Dynamic Pricing turned OFF. Standard catalog daily rates are enforced.',
          'Pricing State Updated',
        );

        setModalOpen(false);
        setPendingTargetState(null);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to update dynamic pricing state',
          'MFA Authorization',
        );
      }
    });
  };

  // Rollback Action
  const handleOpenRollback = (rule: ScopedPricingRule) => {
    setRollbackTargetRule(rule);
    setRollbackReason('Operational rollback requested by admin');
    setRollbackModalOpen(true);
  };

  const handleSubmitRollback = async () => {
    if (!rollbackTargetRule) return;

    try {
      setRollbackLoading(true);
      const res = await fetch(
        `/api/admin/pricing/rules/${encodeURIComponent(rollbackTargetRule.ruleId)}/rollback`,
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
        `Restored catalog daily rate €${rollbackTargetRule.originalDailyPrice.toLocaleString()}/day for ${rollbackTargetRule.licensePlate}.`,
        'Price Rule Rolled Back',
      );
      setRollbackModalOpen(false);
      setRollbackTargetRule(null);
      await fetchStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rollback failed', 'Error');
    } finally {
      setRollbackLoading(false);
    }
  };

  const isEnabled = Boolean(status?.enabled);

  // Active vs Inactive Rules
  const activeRules = useMemo(
    () => rules.filter((r) => r.status === 'active'),
    [rules],
  );

  const historyRules = useMemo(
    () => rules.filter((r) => r.status !== 'active'),
    [rules],
  );

  return (
    <section className={styles.card} aria-labelledby="dynamic-pricing-title">
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 id="dynamic-pricing-title" className={styles.title}>
            Dynamic Pricing
          </h2>
          <p className={styles.subtitle}>
            Manage active rate adjustments, seasonal rules, and fleet pricing.
          </p>
        </div>

        <div className={styles.topLinksRow}>
          <Link href="/admin/analytics" className={styles.analyticsLink}>
            <ExternalLink size={14} />
            View Demand Forecasts & Recommendations →
          </Link>
        </div>
      </div>

      {error ? (
        <div style={{ color: '#ef4444', marginBottom: '1.25rem', fontSize: '0.88rem' }}>
          {error}
        </div>
      ) : null}

      {/* 1. One Clear ON/OFF Control */}
      <div className={styles.actionRow}>
        <div className={styles.actionLabel}>
          <div className={styles.actionHeadingRow}>
            <span className={styles.actionHeading}>Master Pricing Switch</span>
            <span
              className={`${styles.statusPill} ${
                isEnabled ? styles.statusPillActive : styles.statusPillInactive
              }`}
            >
              <span className={styles.statusDot} />
              {loading ? 'Checking…' : isEnabled ? 'Active (Dynamic Rates Live)' : 'Off (Catalog Baseline)'}
            </span>
          </div>
          <span className={styles.actionDescription}>
            {isEnabled
              ? 'Automated seasonal adjustments, weekend rates, and duration discounts are live on all customer quotes.'
              : 'Dynamic pricing is disabled. All quotes use fixed vehicle catalog daily rates.'}
          </span>
        </div>

        <button
          type="button"
          disabled={loading || isUpdating}
          onClick={() => handleOpenConfirm(!isEnabled)}
          className={`${styles.toggleBtn} ${
            isEnabled ? styles.toggleDeactivate : styles.toggleActivate
          }`}
        >
          {loading || isUpdating
            ? 'Updating…'
            : isEnabled
            ? 'Turn Dynamic Pricing OFF'
            : 'Turn Dynamic Pricing ON'}
        </button>
      </div>

      {/* 2. Four Compact Pricing Rule Categories */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h3 className={styles.sectionTitle}>Standard Pricing Rules</h3>
        <div className={styles.categoriesGrid}>
          {/* Category 1: Seasonal Demand */}
          <div className={styles.categoryCard}>
            <span className={styles.categoryTitle}>Seasonal Demand</span>
            <span className={styles.categoryRates}>+20% / +15% / -10%</span>
            <span className={styles.categoryDesc}>
              Festive peak (+20%), Summer (+15%), Winter value (-10%).
            </span>
          </div>

          {/* Category 2: Weekend Prime */}
          <div className={styles.categoryCard}>
            <span className={styles.categoryTitle}>Weekend Prime</span>
            <span className={styles.categoryRates}>+12% / +8%</span>
            <span className={styles.categoryDesc}>
              Friday & Saturday (+12%), Sunday prime rental (+8%).
            </span>
          </div>

          {/* Category 3: Vehicle Category */}
          <div className={styles.categoryCard}>
            <span className={styles.categoryTitle}>Vehicle Category</span>
            <span className={styles.categoryRates}>+10% / +5% / +2%</span>
            <span className={styles.categoryDesc}>
              Hypercars (+10%), Sports & GT (+5%), Luxury Sedan & SUV (+2%).
            </span>
          </div>

          {/* Category 4: Rental Duration */}
          <div className={styles.categoryCard}>
            <span className={styles.categoryTitle}>Rental Duration</span>
            <span className={styles.categoryRates}>-5% to -20%</span>
            <span className={styles.categoryDesc}>
              3+ days (-5%), weekly (-10%), 14+ days (-15%), monthly (-20%).
            </span>
          </div>
        </div>
      </div>

      {/* 3. Active Pricing Adjustments with Real Vehicle Photos */}
      <div className={styles.adjustmentsSection}>
        <h3 className={styles.sectionTitle}>
          Active Price Adjustments
          <span className={styles.ruleCountBadge}>
            {activeRules.length} Active
          </span>
        </h3>

        {activeRules.length === 0 ? (
          <div className={styles.emptyStateCard}>
            <strong>No active vehicle price adjustments.</strong>
            <p style={{ margin: '0.4rem 0 0 0', color: 'var(--muted-text)', fontSize: '0.85rem' }}>
              When recommendations are approved from Predictive Analytics, the active adjusted daily rates appear here with real vehicle photos and instant rollback controls.
            </p>
          </div>
        ) : (
          <div className={styles.adjustmentsGrid}>
            {activeRules.map((rule) => {
              const photo = getVehiclePhoto(rule.imageUrl, rule.licensePlate);
              return (
                <div key={rule.ruleId} className={styles.adjustmentCard}>
                  {/* Real Vehicle Photo */}
                  <div className={styles.cardThumbRow}>
                    <img
                      src={photo}
                      alt={`${rule.brand} ${rule.model}`}
                      className={styles.cardVehicleImg}
                      loading="lazy"
                    />
                    <span className={styles.cardCategoryOverlay}>{rule.category || 'Luxury'}</span>
                    <span className={styles.cardPlateOverlay}>{rule.licensePlate}</span>
                  </div>

                  <div className={styles.cardInfoBody}>
                    <div>
                      <h4 className={styles.cardName}>
                        {rule.brand} {rule.model}
                      </h4>

                      <div className={styles.cardRatesRow}>
                        <div className={styles.rateCol}>
                          <span className={styles.rateLabel}>Catalog</span>
                          <span className={styles.rateOriginal}>
                            €{rule.originalDailyPrice.toLocaleString()}/d
                          </span>
                        </div>

                        <div className={styles.rateCol}>
                          <span className={styles.rateLabel}>Approved Rate</span>
                          <span className={styles.rateApproved}>
                            €{rule.approvedDailyPrice.toLocaleString()}/d
                          </span>
                        </div>

                        <div>
                          <span
                            className={`${styles.varianceBadge} ${
                              rule.variancePercent >= 0
                                ? styles.variancePositive
                                : styles.varianceNegative
                            }`}
                          >
                            {rule.variancePercent > 0 ? '+' : ''}
                            {rule.variancePercent}%
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className={styles.datesNote}>
                      Effective: {rule.startDate || 'Immediate'} → {rule.endDate || 'Ongoing'}
                    </div>

                    <button
                      type="button"
                      className={styles.btnRollbackCard}
                      onClick={() => handleOpenRollback(rule)}
                    >
                      ↺ Rollback to Catalog Rate
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. Compact Collapsible History Section */}
      {historyRules.length > 0 && (
        <div className={styles.historySection}>
          <button
            type="button"
            className={styles.historyHeaderBtn}
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <span>
              Price Rule History ({historyRules.length} Rolled Back)
            </span>
            {historyOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {historyOpen && (
            <div className={styles.historyList}>
              {historyRules.map((r) => {
                const photo = getVehiclePhoto(r.imageUrl, r.licensePlate);
                return (
                  <div key={r.ruleId} className={styles.historyItem}>
                    <div className={styles.historyLeft}>
                      <img
                        src={photo}
                        alt={`${r.brand} ${r.model}`}
                        className={styles.historyThumb}
                      />
                      <div>
                        <span className={styles.historyName}>
                          {r.brand} {r.model}
                        </span>
                        <span style={{ fontFamily: 'monospace', color: 'var(--muted-text)', fontSize: '0.75rem', marginLeft: '0.4rem' }}>
                          {r.licensePlate}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--muted-text)' }}>
                        Was €{r.approvedDailyPrice.toLocaleString()}/d → Restored to €{r.originalDailyPrice.toLocaleString()}/d
                      </span>
                      <span className={styles.historyStatusPill}>
                        Rolled Back
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Global Dynamic Pricing Toggle Modal */}
      {modalOpen && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className={styles.modalBox}>
            <h3 id="modal-title" className={styles.modalTitle}>
              {pendingTargetState ? 'Activate Dynamic Pricing?' : 'Turn Off Dynamic Pricing?'}
            </h3>

            <p className={styles.modalText}>
              {pendingTargetState
                ? 'Activating dynamic pricing will apply seasonal multipliers, weekend rates, and duration discounts to new customer quotations.'
                : 'Turning off dynamic pricing will immediately revert all customer quotations to standard catalog vehicle daily rates.'}
            </p>

            <div className={styles.modalNotice}>
              <strong>Note:</strong> Existing reservations, confirmed bookings, and processed payments will never be altered.
            </div>

            <div className={styles.modalActions}>
              <button
                type="button"
                disabled={isUpdating}
                onClick={handleCancel}
                className={styles.btnCancel}
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={isUpdating}
                onClick={handleConfirmToggle}
                className={pendingTargetState ? styles.btnConfirm : styles.btnConfirmDanger}
              >
                {isUpdating ? 'Saving…' : pendingTargetState ? 'Confirm Activation' : 'Confirm Deactivation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rollback Modal */}
      {rollbackModalOpen && rollbackTargetRule && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="rollback-title">
          <div className={styles.modalBox}>
            <h3 id="rollback-title" className={styles.modalTitle}>
              Rollback Price Rule
            </h3>

            <p className={styles.modalText}>
              Revert <strong>{rollbackTargetRule.brand} {rollbackTargetRule.model} ({rollbackTargetRule.licensePlate})</strong> back to catalog daily rate of <strong>€{rollbackTargetRule.originalDailyPrice.toLocaleString()}/day</strong>?
            </p>

            <div className={styles.fieldGroup}>
              <label htmlFor="rollback-reason" className={styles.fieldLabel}>
                Reason for Rollback
              </label>
              <input
                id="rollback-reason"
                type="text"
                className={styles.textInput}
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
              />
            </div>

            <div className={styles.modalActions}>
              <button
                type="button"
                disabled={rollbackLoading}
                onClick={() => setRollbackModalOpen(false)}
                className={styles.btnCancel}
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={rollbackLoading}
                onClick={() => void handleSubmitRollback()}
                className={styles.btnConfirmDanger}
              >
                {rollbackLoading ? 'Restoring…' : 'Confirm Rollback'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function DynamicPricingControl() {
  return (
    <Suspense fallback={<div style={{ padding: '2rem', textAlign: 'center' }}>Loading pricing console…</div>}>
      <DynamicPricingControlInternal />
    </Suspense>
  );
}
