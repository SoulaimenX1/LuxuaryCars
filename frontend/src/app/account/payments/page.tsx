'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import styles from './payments.module.css';

interface PaymentItem {
  id: string;
  type: string;
  method: string;
  amount: string;
  currency: string;
  paidAt: string;
  reference: string | null;
}

interface DepositDetails {
  id: string | null;
  status: string;
  amount: string;
  requiredAmount: string;
  receivedAmount: string;
  outstandingAmount: string;
  releasedAmount: string;
  refundedAmount: string;
  retainedAmount: string;
  retentionReason: string | null;
}

interface FinancialReservation {
  id: string;
  reservationNumber: string;
  status: string;
  customerId: string;
  customerName: string;
  vehicleId?: string;
  vehicleName: string;
  vehiclePhoto?: string | null;
  pickupAt: string;
  returnAt: string;
  dailyPrice?: string;
  rentalDays?: number;
  totalAmount: string;
  depositAmount: string;
  paymentDeadlineAt?: string | null;
  paymentUrl?: string | null;
  paidAt?: string | null;
  stripeRefundId?: string | null;
  depositRefundStatus?: string | null;
  depositRefundedAmount?: string | null;
  depositRetainedAmount?: string | null;
  depositRetentionReason?: string | null;
  createdAt?: string;
}

interface FinancialSummary {
  reservation: FinancialReservation;
  payments: PaymentItem[];
  deposit: DepositDetails;
  amountPaidEur: string;
  outstandingEur: string;
  paymentStatus: string;
  refundedEur: string;
}

function formatAmount(val: string | number | undefined | null): string {
  const num = Number(val || 0);
  const isWhole = num % 1 === 0;
  return num.toLocaleString('en-US', { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 });
}

function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTimeRemaining(deadlineIso: string | undefined | null, now: number): { formatted: string; isExpired: boolean } {
  if (!deadlineIso) return { formatted: '24h limit', isExpired: false };
  const deadline = new Date(deadlineIso).getTime();
  const diff = deadline - now;
  if (diff <= 0) return { formatted: 'Expired', isExpired: true };

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  const pad = (n: number) => String(n).padStart(2, '0');
  return { formatted: `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`, isExpired: false };
}

function AccountPaymentsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [summaries, setSummaries] = useState<FinancialSummary[]>([]);
  const [error, setError] = useState('');
  const [payingNum, setPayingNum] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'awaiting' | 'confirmed' | 'active' | 'completed'>('all');
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  const successParam = searchParams.get('success');
  const canceledParam = searchParams.get('canceled');
  const focusParam = searchParams.get('focus') || searchParams.get('ref');

  // Clock tick for countdown
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Load financial summaries
  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const authRes = await fetch('/api/auth/me', { cache: 'no-store' });
        if (authRes.status === 401) {
          router.replace('/login');
          return;
        }

        const res = await fetch('/api/finance/me/reservations', { cache: 'no-store' });
        if (!res.ok) throw new Error('Unable to load payment portal records.');
        const data: FinancialSummary[] = await res.json();
        if (active) {
          setSummaries(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (active) {
          const msg = err instanceof Error ? err.message : 'Error loading payments';
          setError(msg);
          setLoading(false);
        }
      }
    }

    void loadData();
    return () => { active = false; };
  }, [router]);

  // Initiate Stripe Checkout
  async function handlePayNow(reservationNumber: string) {
    setPayingNum(reservationNumber);
    setError('');
    try {
      const response = await fetch(
        `/api/reservations/by-number/${encodeURIComponent(reservationNumber)}/checkout`,
        { method: 'POST' }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.message || 'Unable to start Stripe Checkout.');
      }
      if (data?.paymentUrl) {
        window.location.assign(data.paymentUrl);
      } else {
        throw new Error('No payment URL returned from Stripe session.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Checkout initiation failed';
      setError(msg);
      setPayingNum(null);
    }
  }

  // Filtered summaries
  const filteredSummaries = useMemo(() => {
    if (filter === 'all') return summaries;
    if (filter === 'awaiting') {
      return summaries.filter((s) => s.reservation.status === 'awaiting_payment');
    }
    if (filter === 'confirmed') {
      return summaries.filter((s) => s.reservation.status === 'confirmed');
    }
    if (filter === 'active') {
      return summaries.filter((s) => s.reservation.status === 'active_rental');
    }
    if (filter === 'completed') {
      return summaries.filter((s) => s.reservation.status === 'completed');
    }
    return summaries;
  }, [summaries, filter]);

  // Aggregate Metrics
  const metrics = useMemo(() => {
    let awaitingCount = 0;
    let totalPaidEur = 0;
    let depositsHeldEur = 0;
    let refundsProcessedEur = 0;

    summaries.forEach((s) => {
      if (s.reservation.status === 'awaiting_payment') awaitingCount++;
      totalPaidEur += Number(s.amountPaidEur || 0);
      if (s.deposit?.status === 'held') {
        depositsHeldEur += Number(s.deposit.amount || s.reservation.depositAmount || 0);
      }
      refundsProcessedEur += Number(s.refundedEur || s.reservation.depositRefundedAmount || 0);
    });

    return { awaitingCount, totalPaidEur, depositsHeldEur, refundsProcessedEur };
  }, [summaries]);

  return (
    <div className={styles.page}>
      {/* Sticky Header */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/account" className={styles.brand}>
            LUXUAR
          </Link>
          <nav className={styles.nav}>
            <Link href="/account">My Garage</Link>
            <Link href="/account/reservations">Reservations</Link>
            <Link href="/account/payments" className={styles.active}>
              Payments &amp; Deposits
            </Link>
            <Link href="/account/profile">Profile</Link>
          </nav>
        </div>
      </header>

      <main className={styles.container}>
        <Link href="/account" className={styles.back}>
          ← Return to My Garage
        </Link>

        {/* Hero Banner */}
        <section className={styles.hero}>
          <span className={styles.eyebrow}>CLIENT PAYMENT PORTAL</span>
          <h1>Payments &amp; Security Deposits</h1>
          <p className={styles.intro}>
            Manage and settle approved bookings via Stripe Checkout, review refundable security deposit authorizations, and download official payment receipts.
          </p>
        </section>

        {/* Success / Canceled Notifications */}
        {successParam && (
          <div className={styles.noticeSuccess}>
            ✓ <strong>Payment verified!</strong> Your Stripe transaction has been processed and your reservation is confirmed.
          </div>
        )}

        {canceledParam && (
          <div className={styles.noticeWarning}>
            ⚠ <strong>Checkout canceled.</strong> Your payment was not finalized. You can resume and complete checkout anytime within the 24-hour payment window.
          </div>
        )}

        {error && (
          <div className={styles.noticeDanger}>
            {error}
          </div>
        )}

        {/* Summary Metric Cards */}
        <div className={styles.metricsGrid}>
          <div className={styles.metricCard}>
            <span className={styles.metricLabel}>Awaiting Payment</span>
            <span className={`${styles.metricValue} ${metrics.awaitingCount > 0 ? styles.metricValueHighlight : ''}`}>
              {metrics.awaitingCount} {metrics.awaitingCount === 1 ? 'Booking' : 'Bookings'}
            </span>
          </div>

          <div className={styles.metricCard}>
            <span className={styles.metricLabel}>Total Settled</span>
            <span className={styles.metricValue}>€{formatAmount(metrics.totalPaidEur)}</span>
          </div>

          <div className={styles.metricCard}>
            <span className={styles.metricLabel}>Security Deposits Held</span>
            <span className={styles.metricValue}>€{formatAmount(metrics.depositsHeldEur)}</span>
          </div>

          <div className={styles.metricCard}>
            <span className={styles.metricLabel}>Refunds Disbursed</span>
            <span className={styles.metricValue}>€{formatAmount(metrics.refundsProcessedEur)}</span>
          </div>
        </div>

        {/* Filter Pills */}
        <div className={styles.filters}>
          <button
            type="button"
            className={`${styles.filterBtn} ${filter === 'all' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilter('all')}
          >
            All Bookings ({summaries.length})
          </button>
          <button
            type="button"
            className={`${styles.filterBtn} ${filter === 'awaiting' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilter('awaiting')}
          >
            Action Required ({metrics.awaitingCount})
          </button>
          <button
            type="button"
            className={`${styles.filterBtn} ${filter === 'confirmed' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilter('confirmed')}
          >
            Confirmed / Paid
          </button>
          <button
            type="button"
            className={`${styles.filterBtn} ${filter === 'active' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilter('active')}
          >
            Active Rentals
          </button>
          <button
            type="button"
            className={`${styles.filterBtn} ${filter === 'completed' ? styles.filterBtnActive : ''}`}
            onClick={() => setFilter('completed')}
          >
            Completed &amp; Settled
          </button>
        </div>

        {loading ? (
          <div className={styles.loadingSpinner}>Loading financial portfolio...</div>
        ) : filteredSummaries.length === 0 ? (
          <div className={styles.emptyState}>
            <h3>No payments found</h3>
            <p>You have no reservations matching the selected filter criteria.</p>
            <Link href="/vehicles" className={styles.payButton}>
              Explore Vehicles →
            </Link>
          </div>
        ) : (
          <div className={styles.cardsList}>
            {filteredSummaries.map(({ reservation: r, payments, deposit }) => {
              const isAwaiting = r.status === 'awaiting_payment';
              const countdown = isAwaiting ? formatTimeRemaining(r.paymentDeadlineAt, currentTime) : null;
              const isFocused = focusParam === r.reservationNumber;

              return (
                <article
                  key={r.id}
                  id={`payment-${r.reservationNumber}`}
                  className={`${styles.paymentCard} ${isAwaiting ? styles.urgentCard : ''}`}
                  style={isFocused ? { outline: '2px solid var(--champagne)' } : undefined}
                >
                  {/* Card Header */}
                  <div className={styles.cardHeader}>
                    <div className={styles.cardHeaderLeft}>
                      <span className={styles.reservationNum}>{r.reservationNumber}</span>
                      <span className={`${styles.statusBadge} ${
                        r.status === 'pending'
                          ? styles.statusPending
                          : r.status === 'awaiting_payment'
                          ? styles.statusAwaiting
                          : r.status === 'confirmed'
                          ? styles.statusConfirmed
                          : r.status === 'active_rental'
                          ? styles.statusActive
                          : r.status === 'completed'
                          ? styles.statusCompleted
                          : styles.statusCancelled
                      }`}>
                        {r.status.replaceAll('_', ' ')}
                      </span>
                    </div>

                    <Link
                      href={`/account/payments/${encodeURIComponent(r.reservationNumber)}`}
                      className={styles.receiptBtn}
                    >
                      Payment Details →
                    </Link>
                  </div>

                  {/* Card Body */}
                  <div className={styles.cardContent}>
                    {/* Vehicle Photo */}
                    <div className={styles.vehicleImageWrap}>
                      {r.vehiclePhoto ? (
                        <img src={r.vehiclePhoto} alt={r.vehicleName} className={styles.vehicleImage} />
                      ) : (
                        <div className={styles.vehicleFallback}>
                          <span>LUXUAR</span>
                          <strong>{r.vehicleName}</strong>
                        </div>
                      )}
                    </div>

                    {/* Details and Actions */}
                    <div className={styles.vehicleDetails}>
                      <div>
                        <h2 className={styles.vehicleTitle}>{r.vehicleName}</h2>
                        <div className={styles.rentalDates}>
                          Rental Period: {formatDateTime(r.pickupAt)} → {formatDateTime(r.returnAt)}
                        </div>
                      </div>

                      {/* Financial Breakdown */}
                      <div className={styles.financialGrid}>
                        <div className={styles.finItem}>
                          <span className={styles.finLabel}>Rental Price</span>
                          <span className={styles.finValue}>€{formatAmount(r.totalAmount)}</span>
                        </div>

                        <div className={styles.finItem}>
                          <span className={styles.finLabel}>Refundable Deposit</span>
                          <span className={styles.finValue}>€{formatAmount(r.depositAmount)}</span>
                        </div>

                        <div className={styles.finItem}>
                          <span className={styles.finLabel}>Total Due</span>
                          <span className={`${styles.finValue} ${styles.finTotal}`}>
                            €{formatAmount(Number(r.totalAmount) + Number(r.depositAmount))}
                          </span>
                        </div>

                        <div className={styles.finItem}>
                          <span className={styles.finLabel}>Deposit Status</span>
                          <span className={styles.finValue} style={{ textTransform: 'capitalize' }}>
                            {deposit?.status || 'Pending'}
                          </span>
                        </div>
                      </div>

                      {/* Urgent Pay Now Banner with Countdown */}
                      {isAwaiting && (
                        <div className={styles.urgentBanner}>
                          <div className={styles.countdownBlock}>
                            <span className={styles.clockIcon}>⏳</span>
                            <div className={styles.countdownText}>
                              <span className={styles.countdownLabel}>Payment Deadline</span>
                              <span className={styles.countdownDigits}>
                                {countdown?.isExpired ? 'EXPIRED' : countdown?.formatted}
                              </span>
                            </div>
                          </div>

                          {!countdown?.isExpired ? (
                            <button
                              type="button"
                              className={styles.payButton}
                              disabled={payingNum === r.reservationNumber}
                              onClick={() => void handlePayNow(r.reservationNumber)}
                            >
                              {payingNum === r.reservationNumber ? 'Redirecting to Stripe...' : 'Pay with Stripe Checkout →'}
                            </button>
                          ) : (
                            <span style={{ color: 'var(--danger)', fontSize: '13px', fontWeight: 600 }}>
                              Payment deadline expired. Vehicle has been released.
                            </span>
                          )}
                        </div>
                      )}

                      {/* Settlement Outcome if Completed */}
                      {r.status === 'completed' && (
                        <div className={styles.depositSettlementBanner}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                            <span>Security Deposit Refunded: <strong style={{ color: 'var(--success)' }}>€{formatAmount(r.depositRefundedAmount || r.depositAmount)}</strong></span>
                            {Number(r.depositRetainedAmount) > 0 && (
                              <span>Damage Deduction: <strong style={{ color: 'var(--danger)' }}>€{formatAmount(r.depositRetainedAmount)}</strong></span>
                            )}
                          </div>
                          {r.depositRetentionReason && (
                            <span style={{ color: 'var(--muted)', fontSize: '12px' }}>
                              Deduction reason: {r.depositRetentionReason}
                            </span>
                          )}
                          {r.stripeRefundId && (
                            <span style={{ color: 'var(--muted)', fontSize: '11px', fontFamily: 'monospace' }}>
                              Stripe Refund ID: {r.stripeRefundId}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Transaction Receipts History */}
                  {payments && payments.length > 0 && (
                    <div className={styles.historySection}>
                      <span className={styles.historyTitle}>Verified Stripe Transactions</span>
                      <div className={styles.historyList}>
                        {payments.map((p) => (
                          <div key={p.id} className={styles.historyItem}>
                            <div>
                              <strong style={{ textTransform: 'capitalize' }}>{p.type.replaceAll('_', ' ')}</strong>
                              <span style={{ color: 'var(--muted)', marginLeft: '12px' }}>
                                {formatDateTime(p.paidAt)} · Card (Stripe Verified)
                              </span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                              <strong>€{formatAmount(p.amount)}</strong>
                              <a
                                href={`/api/finance/me/payments/${p.id}/receipt`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={styles.receiptBtn}
                              >
                                📄 Receipt PDF
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

export default function AccountPaymentsPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.page}>
          <main className={styles.container}>
            <div className={styles.emptyCard}>
              <p>Loading payments &amp; deposits portal...</p>
            </div>
          </main>
        </div>
      }
    >
      <AccountPaymentsContent />
    </Suspense>
  );
}
