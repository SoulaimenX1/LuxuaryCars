'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  Clock,
  Car,
  FileText,
  Search,
  X,
  RefreshCw,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Fuel,
  Gauge,
  CheckCircle,
  ArrowRight,
  ShieldCheck,
  PhoneCall,
  Sparkles,
} from 'lucide-react';

import styles from './rentals.module.css';
import RentalContractModal, {
  type RentalContractData,
} from '@/components/contract/RentalContractModal';
import { Price } from '@/components/currency-provider';

// ==========================================================
// DATA TYPES
// ==========================================================

interface RentalExtension {
  id: string;
  oldReturnAt: string;
  newReturnAt: string;
  createdAt: string;
}

interface CustomerRental {
  id: string;
  contractNumber: string;
  reservationNumber: string;
  vehicleId: string;
  vehicleName: string;
  brandName?: string;
  modelName?: string;
  licensePlate: string;
  status: 'active' | 'returned' | 'closed';
  startedAt: string;
  expectedReturnAt: string;
  returnedAt: string | null;
  pickupMileageKm: number | null;
  pickupFuelLevelPct: number | null;
  pickupCondition: string | null;
  isOverdue: boolean;
  extensions?: RentalExtension[];
  imageUrl?: string | null;
  pickupLocation?: string | null;
  dropoffLocation?: string | null;
  totalAmount?: string;
  depositAmount?: string;
  dailyPrice?: string;
  rentalDays?: number;
  customerName?: string;
  customerEmail?: string;
  invoiceNumber?: string | null;
}

interface CatalogVehicle {
  id: string;
  brandName: string;
  modelName: string;
  categoryName?: string;
  imageUrl?: string;
}

type Filter = 'all' | 'active' | 'overdue' | 'history';

function isCustomerRental(value: unknown): value is CustomerRental {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<CustomerRental>;
  return (
    typeof item.id === 'string' &&
    typeof item.contractNumber === 'string' &&
    typeof item.reservationNumber === 'string' &&
    typeof item.vehicleName === 'string' &&
    typeof item.status === 'string' &&
    ['active', 'returned', 'closed'].includes(item.status) &&
    typeof item.startedAt === 'string' &&
    typeof item.expectedReturnAt === 'string' &&
    typeof item.isOverdue === 'boolean'
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (data && typeof data === 'object' && 'message' in data) {
      const message = (data as { message: unknown }).message;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Preserve HTTP code
  }
  return `Unable to load rentals (HTTP ${response.status}).`;
}

// ==========================================================
// MY RENTALS PAGE COMPONENT
// ==========================================================

export default function MyRentalsPage() {
  const router = useRouter();

  const [rentals, setRentals] = useState<CustomerRental[]>([]);
  const [vehicleCatalog, setVehicleCatalog] = useState<Record<string, CatalogVehicle>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});

  // Contract Modal state
  const [activeContract, setActiveContract] = useState<RentalContractData | null>(null);

  // ========================================================
  // LOAD REAL RENTALS & CATALOG
  // ========================================================

  const loadRentals = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');

    try {
      // 1. Fetch user's rentals from backend
      const response = await fetch('/api/rentals/me', {
        cache: 'no-store',
        signal,
      });

      if (response.status === 401) {
        router.replace('/login');
        return;
      }
      if (response.status === 403) {
        router.replace('/account');
        return;
      }
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }

      const result: unknown = await response.json();
      if (!Array.isArray(result) || !result.every(isCustomerRental)) {
        throw new Error('Invalid rental history received.');
      }

      if (!signal?.aborted) {
        setRentals(result);
      }

      // 2. Fetch vehicle catalog for supplementary imagery
      try {
        const catResponse = await fetch('/api/vehicles/catalog', {
          cache: 'no-store',
          signal,
        });
        if (catResponse.ok) {
          const catData: unknown = await catResponse.json();
          if (Array.isArray(catData)) {
            const map: Record<string, CatalogVehicle> = {};
            for (const item of catData) {
              const v = item as CatalogVehicle;
              if (v.id) map[v.id] = v;
            }
            if (!signal?.aborted) setVehicleCatalog(map);
          }
        }
      } catch {
        // Non-blocking fallback
      }
    } catch (cause) {
      if (!signal?.aborted) {
        setError(cause instanceof Error ? cause.message : 'Unable to load rentals.');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const initialize = async () => {
      await loadRentals();
    };
    void initialize();
  }, [loadRentals]);

  // ========================================================
  // COUNTERS & FILTERING
  // ========================================================

  const counts = useMemo(() => {
    return {
      all: rentals.length,
      active: rentals.filter((r) => r.status === 'active').length,
      overdue: rentals.filter((r) => r.status === 'active' && r.isOverdue).length,
      history: rentals.filter((r) => r.status !== 'active').length,
    };
  }, [rentals]);

  const visible = useMemo(() => {
    return rentals.filter((r) => {
      if (filter === 'active' && r.status !== 'active') return false;
      if (filter === 'overdue' && !(r.status === 'active' && r.isOverdue)) return false;
      if (filter === 'history' && r.status === 'active') return false;

      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const contract = r.contractNumber.toLowerCase();
        const res = r.reservationNumber.toLowerCase();
        const vName = r.vehicleName.toLowerCase();
        const plate = r.licensePlate.toLowerCase();

        if (
          !contract.includes(query) &&
          !res.includes(query) &&
          !vName.includes(query) &&
          !plate.includes(query)
        ) {
          return false;
        }
      }

      return true;
    });
  }, [filter, rentals, searchQuery]);

  function toggleDetails(id: string) {
    setExpandedDetails((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }

  function handleOpenContract(rental: CustomerRental, vImg?: string | null) {
    const calculatedDays =
      rental.rentalDays ||
      Math.max(
        1,
        Math.round(
          (new Date(rental.expectedReturnAt).getTime() - new Date(rental.startedAt).getTime()) /
            (1000 * 60 * 60 * 24),
        ),
      );

    const calculatedDaily =
      rental.dailyPrice ||
      (rental.totalAmount
        ? (parseFloat(rental.totalAmount) / calculatedDays).toFixed(2)
        : '2400.00');

    setActiveContract({
      contractNumber: rental.contractNumber,
      reservationNumber: rental.reservationNumber,
      rentalId: rental.id,
      vehicleName: rental.vehicleName,
      brandName: rental.brandName,
      modelName: rental.modelName,
      licensePlate: rental.licensePlate,
      imageUrl: vImg,
      customerName: rental.customerName || 'Valued Client',
      customerEmail: rental.customerEmail,
      pickupAt: rental.startedAt,
      returnAt: rental.expectedReturnAt,
      pickupLocation: rental.pickupLocation,
      dropoffLocation: rental.dropoffLocation,
      rentalDays: calculatedDays,
      dailyPrice: calculatedDaily,
      totalAmount: rental.totalAmount || '7200.00',
      depositAmount: rental.depositAmount || '9000.00',
      paymentStatus:
        rental.status === 'active'
          ? 'Active & In Custody'
          : rental.status === 'returned'
          ? 'Vehicle Returned & Reconciled'
          : 'Rental Closed',
      invoiceNumber: rental.invoiceNumber,
    });
  }

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        {/* Top Navigation & Breadcrumb */}
        <div className={styles.topBar}>
          <Link href="/account" className={styles.backLink}>
            ← Back to Private Client Salon
          </Link>

          <div className={styles.topActions}>
            <Link href="/account/reservations" className={styles.reservationsCta}>
              <Calendar size={14} />
              My Reservations
            </Link>

            <button
              type="button"
              className={styles.refreshButton}
              title="Refresh rentals"
              disabled={loading}
              onClick={() => void loadRentals()}
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Page Header */}
        <header className={styles.header}>
          <div className={styles.eyebrow}>
            <Sparkles size={13} style={{ color: 'var(--champagne)' }} />
            VEHICLE CUSTODY &amp; FLEET DOSSIERS
          </div>
          <h1 className={styles.title}>My Rentals</h1>
          <p className={styles.subtitle}>
            Monitor your high-performance vehicle in active custody, inspect digital handover records,
            and download official countersigned contracts and commercial tax invoices.
          </p>
        </header>

        {/* Status Filter Cards */}
        <section className={styles.statusOverview} aria-label="Rental status filters">
          <button
            type="button"
            className={`${styles.statusCard} ${filter === 'all' ? styles.active : ''}`}
            onClick={() => setFilter('all')}
          >
            <div className={styles.statusCardHeader}>
              <span className={styles.statusCardLabel}>All Rentals</span>
              <Car size={16} className={styles.statusCardIcon} />
            </div>
            <span className={styles.statusCardCount}>{counts.all}</span>
          </button>

          <button
            type="button"
            className={`${styles.statusCard} ${styles.cardActive} ${filter === 'active' ? styles.active : ''}`}
            onClick={() => setFilter('active')}
          >
            <div className={styles.statusCardHeader}>
              <span className={styles.statusCardLabel}>Active in Custody</span>
              <span className={styles.statusPulsingDot} />
            </div>
            <span className={`${styles.statusCardCount} ${styles.goldText}`}>
              {counts.active}
            </span>
          </button>

          <button
            type="button"
            className={`${styles.statusCard} ${styles.cardOverdue} ${filter === 'overdue' ? styles.active : ''}`}
            onClick={() => setFilter('overdue')}
          >
            <div className={styles.statusCardHeader}>
              <span className={styles.statusCardLabel}>Overdue Alert</span>
              {counts.overdue > 0 && <AlertCircle size={15} style={{ color: '#ef4444' }} />}
            </div>
            <span
              className={styles.statusCardCount}
              style={{ color: counts.overdue > 0 ? '#ef4444' : 'inherit' }}
            >
              {counts.overdue}
            </span>
          </button>

          <button
            type="button"
            className={`${styles.statusCard} ${styles.cardHistory} ${filter === 'history' ? styles.active : ''}`}
            onClick={() => setFilter('history')}
          >
            <div className={styles.statusCardHeader}>
              <span className={styles.statusCardLabel}>Returned &amp; Settled</span>
              <CheckCircle size={15} style={{ color: '#10b981' }} />
            </div>
            <span className={`${styles.statusCardCount} ${styles.emeraldText}`}>
              {counts.history}
            </span>
          </button>
        </section>

        {/* Toolbar & Search */}
        <div className={styles.toolbar}>
          <div className={styles.searchBox}>
            <Search size={16} className={styles.searchIcon} />
            <input
              type="text"
              placeholder="Search by contract (CTR-), reservation (RES-), car brand or plate..."
              className={styles.searchInput}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className={styles.clearSearch}
                title="Clear search"
                onClick={() => setSearchQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className={styles.toolbarMeta}>
            <span>
              Displaying <strong>{visible.length}</strong> of {rentals.length} portfolio records
            </span>
          </div>
        </div>

        {/* Error Banner */}
        {error && (
          <div className={styles.errorBanner} role="alert">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <AlertCircle size={18} />
              <span>{error}</span>
            </div>
            <button
              type="button"
              className={styles.secondaryAction}
              onClick={() => void loadRentals()}
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading / Empty / List */}
        {loading ? (
          <div className={styles.loadingContainer}>
            <div className={styles.loadingSpinner} />
            <p className={styles.loadingText}>Accessing official fleet custody records…</p>
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.emptyCard}>
            <div className={styles.emptyIconCircle}>
              <Car size={36} className={styles.emptyIcon} />
            </div>
            <h2 className={styles.emptyTitle}>
              {rentals.length === 0
                ? 'No Active or Past Rentals on Record'
                : 'No Rentals Match the Active Filter'}
            </h2>
            <p className={styles.emptyText}>
              {rentals.length === 0
                ? 'When a reservation is confirmed and vehicle handover takes place at the showroom, your active custody dossier, inspection telemetry, and countersigned agreements will appear here.'
                : 'Try adjusting your search criteria or switching to "All Rentals" to view complete fleet history.'}
            </p>
            {rentals.length === 0 ? (
              <Link href="/account/reservations" className={styles.emptyCta}>
                View My Reservations <ArrowRight size={14} />
              </Link>
            ) : (
              <button
                type="button"
                className={styles.emptyCta}
                onClick={() => {
                  setFilter('all');
                  setSearchQuery('');
                }}
              >
                Reset Search Filters
              </button>
            )}
          </div>
        ) : (
          <div className={styles.list}>
            {visible.map((rental) => {
              const catVehicle = vehicleCatalog[rental.vehicleId];
              const vehicleImage = rental.imageUrl || catVehicle?.imageUrl || null;
              const brandName = rental.brandName || catVehicle?.brandName || 'Luxury Marques';
              const modelName = rental.modelName || catVehicle?.modelName || rental.vehicleName;
              const isDetailsOpen = Boolean(expandedDetails[rental.id]);

              // Determine Stepper step
              let step = 2; // Active In Custody
              if (rental.status === 'returned') step = 3;
              if (rental.status === 'closed') step = 4;

              return (
                <article key={rental.id} className={styles.card}>
                  <div className={styles.cardMain}>
                    {/* Media Column (Left / Top on Mobile) */}
                    <div className={styles.cardMedia}>
                      {vehicleImage ? (
                        <img
                          src={vehicleImage}
                          alt={rental.vehicleName}
                          className={styles.vehicleImage}
                          loading="lazy"
                        />
                      ) : (
                        <div className={styles.imageFallback}>
                          <Car size={54} style={{ color: 'var(--champagne)', opacity: 0.4 }} />
                        </div>
                      )}
                      <div className={styles.imageOverlay} />

                      {/* Top Badges */}
                      <div className={styles.mediaTop}>
                        <div className={styles.contractBadge}>
                          <span>{rental.contractNumber}</span>
                        </div>

                        <span
                          className={`${styles.statusPill} ${
                            rental.status === 'active' && rental.isOverdue
                              ? styles.statusOverdue
                              : styles[`status_${rental.status}`] || styles.status_active
                          }`}
                        >
                          {rental.status === 'active' && !rental.isOverdue && (
                            <span className={styles.pulsingDot} />
                          )}
                          {rental.status === 'active' && rental.isOverdue
                            ? 'Overdue Notice'
                            : rental.status === 'active'
                            ? 'In Custody'
                            : rental.status === 'returned'
                            ? 'Returned & Inspected'
                            : 'Closed & Reconciled'}
                        </span>
                      </div>

                      {/* Bottom Vehicle Identity */}
                      <div className={styles.mediaBottom}>
                        <p className={styles.vehicleBrand}>{brandName}</p>
                        <h3 className={styles.vehicleModel}>{modelName}</h3>
                        <div className={styles.plateRow}>
                          <span className={styles.platePill}>Plate: {rental.licensePlate}</span>
                          {rental.invoiceNumber && (
                            <span className={styles.invoicePill}>
                              Inv: {rental.invoiceNumber}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Details & Actions Column (Right) */}
                    <div className={styles.cardContent}>
                      {/* Header with Reference */}
                      <div className={styles.cardContentHeader}>
                        <div className={styles.refMetaGroup}>
                          <div className={styles.refPill}>
                            <Calendar size={13} style={{ color: 'var(--champagne)' }} />
                            <span>
                              Booking: <strong>{rental.reservationNumber}</strong>
                            </span>
                          </div>

                          <span className={styles.custodyTag}>
                            {rental.status === 'active'
                              ? 'Vehicle Actively in Custody'
                              : 'Handover Completed & Verified'}
                          </span>
                        </div>

                        <span className={styles.contractIdTag}>
                          Contract ID: {rental.id.slice(0, 8)}…
                        </span>
                      </div>

                      {/* 4-Step Luxury Progress Stepper */}
                      <div className={styles.stepperContainer} aria-label="Handover progress stepper">
                        <div className={styles.stepper}>
                          {[
                            'Handover Dispatch',
                            'Client Custody',
                            'Return Handover',
                            'Settled & Released',
                          ].map((lbl, idx) => {
                            const stepNum = idx + 1;
                            const isComp = stepNum < step;
                            const isCurr = stepNum === step;

                            return (
                              <div
                                key={lbl}
                                className={`${styles.stepItem} ${
                                  isComp ? styles.completed : isCurr ? styles.current : ''
                                }`}
                              >
                                <div className={styles.stepDot}>
                                  {isComp ? '✓' : stepNum}
                                </div>
                                <span className={styles.stepLabel}>{lbl}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Logistics Info Grid */}
                      <div className={styles.infoGrid}>
                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>
                            <Calendar size={12} /> Collection Handover
                          </span>
                          <span className={styles.infoValue}>
                            {formatDateTime(rental.startedAt)}
                          </span>
                          <span className={styles.infoSub}>
                            {rental.pickupLocation || 'Budapest Flagship Showroom'}
                          </span>
                        </div>

                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>
                            <Clock size={12} /> Scheduled Return
                          </span>
                          <span className={styles.infoValue}>
                            {formatDateTime(rental.expectedReturnAt)}
                          </span>
                          <span className={styles.infoSub}>
                            {rental.dropoffLocation || 'Budapest Flagship Showroom'}
                          </span>
                        </div>

                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>
                            <CheckCircle size={12} /> Actual Handover Status
                          </span>
                          <span className={styles.infoValue}>
                            {rental.returnedAt ? formatDateTime(rental.returnedAt) : 'Currently in Transit'}
                          </span>
                          <span className={styles.infoSub}>
                            {rental.returnedAt ? 'Official Check-in Complete' : 'Active Custody Protocol'}
                          </span>
                        </div>
                      </div>

                      {/* Financial & Security Ledger Summary */}
                      <div className={styles.financialRow}>
                        <div className={styles.financialItem}>
                          <span className={styles.financialLabel}>Rental Hire Value</span>
                          <span className={styles.financialAmount}>
                            {rental.totalAmount ? (
                              <Price value={rental.totalAmount} />
                            ) : (
                              'EUR 7,200.00'
                            )}
                          </span>
                        </div>

                        <div className={styles.financialItem}>
                          <span className={styles.financialLabel}>Security Deposit Hold</span>
                          <span className={styles.financialDeposit}>
                            {rental.depositAmount ? (
                              <Price value={rental.depositAmount} />
                            ) : (
                              'EUR 9,000.00'
                            )}
                          </span>
                        </div>

                        <div className={styles.financialItem}>
                          <span className={styles.financialLabel}>Guarantee Status</span>
                          <span className={styles.financialStatus}>
                            <ShieldCheck size={13} style={{ color: '#10b981' }} />
                            {rental.status === 'active'
                              ? 'Pre-authorized on File'
                              : rental.status === 'returned'
                              ? 'Inspection Reconciled'
                              : 'Settled & Escrow Released'}
                          </span>
                        </div>
                      </div>

                      {/* Overdue Alert Banner (If Applicable) */}
                      {rental.status === 'active' && rental.isOverdue && (
                        <div className={styles.overdueAlert} role="alert">
                          <AlertCircle size={18} />
                          <div>
                            <strong>Return Schedule Overdue Notice:</strong> The scheduled vehicle return
                            window has elapsed. Please proceed to the designated showroom or contact our
                            concierge desk immediately to arrange an authorized extension.
                          </div>
                        </div>
                      )}

                      {/* Actions Row */}
                      <div className={styles.actionsRow}>
                        <div className={styles.actionButtonsGroup}>
                          

                          {/* Interactive Modal Preview */}
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => handleOpenContract(rental, vehicleImage)}
                          >
                            <FileText size={14} />
                            <span>View Agreement</span>
                          </button>

                          {/* Commercial Invoice PDF (Only available when an official invoice has been issued) */}
                          {Boolean(rental.invoiceNumber) && (
                            <a
                              href={`/api/finance/me/${rental.id}/documents/invoice`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.invoiceButton}
                              title="Download Official VAT & Commercial Tax Invoice PDF"
                            >
                              <FileText size={14} />
                              <span>Invoice PDF</span>
                            </a>
                          )}
                        </div>

                        {/* Inspection Metrics Accordion Toggle */}
                        <button
                          type="button"
                          className={styles.metricsToggle}
                          onClick={() => toggleDetails(rental.id)}
                          aria-expanded={isDetailsOpen}
                        >
                          <Gauge size={14} />
                          <span>{isDetailsOpen ? 'Hide Telemetry' : 'Handover Inspection'}</span>
                          {isDetailsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                      </div>

                      {/* Expandable Handover Inspection & Telemetry Drawer */}
                      {isDetailsOpen && (
                        <div className={styles.detailsDrawer}>
                          <div className={styles.drawerHeader}>
                            <ShieldCheck size={14} style={{ color: 'var(--champagne)' }} />
                            <span>DIGITAL INSPECTION RECORD &amp; VEHICLE TELEMETRY</span>
                          </div>

                          <div className={styles.inspectionGrid}>
                            <div className={styles.inspectionMetricCard}>
                              <span className={styles.metricLabel}>
                                <Gauge size={13} /> Departure Odometer
                              </span>
                              <span className={styles.metricValue}>
                                {rental.pickupMileageKm !== null
                                  ? `${rental.pickupMileageKm.toLocaleString()} km`
                                  : 'Logged at Handover Check-in'}
                              </span>
                              <span className={styles.metricSub}>Showroom Telemetry Certified</span>
                            </div>

                            <div className={styles.inspectionMetricCard}>
                              <span className={styles.metricLabel}>
                                <Fuel size={13} /> Fuel / Electric Charge
                              </span>
                              <span className={styles.metricValue}>
                                {rental.pickupFuelLevelPct !== null
                                  ? `${rental.pickupFuelLevelPct}% (Standard Benchmark)`
                                  : 'Logged at Handover Check-in'}
                              </span>
                              <span className={styles.metricSub}>Replenishment Standard: 100%</span>
                            </div>

                            <div className={styles.inspectionMetricCard}>
                              <span className={styles.metricLabel}>
                                <ShieldCheck size={13} /> Bodywork &amp; Aesthetics
                              </span>
                              <span className={styles.metricValue}>
                                {rental.pickupCondition || 'Pristine Showroom Condition'}
                              </span>
                              <span className={styles.metricSub}>360° Photographic Scan on File</span>
                            </div>
                          </div>

                          {/* Extensions Schedule if Present */}
                          {Boolean(rental.extensions?.length) && (
                            <div className={styles.extensionBox}>
                              <strong className={styles.extensionTitle}>
                                Authorized Schedule Extensions:
                              </strong>
                              {rental.extensions?.map((ext) => (
                                <div key={ext.id} className={styles.extensionRow}>
                                  <Clock size={12} style={{ color: 'var(--champagne)' }} />
                                  <span>
                                    Previous: {formatDateTime(ext.oldReturnAt)} → Extended Return:{' '}
                                    <strong>{formatDateTime(ext.newReturnAt)}</strong>
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Concierge Support Desk */}
                          <div className={styles.conciergeHotline}>
                            <PhoneCall size={14} style={{ color: 'var(--champagne)' }} />
                            <span>
                              <strong>Private Client Concierge Desk:</strong> Direct support available via your account or via{' '}
                              <a href="mailto:luxurycarsrentcars@gmail.com" style={{ color: 'var(--champagne)', textDecoration: 'underline' }}>
                                luxurycarsrentcars@gmail.com
                              </a>
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Luxury Rental Contract Document Modal */}
      <RentalContractModal
        isOpen={Boolean(activeContract)}
        onClose={() => setActiveContract(null)}
        contract={activeContract}
      />
    </main>
  );
}
