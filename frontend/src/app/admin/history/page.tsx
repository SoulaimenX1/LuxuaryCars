'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import styles from './history.module.css';

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
  decisionReason?: string | null;
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
}

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatEur(amount: number | string) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(amount) || 0);
}

export default function AdminHistoryPage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'cancelled_unpaid' | 'rejected'>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let active = true;
    async function init() {
      try {
        const [resRes, vehRes, custRes] = await Promise.all([
          fetch('/api/admin/reservations', { cache: 'no-store' }),
          fetch('/api/vehicles/catalog', { cache: 'no-store' }),
          fetch('/api/admin/customers', { cache: 'no-store' }),
        ]);

        if (!resRes.ok) throw new Error('Unable to load reservations');
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
          const msg = err instanceof Error ? err.message : 'Failed to load history';
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

  // History includes terminal states: completed, cancelled_unpaid, cancelled, rejected
  const historyReservations = useMemo(() => {
    return reservations.filter((r) =>
      ['completed', 'cancelled_unpaid', 'cancelled', 'rejected'].includes(r.status),
    );
  }, [reservations]);

  const stats = useMemo(() => {
    const completed = historyReservations.filter((r) => r.status === 'completed');
    const cancelled = historyReservations.filter(
      (r) => r.status === 'cancelled_unpaid' || r.status === 'cancelled',
    );
    const rejected = historyReservations.filter((r) => r.status === 'rejected');
    const totalRefunded = completed.reduce(
      (sum, r) => sum + (Number(r.depositRefundedAmount) || 0),
      0,
    );
    const totalRetained = completed.reduce(
      (sum, r) => sum + (Number(r.depositRetainedAmount) || 0),
      0,
    );

    return {
      completedCount: completed.length,
      cancelledCount: cancelled.length,
      rejectedCount: rejected.length,
      totalRefunded,
      totalRetained,
    };
  }, [historyReservations]);

  const filtered = useMemo(() => {
    return historyReservations.filter((r) => {
      if (statusFilter !== 'all') {
        if (statusFilter === 'cancelled_unpaid') {
          if (r.status !== 'cancelled_unpaid' && r.status !== 'cancelled') return false;
        } else if (r.status !== statusFilter) {
          return false;
        }
      }

      if (search.trim()) {
        const term = search.toLowerCase().trim();
        const v = vehicleMap.get(r.vehicleId);
        const c = customerMap.get(r.customerId);
        const text = `${r.reservationNumber} ${v?.brandName ?? ''} ${v?.modelName ?? ''} ${c?.firstName ?? ''} ${c?.lastName ?? ''} ${c?.email ?? ''}`.toLowerCase();
        if (!text.includes(term)) return false;
      }

      return true;
    });
  }, [historyReservations, statusFilter, search, vehicleMap, customerMap]);

  return (
    <main className={styles.page}>
      {/* Header */}
      <div className={styles.headerBlock}>
        <span className={styles.eyebrow}>LUXUAR · PRIVATE OFFICE · STAGE 08</span>
        <h1 className={styles.title}>Rental &amp; Deposit History</h1>
        <p className={styles.subtitle}>
          Immutable financial and operational audit trail: closed rentals, Stripe refunds, documented damage retentions, and cancelled requests.
        </p>
      </div>

      {/* Metrics */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Completed Rentals</span>
          <span className={styles.statValue}>{stats.completedCount}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Cancelled / Unpaid Released</span>
          <span className={styles.statValue}>{stats.cancelledCount}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Total Deposits Refunded</span>
          <span className={styles.statValue}>{formatEur(stats.totalRefunded)}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Total Damage Deductions</span>
          <span className={styles.statValue}>{formatEur(stats.totalRetained)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className={styles.controlsRow}>
        <div className={styles.filterGroup}>
          <button
            type="button"
            className={`${styles.filterPill} ${statusFilter === 'all' ? styles.filterPillActive : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All History ({historyReservations.length})
          </button>
          <button
            type="button"
            className={`${styles.filterPill} ${statusFilter === 'completed' ? styles.filterPillActive : ''}`}
            onClick={() => setStatusFilter('completed')}
          >
            Completed Rentals ({stats.completedCount})
          </button>
          <button
            type="button"
            className={`${styles.filterPill} ${statusFilter === 'cancelled_unpaid' ? styles.filterPillActive : ''}`}
            onClick={() => setStatusFilter('cancelled_unpaid')}
          >
            Cancelled &amp; Unpaid ({stats.cancelledCount})
          </button>
          <button
            type="button"
            className={`${styles.filterPill} ${statusFilter === 'rejected' ? styles.filterPillActive : ''}`}
            onClick={() => setStatusFilter('rejected')}
          >
            Rejected ({stats.rejectedCount})
          </button>
        </div>

        <input
          type="text"
          className={styles.searchInput}
          placeholder="Filter by ref, vehicle, customer..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <div style={{ color: '#ef4444', marginBottom: '16px' }}>{error}</div>}

      {/* List */}
      {loading ? (
        <div className={styles.emptyState}>
          <p>Loading historical records...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <h2 style={{ fontFamily: 'var(--serif)', fontSize: '20px', color: 'var(--ink)' }}>
            No Records Found
          </h2>
          <p style={{ color: 'var(--muted)', fontSize: '13px' }}>
            No past reservations match the selected filter criteria.
          </p>
        </div>
      ) : (
        <div className={styles.historyList}>
          {filtered.map((r) => {
            const vehicle = vehicleMap.get(r.vehicleId);
            const customer = customerMap.get(r.customerId);
            const vTitle = vehicle
              ? `${vehicle.brandName} ${vehicle.modelName}`
              : `Vehicle ${r.vehicleId.slice(0, 8)}`;
            const cName = customer
              ? `${customer.firstName} ${customer.lastName}`
              : `Customer ${r.customerId.slice(0, 8)}`;

            const isCompleted = r.status === 'completed';
            const isCancelled = r.status === 'cancelled_unpaid' || r.status === 'cancelled';

            return (
              <article key={r.id} className={styles.historyCard}>
                <div className={styles.cardTop}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h3 className={styles.cardTitle}>{vTitle}</h3>
                    <span className={styles.resRef}>{r.reservationNumber}</span>
                  </div>
                  <span
                    className={`${styles.statusPill} ${
                      isCompleted
                        ? styles.statusCompleted
                        : isCancelled
                        ? styles.statusCancelled
                        : styles.statusRejected
                    }`}
                  >
                    {r.status.replace('_', ' ').toUpperCase()}
                  </span>
                </div>

                <div className={styles.grid}>
                  <div className={styles.item}>
                    <span className={styles.itemLabel}>Customer</span>
                    <span className={styles.itemValue}>{cName}</span>
                    <small style={{ color: 'var(--muted)', fontSize: '11px' }}>{customer?.email}</small>
                  </div>

                  <div className={styles.item}>
                    <span className={styles.itemLabel}>Rental Period</span>
                    <span className={styles.itemValue}>
                      {formatDate(r.pickupAt)} – {formatDate(r.returnAt)}
                    </span>
                    <small style={{ color: 'var(--muted)', fontSize: '11px' }}>{r.rentalDays} days</small>
                  </div>

                  <div className={styles.item}>
                    <span className={styles.itemLabel}>Rental Total</span>
                    <span className={styles.itemValue}>{formatEur(r.totalAmount)}</span>
                  </div>

                  <div className={styles.item}>
                    <span className={styles.itemLabel}>Security Deposit</span>
                    <span className={styles.itemValue}>{formatEur(r.depositAmount)}</span>
                  </div>
                </div>

                {/* Deposit & Return Dossier */}
                {isCompleted && (
                  <div className={styles.refundBox}>
                    <div>
                      <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#10b981' }}>
                        ✓ Return Dossier &amp; Stripe Settlement
                      </span>
                      <div style={{ fontSize: '12.5px', marginTop: '2px', color: 'var(--ink)' }}>
                        Refunded: <strong>{formatEur(r.depositRefundedAmount || 0)}</strong>
                        {Number(r.depositRetainedAmount) > 0 && (
                          <span style={{ marginLeft: '12px', color: '#ef4444' }}>
                            Retained for Damage: <strong>{formatEur(r.depositRetainedAmount || 0)}</strong>
                          </span>
                        )}
                      </div>
                      {r.depositRetentionReason && (
                        <p className={styles.reasonNote}>
                          Reason: <em>&ldquo;{r.depositRetentionReason}&rdquo;</em>
                        </p>
                      )}
                    </div>

                    {r.stripeRefundId && (
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontSize: '10.5px', color: 'var(--muted)', textTransform: 'uppercase' }}>
                          Stripe Refund ID
                        </span>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', color: 'var(--champagne-2)' }}>
                          {r.stripeRefundId}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {isCancelled && (
                  <div style={{ fontSize: '12px', color: 'var(--muted)', background: 'var(--surface-2)', padding: '10px 14px', borderRadius: 'var(--radius-button)' }}>
                    Reservation hold released automatically. {r.decisionReason ? `Reason: ${r.decisionReason}` : 'Booking payment deadline elapsed without verified Stripe receipt.'}
                  </div>
                )}

                <div className={styles.cardFooter}>
                  <span>Created: {formatDate(r.createdAt)}</span>
                  <Link
                    href={`/reservations/${encodeURIComponent(r.reservationNumber)}`}
                    className={styles.linkButton}
                  >
                    View Full Reservation Dossier →
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
