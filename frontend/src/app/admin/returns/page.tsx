'use client';

import { useEffect, useState, useMemo } from 'react';
import styles from './returns.module.css';
import { useToast } from '@/components/toast';

interface Reservation {
  id: string;
  reservationNumber: string;
  vehicleId: string;
  customerId: string;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  dailyPrice: string;
  depositAmount: string;
  totalAmount: string;
  status: string;
  createdAt: string;
  pickupLocation?: string | null;
  paymentDeadlineAt?: string | null;
  paidAt?: string | null;
  returnConfirmedAt?: string | null;
  depositRefundStatus?: string | null;
  depositRefundedAmount?: string | null;
  depositRetainedAmount?: string | null;
  depositRetentionReason?: string | null;
  stripeRefundId?: string | null;
}

interface Vehicle {
  id: string;
  brandName: string;
  modelName: string;
  licensePlate?: string;
  imageUrl?: string | null;
}

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatEur(amount: number | string) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(amount) || 0);
}

export default function AdminReturnsPage() {
  const toast = useToast();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');

  // Settlement Modal State
  const [target, setTarget] = useState<Reservation | null>(null);
  const [mode, setMode] = useState<'full' | 'partial' | 'zero'>('full');
  const [damageAmount, setDamageAmount] = useState('0');
  const [damageReason, setDamageReason] = useState('');
  const [evidenceNotes, setEvidenceNotes] = useState('');
  const [excessDamage, setExcessDamage] = useState('0');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    async function init() {
      try {
        const [resRes, vehRes, custRes] = await Promise.all([
          fetch('/api/admin/reservations', { cache: 'no-store' }),
          fetch('/api/vehicles/catalog', { cache: 'no-store' }),
          fetch('/api/admin/customers', { cache: 'no-store' }),
        ]);

        if (!resRes.ok) throw new Error('Unable to fetch reservations');
        const resData = await resRes.json();
        if (!active) return;
        setReservations(Array.isArray(resData) ? resData : []);

        if (vehRes.ok) {
          const vData = await vehRes.json();
          if (active) setVehicles(Array.isArray(vData) ? vData : []);
        }
        if (custRes.ok) {
          const cData = await custRes.json();
          if (active) setCustomers(Array.isArray(cData) ? cData : []);
        }
      } catch (err: unknown) {
        if (active) {
          const msg = err instanceof Error ? err.message : 'Failed to load data';
          setError(msg);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void init();
    return () => {
      active = false;
    };
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      setError('');
      const [resRes, vehRes, custRes] = await Promise.all([
        fetch('/api/admin/reservations', { cache: 'no-store' }),
        fetch('/api/vehicles/catalog', { cache: 'no-store' }),
        fetch('/api/admin/customers', { cache: 'no-store' }),
      ]);

      if (!resRes.ok) throw new Error('Unable to fetch reservations');
      const resData = await resRes.json();
      setReservations(Array.isArray(resData) ? resData : []);

      if (vehRes.ok) {
        const vData = await vehRes.json();
        setVehicles(Array.isArray(vData) ? vData : []);
      }
      if (custRes.ok) {
        const cData = await custRes.json();
        setCustomers(Array.isArray(cData) ? cData : []);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load data';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const vehicleMap = useMemo(() => {
    const map = new Map<string, Vehicle>();
    vehicles.forEach((v) => map.set(v.id, v));
    return map;
  }, [vehicles]);

  const customerMap = useMemo(() => {
    const map = new Map<string, Customer>();
    customers.forEach((c) => map.set(c.id, c));
    return map;
  }, [customers]);

  // Active rentals awaiting return inspection & deposit settlement
  const activeRentals = useMemo(() => {
    return reservations.filter((r) => r.status === 'active_rental');
  }, [reservations]);

  // Filtered by search
  const filteredRentals = useMemo(() => {
    if (!search.trim()) return activeRentals;
    const term = search.toLowerCase().trim();
    return activeRentals.filter((r) => {
      const v = vehicleMap.get(r.vehicleId);
      const c = customerMap.get(r.customerId);
      const text = `${r.reservationNumber} ${v?.brandName ?? ''} ${v?.modelName ?? ''} ${c?.firstName ?? ''} ${c?.lastName ?? ''} ${c?.email ?? ''}`.toLowerCase();
      return text.includes(term);
    });
  }, [activeRentals, search, vehicleMap, customerMap]);

  // Completed history counts & totals
  const completedStats = useMemo(() => {
    const completed = reservations.filter((r) => r.status === 'completed');
    const totalRefunded = completed.reduce(
      (sum, r) => sum + (Number(r.depositRefundedAmount) || 0),
      0,
    );
    const totalRetained = completed.reduce(
      (sum, r) => sum + (Number(r.depositRetainedAmount) || 0),
      0,
    );
    const activeEscrow = activeRentals.reduce(
      (sum, r) => sum + (Number(r.depositAmount) || 0),
      0,
    );
    return {
      activeCount: activeRentals.length,
      completedCount: completed.length,
      totalRefunded,
      totalRetained,
      activeEscrow,
    };
  }, [reservations, activeRentals]);

  function openSettlement(r: Reservation) {
    setTarget(r);
    setMode('full');
    setDamageAmount('0');
    setDamageReason('');
    setEvidenceNotes('');
    setExcessDamage('0');
  }

  function closeSettlement() {
    setTarget(null);
    setSubmitting(false);
  }

  // Calculate refund & retained based on mode
  const depositTotal = Number(target?.depositAmount || 0);
  let computedRetained = 0;
  if (mode === 'full') {
    computedRetained = 0;
  } else if (mode === 'zero') {
    computedRetained = depositTotal;
  } else {
    computedRetained = Math.min(depositTotal, Math.max(0, Number(damageAmount) || 0));
  }
  const computedRefund = Math.max(0, depositTotal - computedRetained);

  async function handleExecuteSettlement() {
    if (!target) return;

    if (computedRetained > 0 && !damageReason.trim()) {
      toast.error('A mandatory reason is required when retaining any part of the security deposit.', 'Return Settlement');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const response = await fetch('/api/admin/reservations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationNumber: target.reservationNumber,
          action: 'return_refund',
          refundAmount: computedRefund,
          retainedAmount: computedRetained,
          reason: damageReason.trim() || undefined,
          evidenceNotes: evidenceNotes.trim() || undefined,
          excessDamageAmount: Number(excessDamage) || 0,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.message || 'Settlement failed');
      }

      const msg = `Vehicle return confirmed for ${target.reservationNumber}. Deposit settlement processed via Stripe (Refund: ${formatEur(computedRefund)}, Retained: ${formatEur(computedRetained)}).`;
      setSuccess(msg);
      toast.success(msg, 'Settlement Complete');
      closeSettlement();
      await loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Return & settlement failed';
      setError(msg);
      toast.error(msg, 'Error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.page}>
      {/* Header Block */}
      <div className={styles.headerBlock}>
        <h1 className={styles.title}>Returns &amp; Security Deposits</h1>
        </div>

      {/* Metrics Row */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Active Rentals Due</span>
          <span className={styles.statValue}>{completedStats.activeCount}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Active Escrow Held</span>
          <span className={styles.statValue}>{formatEur(completedStats.activeEscrow)}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Total Deposits Refunded</span>
          <span className={styles.statValue}>{formatEur(completedStats.totalRefunded)}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Total Damage Retained</span>
          <span className={styles.statValue}>{formatEur(completedStats.totalRetained)}</span>
        </div>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {success && <div className={styles.success} role="status">{success}</div>}

      {/* Controls */}
      <div className={styles.controlsRow}>
        <div className={styles.searchBox}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search active rental by vehicle, customer or reservation number..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => void loadData()}
          className={styles.refreshButton}
          disabled={loading}
        >
          {loading ? 'Refreshing...' : '↻ Refresh Status'}
        </button>
      </div>

      {/* Active Rentals List */}
      {loading ? (
        <div className={styles.emptyState}>
          <p>Loading active rentals from database...</p>
        </div>
      ) : filteredRentals.length === 0 ? (
        <div className={styles.emptyState}>
          <h2 className={styles.emptyTitle}>No Active Rentals Awaiting Return</h2>
          <p className={styles.emptySubtitle}>
            All active rentals have been returned and their security deposits settled. When a vehicle is on the road, it will appear here for return inspection.
          </p>
        </div>
      ) : (
        <div className={styles.rentalsGrid}>
          {filteredRentals.map((r) => {
            const vehicle = vehicleMap.get(r.vehicleId);
            const customer = customerMap.get(r.customerId);
            const vTitle = vehicle
              ? `${vehicle.brandName} ${vehicle.modelName}`
              : `Vehicle ${r.vehicleId.slice(0, 8)}`;
            const cName = customer
              ? `${customer.firstName} ${customer.lastName}`
              : `Customer ${r.customerId.slice(0, 8)}`;

            return (
              <article key={r.id} className={styles.rentalCard}>
                <div className={styles.cardMain}>
                  <div className={styles.cardHeader}>
                    <h3 className={styles.vehicleTitle}>{vTitle}</h3>
                    <span className={styles.resNumberPill}>{r.reservationNumber}</span>
                    <span className={styles.activeTag}>● In Customer Custody</span>
                  </div>

                  <div className={styles.cardDetails}>
                    <div className={styles.detailCol}>
                      <span className={styles.detailLabel}>Customer</span>
                      <span className={styles.detailValue}>{cName}</span>
                      <small style={{ color: 'var(--muted)', fontSize: '11px' }}>{customer?.email}</small>
                    </div>

                    <div className={styles.detailCol}>
                      <span className={styles.detailLabel}>Rental Period</span>
                      <span className={styles.detailValue}>{formatDate(r.pickupAt)}</span>
                      <span style={{ fontSize: '11.5px', color: 'var(--muted)' }}>to {formatDate(r.returnAt)}</span>
                    </div>

                    <div className={styles.detailCol}>
                      <span className={styles.detailLabel}>Scheduled Return Agency</span>
                      <span className={styles.detailValue}>{r.pickupLocation || 'Main Agency'}</span>
                    </div>

                    <div className={styles.detailCol}>
                      <span className={styles.detailLabel}>Deposit Escrow Held</span>
                      <span className={styles.depositHighlight}>{formatEur(r.depositAmount)}</span>
                      <span style={{ fontSize: '11px', color: 'var(--success)' }}>✓ Stripe Verified</span>
                    </div>
                  </div>
                </div>

                <div className={styles.cardActions}>
                  <button
                    type="button"
                    onClick={() => openSettlement(r)}
                    className={styles.settleButton}
                  >
                    Confirm Return &amp; Settle →
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Return & Settlement Modal */}
      {target && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <div>
                <span className={styles.eyebrow}>INSPECTION &amp; SETTLEMENT</span>
                <h2 style={{ fontFamily: 'var(--admin-font-ui)', fontSize: '22px', margin: '4px 0 0 0', color: 'var(--ink)' }}>
                  Confirm Return &amp; Settle Deposit
                </h2>
                <p style={{ fontSize: '12.5px', color: 'var(--muted)', margin: '4px 0 0 0' }}>
                  Reservation {target.reservationNumber} · Total Escrow: {formatEur(target.depositAmount)}
                </p>
              </div>
              <button type="button" onClick={closeSettlement} className={styles.modalClose}>
                ✕
              </button>
            </div>

            <div className={styles.modalForm}>
              {/* Step 1: Confirmation */}
              <div style={{ background: 'rgba(16, 185, 129, 0.08)', padding: '12px 16px', borderRadius: 'var(--radius-button)', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                <strong style={{ fontSize: '12px', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  ✓ Vehicle Handed Back to Agency
                </strong>
                <p style={{ fontSize: '12px', color: 'var(--ink)', margin: '4px 0 0 0' }}>
                  Keys, vehicle documents and physical vehicle inspected and accepted at collection point.
                </p>
              </div>

              {/* Step 2: Refund Mode */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Deposit Settlement Mode</label>
                <div className={styles.modeGrid}>
                  <div
                    onClick={() => setMode('full')}
                    className={`${styles.modeOption} ${mode === 'full' ? styles.modeOptionActive : ''}`}
                  >
                    <span className={styles.modeTitle}>Full Refund</span>
                    <span className={styles.modeDesc}>No damage. 100% deposit returned.</span>
                  </div>

                  <div
                    onClick={() => setMode('partial')}
                    className={`${styles.modeOption} ${mode === 'partial' ? styles.modeOptionActive : ''}`}
                  >
                    <span className={styles.modeTitle}>Partial Refund</span>
                    <span className={styles.modeDesc}>Deduct damage, refund remainder.</span>
                  </div>

                  <div
                    onClick={() => setMode('zero')}
                    className={`${styles.modeOption} ${mode === 'zero' ? styles.modeOptionActive : ''}`}
                  >
                    <span className={styles.modeTitle}>Zero Refund</span>
                    <span className={styles.modeDesc}>Full deposit retained for damage.</span>
                  </div>
                </div>
              </div>

              {/* Step 3: Damage Deduction (if partial or zero) */}
              {mode !== 'full' && (
                <>
                  {mode === 'partial' && (
                    <div className={styles.formGroup}>
                      <label className={styles.formLabel}>
                        Damage Deduction (€) — Max: {formatEur(target.depositAmount)}
                      </label>
                      <input
                        type="number"
                        min="1"
                        max={Number(target.depositAmount)}
                        step="0.01"
                        className={styles.inputField}
                        value={damageAmount}
                        onChange={(e) => setDamageAmount(e.target.value)}
                        placeholder="e.g. 350.00"
                      />
                    </div>
                  )}

                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Mandatory Reason for Damage Deduction / Retention *
                    </label>
                    <input
                      type="text"
                      className={styles.inputField}
                      value={damageReason}
                      onChange={(e) => setDamageReason(e.target.value)}
                      placeholder="e.g. Right front wheel rim scuff & paint scratch on door"
                      required
                    />
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Supporting Evidence Notes / Inspection Details
                    </label>
                    <textarea
                      className={styles.textareaField}
                      value={evidenceNotes}
                      onChange={(e) => setEvidenceNotes(e.target.value)}
                      placeholder="Describe findings, photos taken, repair quote reference or diagnostic report details..."
                    />
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Excess Damage Beyond Deposit (€, optional)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className={styles.inputField}
                      value={excessDamage}
                      onChange={(e) => setExcessDamage(e.target.value)}
                      placeholder="0.00"
                    />
                    <small style={{ color: 'var(--muted)', fontSize: '11px' }}>
                      If repair cost exceeds security deposit, record excess damage here for legal audit.
                    </small>
                  </div>
                </>
              )}

              {/* Step 4: Settlement Ledger Preview */}
              <div className={styles.summaryBox}>
                <div className={styles.summaryRow}>
                  <span>Original Security Deposit:</span>
                  <span>{formatEur(target.depositAmount)}</span>
                </div>
                <div className={styles.summaryRow}>
                  <span>Retained for Documented Damage:</span>
                  <span style={{ color: computedRetained > 0 ? '#ef4444' : 'var(--muted)' }}>
                    -{formatEur(computedRetained)}
                  </span>
                </div>
                {Number(excessDamage) > 0 && (
                  <div className={styles.summaryRow}>
                    <span>Excess Damage Recorded (Uncovered):</span>
                    <span style={{ color: '#ef4444' }}>{formatEur(excessDamage)}</span>
                  </div>
                )}
                <div className={styles.summaryRowTotal}>
                  <span>Verified Stripe Refund to Card:</span>
                  <span style={{ color: '#10b981' }}>{formatEur(computedRefund)}</span>
                </div>
              </div>

              {/* Modal Actions */}
              <div className={styles.modalActions}>
                <button
                  type="button"
                  onClick={closeSettlement}
                  disabled={submitting}
                  className={styles.cancelModalButton}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleExecuteSettlement()}
                  disabled={submitting || (computedRetained > 0 && !damageReason.trim())}
                  className={styles.confirmModalButton}
                >
                  {submitting ? 'Processing via Stripe...' : 'Confirm Return & Execute Refund →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
