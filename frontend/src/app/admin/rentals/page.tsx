'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import styles from './rentals.module.css';
import { useToast } from '@/components/toast';
import { describeActivation, requestAutoActivation } from '@/lib/auto-activate';

interface Rental {
  id: string;
  contractNumber: string;
  reservationNumber: string;
  customerName: string;
  vehicleName: string;
  licensePlate: string;
  status: string;
  startedAt: string;
  expectedReturnAt: string;
  isOverdue: boolean;
  notes?: string | null;
}

interface Reservation {
  id: string;
  reservationNumber: string;
  status: string;
  pickupAt: string;
  returnAt: string;
  vehicleId: string;
  customerId: string;
  pickupLocation?: string | null;
  customerName?: string | null;
  vehicleName?: string | null;
  depositAmount: string;
  totalAmount: string;
}

function formatDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default function AdminRentalsPage() {
  const toast = useToast();
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'overdue'>('all');
  const [activating, setActivating] = useState(false);

  async function refresh() {
    const [rentalResponse, reservationResponse] = await Promise.all([
      fetch('/api/admin/rentals', { cache: 'no-store' }),
      fetch('/api/admin/reservations', { cache: 'no-store' }),
    ]);

    if (!rentalResponse.ok) throw new Error('Unable to fetch active rentals');
    if (!reservationResponse.ok) throw new Error('Unable to fetch reservations');

    const rentalData = await rentalResponse.json();
    const reservationData = await reservationResponse.json();

    setRentals(Array.isArray(rentalData) ? rentalData : []);
    setReservations(Array.isArray(reservationData) ? reservationData : []);
  }

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        await refresh();
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load rentals');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter rentals to active ones
  const activeRentals = useMemo(() => {
    return rentals.filter((r) => r.status === 'active');
  }, [rentals]);

  // Confirmed reservations awaiting their rental start time
  const upcomingConfirmed = useMemo(() => {
    return reservations.filter((r) => r.status === 'confirmed');
  }, [reservations]);

  // Trigger auto-activation (admin-only backend operation).
  // Success is shown ONLY after the backend confirms it; real errors are surfaced.
  async function handleAutoActivate() {
    setActivating(true);
    setError('');
    setSuccess('');
    try {
      const outcome = await requestAutoActivation((input, init) => fetch(input, init));
      if (!outcome.ok) {
        setError(outcome.message);
        toast.error(outcome.message, 'Auto-Activation Failed');
        return;
      }

      const message = describeActivation(outcome.activatedCount);
      setSuccess(message);
      if (outcome.activatedCount > 0) {
        toast.success(message, 'Auto-Activation');
      } else {
        toast.info(message, 'Auto-Activation');
      }

      try {
        await refresh();
      } catch (err: unknown) {
        // Activation itself succeeded; only the list reload failed.
        setError(err instanceof Error ? err.message : 'Unable to reload rentals');
      }
    } finally {
      setActivating(false);
    }
  }

  const filteredRentals = useMemo(() => {
    return activeRentals.filter((r) => {
      if (statusFilter === 'overdue' && !r.isOverdue) return false;
      if (!search.trim()) return true;
      const term = search.toLowerCase().trim();
      const text = `${r.contractNumber} ${r.reservationNumber} ${r.customerName} ${r.vehicleName} ${r.licensePlate}`.toLowerCase();
      return text.includes(term);
    });
  }, [activeRentals, statusFilter, search]);

  const overdueCount = activeRentals.filter((r) => r.isOverdue).length;

  return (
    <main className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Active Rentals</h1>
          </div>

        <button
          type="button"
          onClick={() => void handleAutoActivate()}
          disabled={activating}
          className={styles.refreshButton}
          title="Synchronize confirmed reservations whose pickup time has arrived"
        >
          {activating ? 'Synchronizing...' : '⚡ Auto-Sync Active Rentals'}
        </button>
      </div>

      {/* Summary KPI row */}
      <div className={styles.summaryGrid}>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Active On Road</span>
          <span className={styles.summaryValue}>{activeRentals.length}</span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Overdue For Return</span>
          <span className={styles.summaryValue} style={{ color: overdueCount > 0 ? '#ef4444' : 'inherit' }}>
            {overdueCount}
          </span>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Confirmed Starting Soon</span>
          <span className={styles.summaryValue}>{upcomingConfirmed.length}</span>
        </div>
      </div>

      {error && <div className={styles.errorBanner} role="alert">{error}</div>}
      {success && <div className={styles.successBanner} role="status">{success}</div>}

      {/* Controls & Filter */}
      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search by contract, reservation number, vehicle, customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className={styles.filterPills}>
          <button
            type="button"
            className={`${styles.pill} ${statusFilter === 'all' ? styles.pillActive : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All Active ({activeRentals.length})
          </button>
          <button
            type="button"
            className={`${styles.pill} ${statusFilter === 'overdue' ? styles.pillActive : ''}`}
            onClick={() => setStatusFilter('overdue')}
          >
            Overdue ({overdueCount})
          </button>
        </div>
      </div>

      {/* Active Rental Cards */}
      {loading ? (
        <div className={styles.emptyCard}>
          <p>Loading active rentals...</p>
        </div>
      ) : filteredRentals.length === 0 ? (
        <div className={styles.emptyCard}>
          <h2 style={{ fontFamily: 'var(--admin-font-ui)', fontSize: '20px', color: 'var(--ink)' }}>
            No Active Rentals Found
          </h2>
          <p style={{ color: 'var(--muted)', fontSize: '13.5px', maxWidth: '480px', margin: '8px auto 0 auto' }}>
            There are currently no vehicles on the road matching this view. When a customer rental starts, it will appear here with real-time custody tracking.
          </p>
        </div>
      ) : (
        <div className={styles.rentalList}>
          {filteredRentals.map((r) => (
            <article key={r.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <span className={styles.contractNumber}>{r.contractNumber}</span>
                  <h3 className={styles.vehicleName}>{r.vehicleName}</h3>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className={styles.resNumber}>Ref: {r.reservationNumber}</span>
                  <span className={r.isOverdue ? styles.badgeOverdue : styles.badgeActive}>
                    {r.isOverdue ? '● Overdue Return' : '● Active Rental'}
                  </span>
                </div>
              </div>

              <div className={styles.grid}>
                <div>
                  <span className={styles.label}>Customer</span>
                  <strong className={styles.val}>{r.customerName}</strong>
                </div>

                <div>
                  <span className={styles.label}>License Plate</span>
                  <strong className={styles.valMono}>{r.licensePlate || 'Registered'}</strong>
                </div>

                <div>
                  <span className={styles.label}>Rental Started</span>
                  <strong className={styles.val}>{formatDate(r.startedAt)}</strong>
                </div>

                <div>
                  <span className={styles.label}>Scheduled Return Deadline</span>
                  <strong className={r.isOverdue ? styles.valOverdue : styles.val}>
                    {formatDate(r.expectedReturnAt)}
                  </strong>
                </div>
              </div>

              <div className={styles.cardFooter}>
                <Link
                  href="/admin/returns"
                  className={styles.returnButton}
                >
                  Confirm Return &amp; Settle Deposit →
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
