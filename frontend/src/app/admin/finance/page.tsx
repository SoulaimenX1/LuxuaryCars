'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import styles from './finance.module.css';
import { useConfirm } from '@/components/confirm-dialog';
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
  const confirm = useConfirm();
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

  // Modals state
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
        <div className={styles.eyebrow}>
          <span>Financial Operations & Ledger</span>
        </div>
        <h1 className={styles.title}>
          Payments & <span>Reconciliation</span>
        </h1>
        <p className={styles.intro}>
          Verified Stripe revenue, in-person manual counter approvals, development simulation records, official
          fiscal documents and payment audit trail.
        </p>
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

          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Reservation</th>
                  <th>Customer</th>
                  <th>Vehicle</th>
                  <th>Agency Counter</th>
                  <th>Rental Amount</th>
                  <th>Deposit Hold</th>
                  <th>Total Due</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
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
                      </td>
                      <td>
                        <div className={styles.primaryText}>{req.vehicleName}</div>
                        <span className={styles.monoRef}>{req.licensePlate}</span>
                      </td>
                      <td>
                        <div className={styles.primaryText}>{req.agencyPaymentAgencyName || 'Agency Counter'}</div>
                        {req.paymentDeadlineAt && (
                          <div className={styles.secondaryText}>
                            Deadline: {formatDate(req.paymentDeadlineAt)}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={styles.amountStrong}>{euro(req.totalAmount)}</span>
                      </td>
                      <td>
                        <span>{euro(req.depositAmount)}</span>
                        <div className={styles.secondaryText}>read-only hold</div>
                      </td>
                      <td>
                        <span className={`${styles.amountStrong} ${styles.kpiValueGold}`}>
                          {euro(req.totalDue)}
                        </span>
                      </td>
                      <td>
                        {isPending && (
                          <span className={`${styles.badge} ${styles.badgePendingState}`}>
                            Pending Decision
                          </span>
                        )}
                        {isApproved && (
                          <span className={`${styles.badge} ${styles.badgeManual}`}>
                            Payment Approved
                          </span>
                        )}
                        {isRejected && (
                          <span className={`${styles.badge} ${styles.badgeRejected}`}>
                            Rejected
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {isPending ? (
                          <div className={styles.actionGroup}>
                            <button
                              type="button"
                              onClick={() => {
                                setApprovingReal(req);
                                setRealMethod('cash');
                                setRealNotes('');
                              }}
                              disabled={busy}
                              className={styles.btnPrimary}
                              title="Officially approve with collected payment attestation"
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
                              title="Reject request with mandatory reason"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <div className={styles.secondaryText}>
                            {req.agencyPaymentDecisionNotes || 'Decision recorded'}
                            {req.decidedByName && ` by ${req.decidedByName}`}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {filteredRequests.length === 0 && (
                  <tr>
                    <td colSpan={9}>
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

          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date & Time</th>
                  <th>Transaction Reference</th>
                  <th>Reservation</th>
                  <th>Customer</th>
                  <th>Type</th>
                  <th>Method</th>
                  <th>Integrity Classification</th>
                  <th>Amount</th>
                  <th style={{ textAlign: 'right' }}>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransactions.map((tx) => {
                  return (
                    <tr key={tx.id}>
                      <td>
                        <div>{formatDate(tx.paidAt)}</div>
                      </td>
                      <td>
                        <span className={styles.monoRef}>{tx.reference || '—'}</span>
                        {tx.notes && <div className={styles.secondaryText}>{tx.notes}</div>}
                      </td>
                      <td>
                        <span className={styles.monoRef}>{tx.reservationNumber}</span>
                        <div className={styles.secondaryText}>
                          Rental: {euro(tx.rentalAmount)} · Dep: {euro(tx.depositAmount)}
                        </div>
                      </td>
                      <td>
                        <div className={styles.primaryText}>{tx.customerName}</div>
                        <div className={styles.secondaryText}>{tx.customerEmail}</div>
                      </td>
                      <td>
                        <span className={styles.primaryText}>
                          {tx.type === 'rental_payment'
                            ? 'Rental Fee'
                            : tx.type === 'deposit_payment'
                            ? 'Security Deposit Hold'
                            : tx.type === 'charge_payment'
                            ? 'Additional Charge'
                            : 'Refund'}
                        </span>
                      </td>
                      <td>
                        <span className={styles.monoRef}>{tx.method.toUpperCase()}</span>
                      </td>
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
                      </td>
                      <td>
                        <span className={`${styles.amountStrong} ${tx.integrityStatus !== 'FAILED_REJECTED' ? styles.kpiValueGold : ''}`}>
                          {euro(tx.amount)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {tx.integrityStatus !== 'FAILED_REJECTED' ? (
                          <button
                            type="button"
                            onClick={() =>
                              handleDownloadDocument(
                                `/api/admin/operations/finance/payments/${tx.id}/receipt`,
                                `receipt-${tx.reference || tx.id.slice(0, 8)}.pdf`,
                              )
                            }
                            className={styles.btnLink}
                          >
                            Receipt PDF ↗
                          </button>
                        ) : (
                          <span className={styles.secondaryText}>Excluded</span>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {filteredTransactions.length === 0 && (
                  <tr>
                    <td colSpan={9}>
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

          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Document Type</th>
                  <th>Document Number / Ref</th>
                  <th>Reservation</th>
                  <th>Customer</th>
                  <th>Issue Date</th>
                  <th>Amount</th>
                  <th>Document Status</th>
                  <th style={{ textAlign: 'right' }}>Download</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.map((doc) => {
                  return (
                    <tr key={`${doc.documentType}-${doc.id}`}>
                      <td>
                        <span className={styles.primaryText}>
                          {doc.documentType === 'receipt' ? 'Payment Receipt' : 'Fiscal Invoice'}
                        </span>
                      </td>
                      <td>
                        <span className={styles.monoRef}>{doc.documentNumber}</span>
                      </td>
                      <td>
                        <span className={styles.monoRef}>{doc.reservationNumber}</span>
                      </td>
                      <td>
                        <span>{doc.customerName}</span>
                      </td>
                      <td>
                        <span>{formatDate(doc.issuedAt)}</span>
                      </td>
                      <td>
                        <span className={styles.amountStrong}>{euro(doc.amount)}</span>
                      </td>
                      <td>
                        <span className={`${styles.badge} ${styles.badgeStripe}`}>
                          Verified Fiscal
                        </span>
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
                    <td colSpan={8}>
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
