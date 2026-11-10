'use client';

import {
  Calendar,
  CheckCircle2,
  Clock,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import type {
  Recommendation,
  ScopedPricingRule,
  SimulationResult,
} from '@/lib/pricing-types';
import styles from './analytics.module.css';

interface RecommendationDrawerProps {
  open: boolean;
  recommendation: Recommendation | null;
  onClose: () => void;
  onApplySuccess: () => Promise<void>;
  dynamicPricingEnabled: boolean;
  existingRules: ScopedPricingRule[];
}

export function getVehiclePhoto(imageUrl?: string | null, licensePlate?: string | null): string {
  if (imageUrl && imageUrl.trim().length > 0) {
    const trimmed = imageUrl.trim();
    if (trimmed.startsWith('/') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
  }
  if (licensePlate) {
    const cleanPlate = licensePlate.trim().toUpperCase();
    if (cleanPlate === 'LC-0001') return '/vehicles/lc-0001-image-1792339991261.png';
    if (cleanPlate === 'LC-0002') return '/vehicles/lc-0002-image-1792339953145.png';
    if (cleanPlate === 'LC-0003') return '/vehicles/lc-0003-image-1792340138989.png';
    if (cleanPlate === 'LC-0004') return '/vehicles/lc-0004-image-1792340119514.png';
    if (cleanPlate === 'LC-0005') return '/vehicles/lc-0005-image-1792340225691.png';
    if (cleanPlate === 'LC-0006') return '/vehicles/lc-0006-image-1792340183769.png';
    if (cleanPlate === 'LC-0007') return '/vehicles/lc-0007-image-1792340459940.png';
    if (cleanPlate === 'LC-0008') return '/vehicles/lc-0008-image-1792340403706.png';
    if (cleanPlate === 'LC-0009') return '/vehicles/lc-0009-image-1792340433096.png';
    if (cleanPlate === 'LC-0010') return '/vehicles/lc-0010-image-1792340349830.png';
    if (cleanPlate === 'LC-0039') return '/vehicles/lc-0039-image-1792339742001.png';
    if (cleanPlate === 'LF-123-FR') return '/vehicles/lf-123-fr-image-1792375857522.png';
  }
  return '/vehicles/lc-0001-image-1792339991261.png';
}

export default function RecommendationDrawer({
  open,
  recommendation,
  onClose,
  onApplySuccess,
  dynamicPricingEnabled,
  existingRules,
}: RecommendationDrawerProps) {
  const toast = useToast();
  const drawerRef = useRef<HTMLDivElement>(null);

  // Editable simulation and date states
  const [customPrice, setCustomPrice] = useState<string>('');
  const [rentalDays, setRentalDays] = useState<number>(3);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [adminReason, setAdminReason] = useState<string>('');

  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [simLoading, setSimLoading] = useState<boolean>(false);
  const [applying, setApplying] = useState<boolean>(false);
  const [dismissing, setDismissing] = useState<boolean>(false);
  const [showApplyConfirm, setShowApplyConfirm] = useState<boolean>(false);

  const runSimulation = useCallback(
    async (rec: Recommendation, price: number, days: number) => {
      try {
        const res = await fetch(
          `/api/admin/dashboard/pricing-demand/recommendations/${encodeURIComponent(
            rec.recommendationId,
          )}/simulate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              simulatedDailyPrice: price,
              rentalDays: days,
              licensePlate: rec.licensePlate,
            }),
          },
        );

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || 'Simulation calculation failed.');
        }

        const data: SimulationResult = await res.json();
        setSimResult(data);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Simulation failed',
          'Simulation',
        );
      } finally {
        setSimLoading(false);
      }
    },
    [toast],
  );

  // Initialize drawer inputs when recommendation changes
  const [prevRec, setPrevRec] = useState<Recommendation | null>(null);
  if (recommendation !== prevRec) {
    setPrevRec(recommendation);
    if (recommendation) {
      const initialPrice =
        recommendation.suggestedPriceMax || recommendation.currentDailyPrice;
      setCustomPrice(String(initialPrice));
      setRentalDays(3);
      setStartDate(new Date().toISOString().slice(0, 10));
      setEndDate('');
      setAdminReason(
        `Approved recommendation for ${recommendation.brand} ${recommendation.model} (${recommendation.licensePlate})`,
      );
      setShowApplyConfirm(false);
    } else {
      setSimResult(null);
    }
  }

  useEffect(() => {
    if (recommendation) {
      const initialPrice =
        recommendation.suggestedPriceMax || recommendation.currentDailyPrice;
      void runSimulation(recommendation, initialPrice, 3);
    }
  }, [recommendation, runSimulation]);

  // Keyboard navigation: Escape key closes drawer
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Focus trap inside drawer
  useEffect(() => {
    if (open && drawerRef.current) {
      drawerRef.current.focus();
    }
  }, [open]);

  if (!open || !recommendation) {
    return null;
  }

  const numericCustomPrice = parseFloat(customPrice);
  const isValidPrice =
    !isNaN(numericCustomPrice) &&
    numericCustomPrice >= 50 &&
    numericCustomPrice <= 50000;

  const currentPrice = recommendation.currentDailyPrice;
  const difference = isValidPrice ? numericCustomPrice - currentPrice : 0;
  const variancePct =
    currentPrice > 0 && isValidPrice
      ? Number((((numericCustomPrice - currentPrice) / currentPrice) * 100).toFixed(1))
      : 0;

  const isGuardrailViolated = Math.abs(variancePct) > 50;

  const activeConflict = existingRules.find(
    (r) =>
      r.licensePlate.toUpperCase() === recommendation.licensePlate.toUpperCase() &&
      r.status === 'active',
  );

  const isAlreadyApplied = recommendation.status === 'applied';

  // Apply Handler
  const handleApply = async () => {
    if (!isValidPrice || isGuardrailViolated) {
      toast.error(
        'Price must be between €50 and €50,000/day and within ±50% of the baseline.',
        'Invalid Price',
      );
      return;
    }

    try {
      setApplying(true);
      const res = await fetch('/api/admin/pricing/rules/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recommendationId: recommendation.recommendationId,
          licensePlate: recommendation.licensePlate,
          approvedPrice: numericCustomPrice,
          adminReason: adminReason.trim() || 'Pricing recommendation approved',
          startDate: startDate || undefined,
          endDate: endDate || undefined,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(
          errJson.message || `HTTP ${res.status}: Failed to apply pricing rule.`,
        );
      }

      toast.success(
        `Price updated for ${recommendation.brand} ${recommendation.model} to €${numericCustomPrice.toLocaleString()}/day.`,
        'Price Rule Applied',
      );

      setShowApplyConfirm(false);
      onClose();
      await onApplySuccess();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to apply recommendation',
        'MFA Required',
      );
    } finally {
      setApplying(false);
    }
  };

  // Dismiss Handler
  const handleDismiss = async () => {
    try {
      setDismissing(true);
      const res = await fetch(
        `/api/admin/dashboard/pricing-demand/recommendations/${encodeURIComponent(
          recommendation.recommendationId,
        )}/dismiss`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: adminReason || 'Dismissed by administrator' }),
        },
      );

      if (!res.ok) {
        throw new Error('Failed to dismiss recommendation.');
      }

      toast.success(
        `Recommendation dismissed for ${recommendation.licensePlate}.`,
        'Recommendation Dismissed',
      );
      onClose();
      await onApplySuccess();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Dismiss action failed',
        'Error',
      );
    } finally {
      setDismissing(false);
    }
  };

  const photoUrl = getVehiclePhoto(recommendation.imageUrl, recommendation.licensePlate);

  // Short 2-sentence explanation
  const shortExplanation = recommendation.evidence
    ? recommendation.evidence.split('. ').slice(0, 2).join('. ') + (recommendation.evidence.includes('.') ? '' : '.')
    : 'Demand trends suggest adjusting this daily rate to optimize booking conversion and fleet revenue.';

  return (
    <div
      className={styles.drawerOverlay}
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        ref={drawerRef}
        className={styles.drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div className={styles.drawerHeader}>
          <div className={styles.drawerHeaderInfo}>
            <div className={styles.drawerTopRow}>
              <span className={styles.drawerCategoryBadge}>
                {recommendation.category}
              </span>
              <span className={styles.drawerPlatePill}>
                {recommendation.licensePlate}
              </span>
            </div>
            <h2 id="drawer-title" className={styles.drawerTitle}>
              {recommendation.brand} {recommendation.model}
            </h2>
          </div>
          <button
            type="button"
            className={styles.drawerCloseBtn}
            onClick={onClose}
            aria-label="Close details"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className={styles.drawerBody}>
          {/* Large Real Vehicle Photo */}
          <div className={styles.drawerPhotoWrapper}>
            <img
              src={photoUrl}
              alt={`${recommendation.brand} ${recommendation.model}`}
              className={styles.drawerPhoto}
              loading="lazy"
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = '/vehicles/lc-0001-image-1792339991261.png';
              }}
            />
            <div className={styles.drawerPhotoOverlay}>
              <span className={styles.drawerPhotoPlate}>{recommendation.licensePlate}</span>
              <span className={styles.drawerPhotoStatus}>
                {isAlreadyApplied ? 'Active Rule' : 'Pending Review'}
              </span>
            </div>
          </div>

          {/* Pricing Comparison Cards */}
          <div className={styles.drawerPriceComparison}>
            <div className={styles.drawerPriceCol}>
              <span className={styles.drawerPriceLabel}>Current Daily Price</span>
              <span className={styles.drawerPriceCurrent}>
                €{currentPrice.toLocaleString()}/day
              </span>
            </div>

            <div className={styles.drawerPriceCol}>
              <span className={styles.drawerPriceLabel}>Recommended Price</span>
              <span className={styles.drawerPriceTarget}>
                €{recommendation.suggestedPriceMax.toLocaleString()}/day
              </span>
            </div>

            <div className={styles.drawerPriceCol}>
              <span className={styles.drawerPriceLabel}>Adjustment</span>
              <span
                className={`${styles.drawerVariancePill} ${
                  variancePct > 0
                    ? styles.pillPositive
                    : variancePct < 0
                    ? styles.pillNegative
                    : styles.pillNeutral
                }`}
              >
                {variancePct > 0 ? `+€${difference.toLocaleString()}` : `-€${Math.abs(difference).toLocaleString()}`} ({variancePct > 0 ? '+' : ''}{variancePct}%)
              </span>
            </div>
          </div>

          {/* Status Notices if any */}
          {!dynamicPricingEnabled && (
            <div className={styles.drawerNoticeAmber}>
              <Sparkles size={16} />
              <div>
                <strong>Dynamic Pricing is currently OFF</strong>
                <p>Applying this rule saves it in storage. It will take effect when Dynamic Pricing is enabled.</p>
              </div>
            </div>
          )}

          {activeConflict && (
            <div className={styles.drawerNoticeBlue}>
              <CheckCircle2 size={16} />
              <div>
                <strong>Active Price Change in Effect</strong>
                <p>Currently set to €{activeConflict.approvedDailyPrice.toLocaleString()}/day. Applying will update this rate.</p>
              </div>
            </div>
          )}

          {/* Business Explanation (Max 2 sentences) */}
          <div className={styles.drawerCard}>
            <h3 className={styles.drawerCardTitle}>Why this recommendation?</h3>
            <p className={styles.drawerExplanationText}>{shortExplanation}</p>
            <div className={styles.drawerConfidenceRow}>
              <span className={styles.confidenceBadge}>
                Confidence: <strong>{recommendation.confidenceLevel === 'high' ? 'High' : 'Moderate'}</strong>
              </span>
              <span className={styles.impactBadge}>
                {recommendation.expectedBusinessImpact}
              </span>
            </div>
          </div>

          {/* Interactive Price Simulation */}
          <div className={styles.drawerCard}>
            <h3 className={styles.drawerCardTitle}>Price Simulation</h3>
            <div className={styles.simInputRow}>
              <div className={styles.simInputGroup}>
                <label htmlFor="sim-price-input" className={styles.inputLabel}>
                  Test Daily Price (€)
                </label>
                <div className={styles.inputWithSymbol}>
                  <span>€</span>
                  <input
                    id="sim-price-input"
                    type="number"
                    min="50"
                    max="50000"
                    step="25"
                    className={styles.simPriceField}
                    value={customPrice}
                    onChange={(e) => {
                      setCustomPrice(e.target.value);
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val) && val >= 50 && val <= 50000) {
                        setSimLoading(true);
                        void runSimulation(recommendation, val, rentalDays);
                      }
                    }}
                  />
                </div>
              </div>

              <div className={styles.simDurationGroup}>
                <label className={styles.inputLabel}>Rental Duration</label>
                <div className={styles.simDurationPills}>
                  {[3, 7, 14].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`${styles.simDurationBtn} ${
                        rentalDays === d ? styles.simDurationBtnActive : ''
                      }`}
                      onClick={() => {
                        setRentalDays(d);
                        if (isValidPrice) {
                          setSimLoading(true);
                          void runSimulation(recommendation, numericCustomPrice, d);
                        }
                      }}
                    >
                      {d} Days
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Estimated Revenue Outcome */}
            {simLoading ? (
              <div className={styles.simLoadingRow}>Calculating rental scenarios…</div>
            ) : simResult ? (
              <div className={styles.simOutcomeCard}>
                <div className={styles.simOutcomeCol}>
                  <span className={styles.simOutcomeLabel}>Current {rentalDays}-Day Total</span>
                  <span className={styles.simOutcomeValue}>
                    €{simResult.currentGrossTotal.toLocaleString()}
                  </span>
                </div>
                <div className={styles.simOutcomeCol}>
                  <span className={styles.simOutcomeLabel}>Simulated {rentalDays}-Day Total</span>
                  <span className={styles.simOutcomeSimulated}>
                    €{simResult.simulatedGrossTotal.toLocaleString()}
                  </span>
                </div>
                <div className={styles.simOutcomeCol}>
                  <span className={styles.simOutcomeLabel}>Expected Difference</span>
                  <span
                    className={
                      simResult.varianceTotal >= 0
                        ? styles.simDiffPositive
                        : styles.simDiffNegative
                    }
                  >
                    {simResult.varianceTotal >= 0 ? '+' : ''}€
                    {simResult.varianceTotal.toLocaleString()} ({simResult.variancePercent}%)
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          {/* Effective Dates */}
          <div className={styles.drawerCard}>
            <h3 className={styles.drawerCardTitle}>Effective Dates</h3>
            <div className={styles.datesGrid}>
              <div className={styles.dateCol}>
                <label htmlFor="drawer-start-date" className={styles.inputLabel}>
                  <Calendar size={13} /> Start Date
                </label>
                <input
                  id="drawer-start-date"
                  type="date"
                  className={styles.dateField}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className={styles.dateCol}>
                <label htmlFor="drawer-end-date" className={styles.inputLabel}>
                  <Clock size={13} /> End Date (Optional)
                </label>
                <input
                  id="drawer-end-date"
                  type="date"
                  className={styles.dateField}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className={styles.drawerFooter}>
          {showApplyConfirm ? (
            <div className={styles.confirmBox}>
              <p className={styles.confirmMessage}>
                Apply <strong>€{numericCustomPrice.toLocaleString()}/day</strong> for {recommendation.brand} {recommendation.model}?
              </p>
              <div className={styles.confirmActionsRow}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setShowApplyConfirm(false)}
                  disabled={applying}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.btnPrimaryApply}
                  onClick={() => void handleApply()}
                  disabled={applying}
                >
                  {applying ? 'Applying…' : 'Confirm & Apply'}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.drawerActionsRow}>
              <button
                type="button"
                className={styles.btnDismiss}
                onClick={() => void handleDismiss()}
                disabled={dismissing || applying || isAlreadyApplied}
              >
                {dismissing ? 'Dismissing…' : 'Dismiss'}
              </button>

              <button
                type="button"
                className={styles.btnSecondary}
                onClick={onClose}
              >
                Cancel
              </button>

              <button
                type="button"
                className={styles.btnPrimaryApply}
                disabled={!isValidPrice || isGuardrailViolated || applying || isAlreadyApplied}
                onClick={() => setShowApplyConfirm(true)}
              >
                {isAlreadyApplied
                  ? 'Already Applied'
                  : `Apply Recommendation (€${Number(customPrice || 0).toLocaleString()})`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
