'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import styles from './finance.module.css';
import { useToast } from '@/components/toast';

// ==============================================================
// TYPES & INTERFACES
// ==============================================================

export type PaymentIntegrityStatus =
  | 'STRIPE_VERIFIED'
  | 'MANUAL_VERIFIED'
  | 'PENDING'
  | 'FAILED_REJECTED';

export interface AgencyPaymentRequest {
  id: string;
  reservationNumber: string;
  status: string;
  agencyPaymentStatus: 'none' | 'agency_payment_requested' | 'approved' | 'rejected';
  agencyPaymentRequestedAt: string | null;
  agencyPaymentAgencyName: string | null;
  agencyPaymentDecidedAt: string | null;
  agencyPaymentDecidedBy: string | null;
  agencyPaymentDecisionNotes: string | null;
  manualPaymentMethod: string | null;
  totalAmount: string;
  depositAmount: string;
  totalDue: string;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  paymentDeadlineAt: string | null;
  createdAt: string;
  customerEmail: string;
  customerName: string;
  customerPhone: string | null;
  vehicleName: string;
  licensePlate: string;
  decidedByName?: string | null;
}

export interface TransactionRecord {
  id: string;
  type: 'rental_payment' | 'deposit_payment' | 'charge_payment' | 'refund';
  method: string;
  amount: string;
  currency: string;
  paidAt: string;
  reference: string | null;
  provider: string | null;
  isSyntheticAudit?: boolean;
  notes: string | null;
  reservationId: string;
  reservationNumber: string;
  reservationStatus: string;
  agencyPaymentStatus: string;
  rentalAmount: string;
  depositAmount: string;
  depositRefundStatus?: string | null;
  customerName: string;
  customerEmail: string;
  vehicleName: string;
  licensePlate: string;
  recordedByName?: string | null;
  integrityStatus: PaymentIntegrityStatus;
}

export interface FinanceDocument {
  id: string;
  documentType: 'receipt' | 'invoice';
  documentNumber: string;
  reservationNumber: string;
  customerName: string;
  amount: string;
  currency: string;
  issuedAt: string;
  downloadUrl: string;
}

export interface PaymentHistoryEvent {
  id: string;
  timestamp: string;
  eventType: string;
  badge: 'STRIPE' | 'MANUAL' | 'PENDING' | 'REJECTED';
  title: string;
  reservationNumber: string;
  customerName: string;
  amount: string;
  reference: string;
  actor: string;
  notes: string;
}

export interface FinanceStats {
  totalVerifiedRevenueEur: string;
  verifiedStripeCount: number;
  verifiedStripeEur: string;
  verifiedManualCount: number;
  verifiedManualEur: string;
  pendingRequestsCount: number;
}

export interface FinanceOverviewData {
  stats: FinanceStats;
  requests: AgencyPaymentRequest[];
  transactions: TransactionRecord[];
  documents: FinanceDocument[];
  history: PaymentHistoryEvent[];
}

type TabKey = 'requests' | 'transactions' | 'documents' | 'history';

// ==============================================================
// HELPERS
// ==============================================================

const euro = (val: string | number) => {
  const num = Number(val) || 0;
  const isWhole = num % 1 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'EUR',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(num);
};

function formatDate(iso?: string | null) {
  if (!iso) return '—';
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

async function errorOf(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data.message === 'string') return data.message;
    if (Array.isArray(data.message)) return data.message.join(', ');
    return JSON.stringify(data.message);
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ==============================================================
// MAIN COMPONENT
// ==============================================================

export default function AdminFinancePage() {
  const toast = useToast();

  const [overview, setOverview] = useState<FinanceOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  // Active section tab
  const [activeTab, setActiveTab] = useState<TabKey>('requests');

  // Filters & Search
  const [requestsFilter, setRequestsFilter] = useState<'all' | 'pending' | 'decided'>('pending');
  const [transactionsFilter, setTransactionsFilter] = useState<'all' | 'stripe' | 'manual'>('all');
  const [documentsFilter, setDocumentsFilter] = useState<'all' | 'receipt' | 'invoice'>('all');
  const [search, setSearch] = useState('');

  // Synchronisation depuis l'URL (?tab=transactions, ?tab=requests, ?filter=pending, etc.)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (tab === 'requests' || tab === 'transactions' || tab === 'documents' || tab === 'history') {
        setActiveTab(tab);
      }
      const filter = params.get('filter');
      if (filter === 'all' || filter === 'pending' || filter === 'decided') {
        setRequestsFilter(filter);
      }
    };

    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  // Modals state
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);
  const [approvingReal, setApprovingReal] = useState<AgencyPaymentRequest | null>(null);
  const [realMethod, setRealMethod] = useState<'cash' | 'card' | 'bank_transfer'>('cash');
  const [realNotes, setRealNotes] = useState('');

  const [rejectingRequest, setRejectingRequest] = useState<AgencyPaymentRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // ============================================================
  // LOAD DATA
  // ============================================================

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/operations/finance/overview', { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorOf(res));
      const data: FinanceOverviewData = await res.json();
      setOverview(data);
      setError('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unable to load finance data';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/operations/finance/overview', { cache: 'no-store' });
        if (!res.ok) throw new Error(await errorOf(res));
        const data: FinanceOverviewData = await res.json();
        if (!cancelled) {
          setOverview(data);
          setError('');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Unable to load finance data');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ============================================================
  // ACTIONS: APPROVE & REJECT
  // ============================================================

  async function submitApproveReal(e: FormEvent) {
    e.preventDefault();
    if (!approvingReal) return;

    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch(
        `/api/admin/agency-payments/${encodeURIComponent(approvingReal.reservationNumber)}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: realMethod,
            notes: realNotes.trim() || undefined,
          }),
        },
      );
      if (!res.ok) throw new Error(await errorOf(res));
      const result = await res.json();
      toast.success(result.message || 'Real manual payment recorded and confirmed.', 'Manual Payment Approved');
      setSuccess(`Verified manual payment recorded for ${approvingReal.reservationNumber}.`);
      setApprovingReal(null);
      setRealNotes('');
      await loadOverview();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to approve real payment';
      setError(msg);
      toast.error(msg, 'Approval Error');
    } finally {
      setBusy(false);
    }
  }

  async function submitReject(e: FormEvent) {
    e.preventDefault();
    if (!rejectingRequest) return;
    const reason = rejectReason.trim();
    if (!reason) {
      toast.error('A rejection reason is mandatory.', 'Validation Error');
      return;
    }

    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch(
        `/api/admin/agency-payments/${encodeURIComponent(rejectingRequest.reservationNumber)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      );
      if (!res.ok) throw new Error(await errorOf(res));
      const result = await res.json();
      toast.success(result.message || 'Request rejected. Customer notified.', 'Agency Payment');
      setSuccess(`Agency payment request for ${rejectingRequest.reservationNumber} rejected.`);
      setRejectingRequest(null);
      setRejectReason('');
      await loadOverview();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to reject agency payment';
      setError(msg);
      toast.error(msg, 'Rejection Error');
    } finally {
      setBusy(false);
    }
  }

  // ============================================================
  // DOCUMENT DOWNLOAD
  // ============================================================

  async function handleDownloadDocument(url: string, filename: string) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(await errorOf(res));
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to download document';
      toast.error(msg, 'Download Error');
    }
  }

  // ============================================================
  // FILTERED LISTS
  // ============================================================

  const query = search.trim().toLowerCase();

  // A. Filtered Requests
  const filteredRequests = useMemo(() => {
    if (!overview?.requests) return [];
    return overview.requests.filter((r) => {
      if (requestsFilter === 'pending' && r.agencyPaymentStatus !== 'agency_payment_requested') return false;
      if (requestsFilter === 'decided' && r.agencyPaymentStatus === 'agency_payment_requested') return false;
      if (!query) return true;
      return (
        r.reservationNumber.toLowerCase().includes(query) ||
        r.customerName.toLowerCase().includes(query) ||
        r.customerEmail.toLowerCase().includes(query) ||
        r.vehicleName.toLowerCase().includes(query) ||
        (r.agencyPaymentAgencyName?.toLowerCase() || '').includes(query)
      );
    });
  }, [overview, requestsFilter, query]);

  // B. Filtered Transactions
  const filteredTransactions = useMemo(() => {
    if (!overview?.transactions) return [];
    return overview.transactions.filter((tx) => {
      if (transactionsFilter === 'stripe' && tx.integrityStatus !== 'STRIPE_VERIFIED') return false;
      if (transactionsFilter === 'manual' && tx.integrityStatus !== 'MANUAL_VERIFIED') return false;
      if (!query) return true;
      return (
        (tx.reference?.toLowerCase() || '').includes(query) ||
        tx.reservationNumber.toLowerCase().includes(query) ||
        tx.customerName.toLowerCase().includes(query) ||
        tx.customerEmail.toLowerCase().includes(query) ||
        tx.vehicleName.toLowerCase().includes(query)
      );
    });
  }, [overview, transactionsFilter, query]);

  // C. Filtered Documents
  const filteredDocuments = useMemo(() => {
    if (!overview?.documents) return [];
    return overview.documents.filter((doc) => {
      if (documentsFilter === 'receipt' && doc.documentType !== 'receipt') return false;
      if (documentsFilter === 'invoice' && doc.documentType !== 'invoice') return false;
      if (!query) return true;
      return (
        doc.documentNumber.toLowerCase().includes(query) ||
        doc.reservationNumber.toLowerCase().includes(query) ||
        doc.customerName.toLowerCase().includes(query)
      );
    });
  }, [overview, documentsFilter, query]);

  // D. Filtered History
  const filteredHistory = useMemo(() => {
    if (!overview?.history) return [];
    return overview.history.filter((ev) => {
      if (!query) return true;
      return (
        ev.title.toLowerCase().includes(query) ||
        ev.reservationNumber.toLowerCase().includes(query) ||
        ev.customerName.toLowerCase().includes(query) ||
        ev.reference.toLowerCase().includes(query) ||
        ev.actor.toLowerCase().includes(query) ||
        ev.notes.toLowerCase().includes(query)
      );
    });
  }, [overview, query]);

  const stats = overview?.stats;
  const pendingCount = stats?.pendingRequestsCount ?? 0;

  return (
    <div className={styles.page}>
      {/* ========================================================
          1. HEADER & INTRO
          ======================================================== */}
      <header className={styles.hero}>
        <h1 className={styles.title}>
          Payments &amp; <span>Reconciliation</span>
        </h1>
      </header>

      {/* ========================================================
          NOTIFICATIONS / ALERTS
          ======================================================== */}
      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" className={styles.alertClose} onClick={() => setError('')}>
            ✕
          </button>
        </div>
      )}

      {success && (
        <div className={styles.success} role="status">
          <span>{success}</span>
          <button type="button" className={styles.alertClose} onClick={() => setSuccess('')}>
            ✕
          </button>
        </div>
      )}

      {/* ========================================================
          2. KPI / METRICS RIBBON
          ======================================================== */}
      <section className={styles.kpiRibbon}>
        <div className={`${styles.kpiCard} ${styles.kpiCardHighlight}`}>
          <span className={styles.kpiLabel}>Total Verified Revenue</span>
          <span className={`${styles.kpiValue} ${styles.kpiValueGold}`}>
            {euro(stats?.totalVerifiedRevenueEur || 0)}
          </span>
          <span className={styles.kpiSub}>Stripe gateway + verified counter payments</span>
        </div>

        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>Verified Stripe Gateway</span>
          <span className={styles.kpiValue}>
            {euro(stats?.verifiedStripeEur || 0)}
          </span>
          <span className={styles.kpiSub}>
            {stats?.verifiedStripeCount || 0} external card settlements
          </span>
        </div>

        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>Manual Agency Payments</span>
          <span className={styles.kpiValue}>
            {euro(stats?.verifiedManualEur || 0)}
          </span>
          <span className={styles.kpiSub}>
            {stats?.verifiedManualCount || 0} physically verified at agency counter
          </span>
        </div>

        <div className={`${styles.kpiCard} ${pendingCount > 0 ? styles.kpiCardWarning : ''}`}>
          <span className={styles.kpiLabel}>
            Agency Requests
            {pendingCount > 0 && <span className={styles.badgePending}>{pendingCount} PENDING</span>}
          </span>
          <span className={styles.kpiValue}>{pendingCount}</span>
          <span className={styles.kpiSub}>
            {pendingCount > 0 ? 'Awaiting administrative verification' : 'All requests decided'}
          </span>
        </div>
      </section>

      {/* ========================================================
          3. TABS NAVIGATION
          ======================================================== */}
      <nav className={styles.tabsNav} aria-label="Finance sections">
        <button
          type="button"
          onClick={() => {
            setActiveTab('requests');
            setSearch('');
          }}
          className={`${styles.tabBtn} ${activeTab === 'requests' ? styles.tabBtnActive : ''}`}
        >
          <span>Payment Requests</span>
          {pendingCount > 0 ? (
            <span className={styles.badgePending}>{pendingCount}</span>
          ) : (
            <span className={styles.badgeCount}>{overview?.requests?.length || 0}</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('transactions');
            setSearch('');
          }}
          className={`${styles.tabBtn} ${activeTab === 'transactions' ? styles.tabBtnActive : ''}`}
        >
          <span>Transactions Ledger</span>
          <span className={styles.badgeCount}>{overview?.transactions?.length || 0}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('documents');
            setSearch('');
          }}
          className={`${styles.tabBtn} ${activeTab === 'documents' ? styles.tabBtnActive : ''}`}
        >
          <span>Receipts & Invoices</span>
          <span className={styles.badgeCount}>{overview?.documents?.length || 0}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('history');
            setSearch('');
          }}
          className={`${styles.tabBtn} ${activeTab === 'history' ? styles.tabBtnActive : ''}`}
        >
          <span>Payment History</span>
          <span className={styles.badgeCount}>{overview?.history?.length || 0}</span>
        </button>
      </nav>

      {/* ========================================================
          LOADING STATE
          ======================================================== */}
      {loading && !overview && (
        <div className={styles.loadingSpinner}>
          <span>Loading financial records...</span>
        </div>
      )}

      {/* ========================================================
          SECTION A: PAYMENT REQUESTS
          ======================================================== */}
      {activeTab === 'requests' && (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitleGroup}>
              <h2 className={styles.panelTitle}>Pay at Agency Requests</h2>
              <p className={styles.panelSubtitle}>
                Customer booking requests selecting in-person counter settlement. Approve via verified physical payment attestation, or reject with reason.
              </p>
            </div>

            <div className={styles.filterBar}>
              <div className={styles.searchBox}>
                <input
                  type="text"
                  placeholder="Search reservation, customer, agency..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={styles.searchInput}
                />
              </div>

              <div className={styles.pillGroup}>
                <button
                  type="button"
                  onClick={() => setRequestsFilter('pending')}
                  className={`${styles.pillBtn} ${requestsFilter === 'pending' ? styles.pillBtnActive : ''}`}
                >
                  Pending Action ({overview?.requests?.filter((r) => r.agencyPaymentStatus === 'agency_payment_requested').length || 0})
                </button>
                <button
                  type="button"
                  onClick={() => setRequestsFilter('decided')}
                  className={`${styles.pillBtn} ${requestsFilter === 'decided' ? styles.pillBtnActive : ''}`}
                >
                  Decision History ({overview?.requests?.filter((r) => r.agencyPaymentStatus !== 'agency_payment_requested').length || 0})
                </button>
                <button
                  type="button"
                  onClick={() => setRequestsFilter('all')}
                  className={`${styles.pillBtn} ${requestsFilter === 'all' ? styles.pillBtnActive : ''}`}
                >
                  All Requests ({overview?.requests?.length || 0})
                </button>
              </div>
            </div>
          </div>

          {/* Desktop Table View — 5 Clean Consolidated Columns */}
          <div className={`${styles.desktopTable} ${styles.tableWrapper}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thAgencyRes}>Reservation &amp; Date</th>
                  <th className={styles.thAgencyCust}>Customer &amp; Agency</th>
                  <th className={styles.thAgencyVeh}>Vehicle &amp; Purpose</th>
                  <th className={styles.thAgencyFin}>Amounts &amp; Status</th>
                  <th className={styles.thAgencyAct}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRequests.map((req) => {
                  const isPending = req.agencyPaymentStatus === 'agency_payment_requested';
                  const isApproved = req.agencyPaymentStatus === 'approved';
                  const isRejected = req.agencyPaymentStatus === 'rejected';

                  return (
                    <tr key={req.id}>
                      <td>
                        <span className={styles.monoRef}>{req.reservationNumber}</span>
                        <div className={styles.secondaryText}>
                          {formatDate(req.agencyPaymentRequestedAt || req.createdAt)}
                        </div>
                      </td>
                      <td>
                        <div className={styles.primaryText}>{req.customerName}</div>
                        <div className={styles.secondaryText}>{req.customerEmail}</div>
                        <div className={styles.secondaryText} style={{ marginTop: '2px', opacity: 0.85 }}>
                          📍 {req.agencyPaymentAgencyName || 'Agency Counter'}
                        </div>
                      </td>
                      <td>
                        <div className={styles.primaryText}>{req.vehicleName}</div>
                        <span className={styles.monoRef}>{req.licensePlate}</span>
                        <div className={styles.secondaryText} style={{ marginTop: '2px' }}>
                          Settlement Balance
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span className={`${styles.amountStrong} ${styles.kpiValueGold}`}>
                            {euro(req.totalDue)}
                          </span>
                          {isPending && (
                            <span className={`${styles.badge} ${styles.badgePendingState}`}>
                              Pending
                            </span>
                          )}
                          {isApproved && (
                            <span className={`${styles.badge} ${styles.badgeManual}`}>
                              Approved
                            </span>
                          )}
                          {isRejected && (
                            <span className={`${styles.badge} ${styles.badgeRejected}`}>
                              Rejected
                            </span>
                          )}
                        </div>
                        <div className={styles.secondaryText} style={{ marginTop: '3px' }}>
                          Rental: {euro(req.totalAmount)} · Dep: {euro(req.depositAmount)}
                        </div>
                        {req.paymentDeadlineAt && (
                          <div className={styles.secondaryText} style={{ fontSize: '10.5px', color: '#b45309', marginTop: '1px' }}>
                            Deadline: {formatDate(req.paymentDeadlineAt)}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {isPending ? (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                            <button
                              type="button"
                              onClick={() => {
                                setApprovingReal(req);
                                setRealMethod('cash');
                                setRealNotes('');
                              }}
                              disabled={busy}
                              className={styles.btnPrimary}
                              style={{ width: '100%', maxWidth: '140px', padding: '6px 10px', fontSize: '11.5px', textAlign: 'center' }}
                              title="Officially approve with collected payment attestation"
                            >
                              Review &amp; Settle →
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRejectingRequest(req);
                                setRejectReason('');
                              }}
                              disabled={busy}
                              className={styles.btnLinkDanger}
                              title="Reject request with mandatory reason"
                            >
                              Reject Request
                            </button>
                          </div>
                        ) : (
                          <div className={styles.secondaryText} style={{ textAlign: 'right' }}>
                            ✓ {req.agencyPaymentDecisionNotes || 'Decision recorded'}
                            {req.decidedByName && ` (${req.decidedByName})`}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {filteredRequests.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className={styles.emptyState}>
                        <span className={styles.emptyTitle}>No agency payment requests found</span>
                        <span>There are no requests matching the selected filter criteria.</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile & Tablet Responsive Cards */}
          <div className={styles.mobileCardView}>
            {filteredRequests.map((req) => {
              const isPending = req.agencyPaymentStatus === 'agency_payment_requested';
              const isApproved = req.agencyPaymentStatus === 'approved';
              const isRejected = req.agencyPaymentStatus === 'rejected';

              return (
                <div key={req.id} className={styles.recordCard}>
                  <div className={styles.recordCardHeader}>
                    <div className={styles.recordCardHeaderLeft}>
                      <span className={styles.monoRef}>{req.reservationNumber}</span>
                      <span className={styles.secondaryText}>
                        {formatDate(req.agencyPaymentRequestedAt || req.createdAt)}
                      </span>
                    </div>
                    <div>
                      {isPending && <span className={`${styles.badge} ${styles.badgePendingState}`}>Pending</span>}
                      {isApproved && <span className={`${styles.badge} ${styles.badgeManual}`}>Approved</span>}
                      {isRejected && <span className={`${styles.badge} ${styles.badgeRejected}`}>Rejected</span>}
                    </div>
                  </div>

                  <div className={styles.recordCardGrid}>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Customer</span>
                      <span className={styles.primaryText}>{req.customerName}</span>
                      <span className={styles.secondaryText}>{req.customerEmail}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Vehicle</span>
                      <span className={styles.primaryText}>{req.vehicleName}</span>
                      <span className={styles.monoRef}>{req.licensePlate}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Agency</span>
                      <span>{req.agencyPaymentAgencyName || 'Agency Counter'}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Total Due</span>
                      <span className={`${styles.amountStrong} ${styles.kpiValueGold}`}>{euro(req.totalDue)}</span>
                      <span className={styles.secondaryText}>Rental: {euro(req.totalAmount)} · Dep: {euro(req.depositAmount)}</span>
                    </div>
                  </div>

                  {isPending && (
                    <div className={styles.recordCardActions}>
                      <button
                        type="button"
                        onClick={() => {
                          setApprovingReal(req);
                          setRealMethod('cash');
                          setRealNotes('');
                        }}
                        disabled={busy}
                        className={styles.btnPrimary}
                      >
                        Approve Payment
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRejectingRequest(req);
                          setRejectReason('');
                        }}
                        disabled={busy}
                        className={styles.btnDanger}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                  {!isPending && (
                    <div className={styles.secondaryText}>
                      {req.agencyPaymentDecisionNotes || 'Decision recorded'}
                      {req.decidedByName && ` by ${req.decidedByName}`}
                    </div>
                  )}
                </div>
              );
            })}
            {filteredRequests.length === 0 && (
              <div className={styles.emptyState}>
                <span className={styles.emptyTitle}>No agency payment requests found</span>
                <span>There are no requests matching the selected filter criteria.</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ========================================================
          SECTION B: TRANSACTIONS LEDGER
          ======================================================== */}
      {activeTab === 'transactions' && (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitleGroup}>
              <h2 className={styles.panelTitle}>Transactions Ledger</h2>
              <p className={styles.panelSubtitle}>
                Comprehensive financial ledger separating Verified Stripe and Manual Agency entries.
              </p>
            </div>

            <div className={styles.filterBar}>
              <div className={styles.searchBox}>
                <input
                  type="text"
                  placeholder="Search reference, reservation, customer..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={styles.searchInput}
                />
              </div>

              <div className={styles.pillGroup}>
                <button
                  type="button"
                  onClick={() => setTransactionsFilter('all')}
                  className={`${styles.pillBtn} ${transactionsFilter === 'all' ? styles.pillBtnActive : ''}`}
                >
                  All ({overview?.transactions?.length || 0})
                </button>
                <button
                  type="button"
                  onClick={() => setTransactionsFilter('stripe')}
                  className={`${styles.pillBtn} ${transactionsFilter === 'stripe' ? styles.pillBtnActive : ''}`}
                >
                  Stripe Verified ({overview?.transactions?.filter((t) => t.integrityStatus === 'STRIPE_VERIFIED').length || 0})
                </button>
                <button
                  type="button"
                  onClick={() => setTransactionsFilter('manual')}
                  className={`${styles.pillBtn} ${transactionsFilter === 'manual' ? styles.pillBtnActive : ''}`}
                >
                  Manual Verified ({overview?.transactions?.filter((t) => t.integrityStatus === 'MANUAL_VERIFIED').length || 0})
                </button>
              </div>
            </div>
          </div>

          {/* Desktop Table View — Recommended 5-Group Consolidated Architecture */}
          <div className={`${styles.desktopTable} ${styles.tableWrapper}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thTxRef}>Transaction</th>
                  <th className={styles.thTxResCust}>Customer / Booking</th>
                  <th className={styles.thTxType}>Financial Details</th>
                  <th className={styles.thTxInteg}>Verification</th>
                  <th className={styles.thTxAct}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransactions.map((tx) => {
                  const isExpanded = expandedTxId === tx.id;
                  const typeLabel = tx.type === 'rental_payment'
                    ? 'Rental Fee'
                    : tx.type === 'deposit_payment'
                    ? 'Security Deposit Hold'
                    : tx.type === 'charge_payment'
                    ? 'Additional Charge'
                    : 'Refund';

                  return (
                    <Fragment key={tx.id}>
                      <tr
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandedTxId(isExpanded ? null : tx.id)}
                      >
                        {/* 1. Transaction */}
                        <td>
                          <span className={styles.monoRef} title={tx.reference || tx.id}>
                            {tx.reference || '—'}
                          </span>
                          <div className={styles.secondaryText}>{formatDate(tx.paidAt)}</div>
                        </td>

                        {/* 2. Customer / Booking */}
                        <td>
                          <div className={styles.primaryText}>{tx.customerName}</div>
                          <span className={styles.monoRef}>#{tx.reservationNumber}</span>
                          <div className={styles.secondaryText}>{tx.customerEmail}</div>
                        </td>

                        {/* 3. Financial Details */}
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                            <span className={styles.primaryText}>{typeLabel}</span>
                            <span className={`${styles.amountStrong} ${tx.integrityStatus !== 'FAILED_REJECTED' ? styles.kpiValueGold : ''}`}>
                              {euro(tx.amount)}
                            </span>
                          </div>
                          <div className={styles.secondaryText}>
                            Rental: {euro(tx.rentalAmount)} · Dep: {euro(tx.depositAmount)}
                          </div>
                        </td>

                        {/* 4. Verification */}
                        <td>
                          {tx.integrityStatus === 'STRIPE_VERIFIED' && (
                            <span className={`${styles.badge} ${styles.badgeStripe}`}>
                              Stripe Verified
                            </span>
                          )}
                          {tx.integrityStatus === 'MANUAL_VERIFIED' && (
                            <span className={`${styles.badge} ${styles.badgeManual}`}>
                              Manual Verified
                            </span>
                          )}
                          {tx.integrityStatus === 'FAILED_REJECTED' && (
                            <span className={`${styles.badge} ${styles.badgeRejected}`}>
                              Rejected / Excluded
                            </span>
                          )}
                          <div className={styles.secondaryText} style={{ marginTop: '2px' }}>
                            Channel: {tx.method.toUpperCase()}
                          </div>
                        </td>

                        {/* 5. Action */}
                        <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setExpandedTxId(isExpanded ? null : tx.id)}
                            className={styles.inspectBtn}
                            style={{ minWidth: '110px', padding: '7px 12px', fontSize: '11.5px', textAlign: 'center' }}
                            title="Toggle transaction dossier"
                          >
                            View Details {isExpanded ? '▲' : '▾'}
                          </button>
                        </td>
                      </tr>

                      {/* Expandable Transaction Details Panel */}
                      {isExpanded && (
                        <tr className={styles.expandedRow}>
                          <td colSpan={5} className={styles.expandedCell}>
                            <div className={styles.expandedGrid}>
                              <div className={styles.expandedItem}>
                                <span className={styles.expandedLabel}>Full Transaction Reference</span>
                                <span className={styles.monoRefFull}>{tx.reference || tx.id}</span>
                              </div>
                              <div className={styles.expandedItem}>
                                <span className={styles.expandedLabel}>Customer &amp; Booking</span>
                                <span>{tx.customerName} ({tx.customerEmail})</span>
                                <span className={styles.monoRef}>Reservation #{tx.reservationNumber}</span>
                              </div>
                              <div className={styles.expandedItem}>
                                <span className={styles.expandedLabel}>Audit Notes</span>
                                <span>{tx.notes || 'Automated payment processing · Verified'}</span>
                              </div>
                              <div className={styles.expandedItem}>
                                <span className={styles.expandedLabel}>Classification &amp; Receipt</span>
                                <span>{tx.integrityStatus} · {tx.method.toUpperCase()}</span>
                                {tx.integrityStatus !== 'FAILED_REJECTED' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleDownloadDocument(
                                        `/api/admin/operations/finance/payments/${tx.id}/receipt`,
                                        `receipt-${tx.reference || tx.id.slice(0, 8)}.pdf`,
                                      )
                                    }
                                    className={styles.btnSecondary}
                                    style={{ alignSelf: 'flex-start', marginTop: '6px' }}
                                  >
                                    Download PDF Receipt ↓
                                  </button>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}

                {filteredTransactions.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className={styles.emptyState}>
                        <span className={styles.emptyTitle}>No transactions found</span>
                        <span>There are no ledger entries matching your query.</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile & Tablet Responsive Cards */}
          <div className={styles.mobileCardView}>
            {filteredTransactions.map((tx) => {
              const typeLabel = tx.type === 'rental_payment'
                ? 'Rental Fee'
                : tx.type === 'deposit_payment'
                ? 'Security Deposit Hold'
                : tx.type === 'charge_payment'
                ? 'Additional Charge'
                : 'Refund';

              return (
                <div key={tx.id} className={styles.recordCard}>
                  <div className={styles.recordCardHeader}>
                    <div className={styles.recordCardHeaderLeft}>
                      <span className={styles.primaryText}>{typeLabel}</span>
                      <span className={styles.secondaryText}>{formatDate(tx.paidAt)}</span>
                    </div>
                    <div>
                      {tx.integrityStatus === 'STRIPE_VERIFIED' && (
                        <span className={`${styles.badge} ${styles.badgeStripe}`}>Stripe</span>
                      )}
                      {tx.integrityStatus === 'MANUAL_VERIFIED' && (
                        <span className={`${styles.badge} ${styles.badgeManual}`}>Manual</span>
                      )}
                      {tx.integrityStatus === 'FAILED_REJECTED' && (
                        <span className={`${styles.badge} ${styles.badgeRejected}`}>Rejected</span>
                      )}
                    </div>
                  </div>

                  <div className={styles.recordCardGrid}>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Reference</span>
                      <span className={styles.monoRefFull}>{tx.reference || tx.id}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Reservation &amp; Customer</span>
                      <span className={styles.monoRef}>{tx.reservationNumber}</span>
                      <span>{tx.customerName}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Method</span>
                      <span>{tx.method.toUpperCase()}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Amount</span>
                      <span className={`${styles.amountStrong} ${styles.kpiValueGold}`}>{euro(tx.amount)}</span>
                      <span className={styles.secondaryText}>Rental: {euro(tx.rentalAmount)} · Dep: {euro(tx.depositAmount)}</span>
                    </div>
                  </div>

                  {tx.integrityStatus !== 'FAILED_REJECTED' && (
                    <div className={styles.recordCardActions}>
                      <button
                        type="button"
                        onClick={() =>
                          handleDownloadDocument(
                            `/api/admin/operations/finance/payments/${tx.id}/receipt`,
                            `receipt-${tx.reference || tx.id.slice(0, 8)}.pdf`,
                          )
                        }
                        className={styles.btnSecondary}
                      >
                        Download PDF Receipt ↓
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredTransactions.length === 0 && (
              <div className={styles.emptyState}>
                <span className={styles.emptyTitle}>No transactions found</span>
                <span>There are no ledger entries matching your query.</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ========================================================
          SECTION C: RECEIPTS & INVOICES
          ======================================================== */}
      {activeTab === 'documents' && (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitleGroup}>
              <h2 className={styles.panelTitle}>Official Documents & Invoices</h2>
              <p className={styles.panelSubtitle}>
                Official payment receipts and legal fiscal invoices issued for completed and confirmed rentals.
              </p>
            </div>

            <div className={styles.filterBar}>
              <div className={styles.searchBox}>
                <input
                  type="text"
                  placeholder="Search document number, reservation..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={styles.searchInput}
                />
              </div>

              <div className={styles.pillGroup}>
                <button
                  type="button"
                  onClick={() => setDocumentsFilter('all')}
                  className={`${styles.pillBtn} ${documentsFilter === 'all' ? styles.pillBtnActive : ''}`}
                >
                  All Documents ({overview?.documents?.length || 0})
                </button>
                <button
                  type="button"
                  onClick={() => setDocumentsFilter('receipt')}
                  className={`${styles.pillBtn} ${documentsFilter === 'receipt' ? styles.pillBtnActive : ''}`}
                >
                  Receipts ({overview?.documents?.filter((d) => d.documentType === 'receipt').length || 0})
                </button>
                <button
                  type="button"
                  onClick={() => setDocumentsFilter('invoice')}
                  className={`${styles.pillBtn} ${documentsFilter === 'invoice' ? styles.pillBtnActive : ''}`}
                >
                  Invoices ({overview?.documents?.filter((d) => d.documentType === 'invoice').length || 0})
                </button>
              </div>
            </div>
          </div>

          {/* Desktop Table View */}
          <div className={`${styles.desktopTable} ${styles.tableWrapper}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thDocNum}>Document &amp; Type</th>
                  <th className={styles.thDocResCust}>Reservation &amp; Customer</th>
                  <th className={styles.thDocDate}>Issue Date</th>
                  <th className={styles.thDocAmt}>Amount &amp; Status</th>
                  <th className={styles.thDocAct}>Download</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.map((doc) => {
                  return (
                    <tr key={`${doc.documentType}-${doc.id}`}>
                      <td>
                        <span className={styles.monoRef}>{doc.documentNumber}</span>
                        <div className={styles.primaryText}>
                          {doc.documentType === 'receipt' ? 'Payment Receipt' : 'Fiscal Invoice'}
                        </div>
                      </td>
                      <td>
                        <span className={styles.monoRef}>{doc.reservationNumber}</span>
                        <div className={styles.secondaryText}>{doc.customerName}</div>
                      </td>
                      <td>
                        <span>{formatDate(doc.issuedAt)}</span>
                      </td>
                      <td>
                        <span className={styles.amountStrong}>{euro(doc.amount)}</span>
                        <div>
                          <span className={`${styles.badge} ${styles.badgeStripe}`}>
                            Verified Fiscal
                          </span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          onClick={() =>
                            handleDownloadDocument(
                              doc.downloadUrl,
                              `${doc.documentType}-${doc.documentNumber}.pdf`,
                            )
                          }
                          className={styles.btnSecondary}
                        >
                          Download PDF ↓
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {filteredDocuments.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className={styles.emptyState}>
                        <span className={styles.emptyTitle}>No documents found</span>
                        <span>There are no documents matching your query.</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile & Tablet Responsive Cards */}
          <div className={styles.mobileCardView}>
            {filteredDocuments.map((doc) => {
              return (
                <div key={`${doc.documentType}-${doc.id}`} className={styles.recordCard}>
                  <div className={styles.recordCardHeader}>
                    <div className={styles.recordCardHeaderLeft}>
                      <span className={styles.primaryText}>
                        {doc.documentType === 'receipt' ? 'Payment Receipt' : 'Fiscal Invoice'}
                      </span>
                      <span className={styles.monoRef}>{doc.documentNumber}</span>
                    </div>
                    <div>
                      <span className={`${styles.amountStrong} ${styles.kpiValueGold}`}>{euro(doc.amount)}</span>
                    </div>
                  </div>

                  <div className={styles.recordCardGrid}>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Reservation</span>
                      <span className={styles.monoRef}>{doc.reservationNumber}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Customer</span>
                      <span>{doc.customerName}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Issue Date</span>
                      <span>{formatDate(doc.issuedAt)}</span>
                    </div>
                    <div className={styles.recordCardItem}>
                      <span className={styles.recordCardItemLabel}>Status</span>
                      <span className={`${styles.badge} ${styles.badgeStripe}`}>Verified Fiscal</span>
                    </div>
                  </div>

                  <div className={styles.recordCardActions}>
                    <button
                      type="button"
                      onClick={() =>
                        handleDownloadDocument(
                          doc.downloadUrl,
                          `${doc.documentType}-${doc.documentNumber}.pdf`,
                        )
                      }
                      className={styles.btnSecondary}
                    >
                      Download PDF ↓
                    </button>
                  </div>
                </div>
              );
            })}
            {filteredDocuments.length === 0 && (
              <div className={styles.emptyState}>
                <span className={styles.emptyTitle}>No documents found</span>
                <span>There are no documents matching your query.</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ========================================================
          SECTION D: PAYMENT HISTORY & AUDIT TRAIL
          ======================================================== */}
      {activeTab === 'history' && (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitleGroup}>
              <h2 className={styles.panelTitle}>Payment History & Audit Trail</h2>
              <p className={styles.panelSubtitle}>
                Immutable chronological log of payment requests, administrative decisions, gateway settlements and refund events.
              </p>
            </div>

            <div className={styles.filterBar}>
              <div className={styles.searchBox}>
                <input
                  type="text"
                  placeholder="Filter payment events..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={styles.searchInput}
                />
              </div>
            </div>
          </div>

          <div className={styles.historyList}>
            {filteredHistory.map((ev) => {
              let badgeClass = styles.badgeStripe;
              if (ev.badge === 'MANUAL') badgeClass = styles.badgeManual;
              if (ev.badge === 'PENDING') badgeClass = styles.badgePendingState;
              if (ev.badge === 'REJECTED') badgeClass = styles.badgeRejected;

              return (
                <div key={ev.id} className={styles.historyItem}>
                  <div className={styles.historyTime}>{formatDate(ev.timestamp)}</div>

                  <div>
                    <span className={`${styles.badge} ${badgeClass}`}>{ev.badge}</span>
                  </div>

                  <div className={styles.historyContent}>
                    <div className={styles.historyTitle}>{ev.title}</div>
                    <div className={styles.historyMeta}>
                      <span className={styles.monoRef}>{ev.reservationNumber}</span> · {ev.customerName} · Ref:{' '}
                      <span className={styles.monoRef}>{ev.reference}</span> · Amount: {euro(ev.amount)}
                    </div>
                    {ev.notes && <div className={styles.secondaryText}>{ev.notes}</div>}
                  </div>

                  <div className={styles.historyActor}>
                    <span>By: {ev.actor}</span>
                  </div>
                </div>
              );
            })}

            {filteredHistory.length === 0 && (
              <div className={styles.emptyState}>
                <span className={styles.emptyTitle}>No history events found</span>
                <span>No audit events match your search.</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ========================================================
          MODAL: APPROVE REAL PAYMENT AT COUNTER
          ======================================================== */}
      {approvingReal && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalTitle}>Approve Real Counter Payment</h3>
                <div className={styles.modalSubtitle}>
                  Attestation of physical funds collected at agency counter for {approvingReal.reservationNumber}
                </div>
              </div>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setApprovingReal(null)}
                disabled={busy}
              >
                ✕
              </button>
            </div>

            <form onSubmit={submitApproveReal}>
              <div className={styles.modalBody}>
                <div className={styles.infoBox}>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Customer:</span>
                    <span className={styles.infoVal}>{approvingReal.customerName}</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Vehicle:</span>
                    <span className={styles.infoVal}>
                      {approvingReal.vehicleName} ({approvingReal.licensePlate})
                    </span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Rental Fee:</span>
                    <span className={styles.infoVal}>{euro(approvingReal.totalAmount)}</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Security Deposit:</span>
                    <span className={styles.infoVal}>{euro(approvingReal.depositAmount)}</span>
                  </div>
                  <div className={styles.infoRow} style={{ borderTop: '1px solid rgba(197, 168, 128, 0.2)', paddingTop: '6px' }}>
                    <span className={styles.infoLabel}>Total Collected:</span>
                    <span className={`${styles.infoVal} ${styles.kpiValueGold}`}>{euro(approvingReal.totalDue)}</span>
                  </div>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="attestedMethod" className={styles.formLabel}>
                    Payment Collection Method *
                  </label>
                  <select
                    id="attestedMethod"
                    value={realMethod}
                    onChange={(e) => setRealMethod(e.target.value as 'cash' | 'card' | 'bank_transfer')}
                    className={styles.formSelect}
                    required
                  >
                    <option value="cash">Cash (Collected & Audited at Counter)</option>
                    <option value="card">Physical POS Card Terminal (Electronic Receipt)</option>
                    <option value="bank_transfer">Wire / Direct Bank Transfer (Verified Received)</option>
                  </select>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="attestedNotes" className={styles.formLabel}>
                    Attestation Notes & Counter Reference
                  </label>
                  <textarea
                    id="attestedNotes"
                    placeholder="Enter cashier register receipt #, terminal auth code, or verification notes..."
                    value={realNotes}
                    onChange={(e) => setRealNotes(e.target.value)}
                    className={styles.formTextarea}
                  />
                </div>
              </div>

              <div className={styles.modalFooter}>
                <button
                  type="button"
                  onClick={() => setApprovingReal(null)}
                  disabled={busy}
                  className={styles.btnSecondary}
                >
                  Cancel
                </button>
                <button type="submit" disabled={busy} className={styles.btnPrimary}>
                  {busy ? 'Recording...' : 'Confirm Real Payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================
          MODAL: REJECT AGENCY PAYMENT REQUEST
          ======================================================== */}
      {rejectingRequest && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalTitle}>Reject Pay at Agency Request</h3>
                <div className={styles.modalSubtitle}>
                  Provide reason for declining counter payment for {rejectingRequest.reservationNumber}
                </div>
              </div>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setRejectingRequest(null)}
                disabled={busy}
              >
                ✕
              </button>
            </div>

            <form onSubmit={submitReject}>
              <div className={styles.modalBody}>
                <div className={styles.infoBox}>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Customer:</span>
                    <span className={styles.infoVal}>{rejectingRequest.customerName}</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>Amount Due:</span>
                    <span className={styles.infoVal}>{euro(rejectingRequest.totalDue)}</span>
                  </div>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="rejectReason" className={styles.formLabel}>
                    Rejection Reason (Mandatory - Notified to Customer) *
                  </label>
                  <textarea
                    id="rejectReason"
                    placeholder="e.g. Agency desk does not accept physical cash exceeding limits; please complete payment online via card..."
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    className={styles.formTextarea}
                    required
                  />
                </div>
              </div>

              <div className={styles.modalFooter}>
                <button
                  type="button"
                  onClick={() => setRejectingRequest(null)}
                  disabled={busy}
                  className={styles.btnSecondary}
                >
                  Cancel
                </button>
                <button type="submit" disabled={busy} className={styles.btnDanger}>
                  {busy ? 'Rejecting...' : 'Reject Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
