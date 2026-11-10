'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Calendar,
  Clock,
  MapPin,
  Search,
  X,
  RefreshCw,
  FileText,
  CreditCard,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  AlertCircle,
  Car,
  ShieldCheck,
  ArrowRight,
  Key,
  Download,
} from 'lucide-react';

import styles from './reservations.module.css';
import { Price } from '@/components/currency-provider';
import { useConfirm } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';
import {
  type CustomerReservationCategory,
  RESERVATION_CATEGORIES,
  calculateCategoryCounts,
  getDetailedStatusLabel,
  getReservationCategory,
  getReservationStepIndex,
  getStatusExplanation,
} from '@/lib/reservation-status';
import RentalContractModal, {
  type RentalContractData,
} from '@/components/contract/RentalContractModal';
import CheckInCodeModal from '@/components/account/CheckInCodeModal';

// ==========================================================
// DATA TYPES
// ==========================================================

interface Reservation {
  id: string;
  reservationNumber: string;
  vehicleId: string;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  dailyPrice: string;
  depositAmount: string;
  totalAmount: string;
  status: string;
  createdAt: string;
  pickupLocation?: string | null;
  dropoffLocation?: string | null;
  checkinAt?: string | null;
  noShowDeadlineAt?: string | null;
  agencyTimezone?: string | null;
  noShowAt?: string | null;
  noShowReason?: string | null;
  rentalStatus?: string | null;
  rentalStartedAt?: string | null;
  inspectionMileage?: number | null;
  inspectionFuel?: number | null;
  inspectionCondition?: string | null;
  inspectionNotes?: string | null;
  paymentDeadlineAt?: string | null;
  paymentUrl?: string | null;
  paidAt?: string | null;
  depositRefundStatus?: string | null;
  depositRefundedAmount?: string | null;
  depositRetainedAmount?: string | null;
  depositRetentionReason?: string | null;
  stripeRefundId?: string | null;
  // Backend direct enrichment
  vehicleName?: string;
  brandName?: string;
  modelName?: string;
  imageUrl?: string | null;
  returnSummary?: {
    reference: string;
    status: string;
    actualReturnAt: string | null;
    inspection: {
      mileageKm: number | null;
      fuelLevelPct: number | null;
      condition: string | null;
      notes: string | null;
      submittedAt: string | null;
    };
    damages: { zone: string; description: string; severity: string; preExisting: boolean }[];
    charges: { type: string; description: string; amount: string }[];
    preparationStatus: string | null;
  } | null;
}

interface CatalogVehicle {
  id: string;
  brandName: string;
  modelName: string;
  categoryName?: string;
  imageUrl?: string;
}

interface FinancialPayment {
  id: string;
  type: string;
  method: string;
  amount: string;
  currency: string;
  paidAt: string;
  reference: string | null;
}

interface ReservationFinance {
  reservation: { id: string; totalAmount: string };
  rental: { id: string; contractNumber?: string } | null;
  payments: FinancialPayment[];
  deposit: {
    status: string;
    requiredAmount: string;
    receivedAmount: string;
    outstandingAmount: string;
    refundedAmount: string;
    retainedAmount: string;
    retentionReason: string | null;
  };
  invoices: { id: string; invoiceNumber: string; totalAmount: string }[];
  amountPaidEur: string;
  outstandingEur: string;
  paymentStatus: string;
}

// ==========================================================
// FORMATTING HELPERS
// ==========================================================

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
}

function formatDateTime(value: string | null | undefined, timezone = 'Europe/Paris'): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

// ==========================================================
// PAGE COMPONENT
// ==========================================================

export default function MyReservationsPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [vehicleCatalog, setVehicleCatalog] = useState<Record<string, CatalogVehicle>>({});
  const [financialByReservation, setFinancialByReservation] = useState<Record<string, ReservationFinance>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [copiedNumber, setCopiedNumber] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState<number | null>(null);

  // Filters UI: ALL or one of the strict 6 categories
  const [selectedCategory, setSelectedCategory] = useState<CustomerReservationCategory | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<
    'pickup_nearest' | 'created_newest' | 'amount_highest' | 'pickup_latest'
  >('pickup_nearest');
  const [expandedDossier, setExpandedDossier] = useState<Record<string, boolean>>({});

  // Contract Modal state
  const [activeContract, setActiveContract] = useState<RentalContractData | null>(null);

  // Check-In Pass Modal state
  const [checkinPass, setCheckinPass] = useState<{
    reservationNumber: string;
    vehicleName: string;
    code: string;
    expiresAt: string;
    agencyName: string;
  } | null>(null);

  // ========================================================
  // LOAD REAL DATA
  // ========================================================

  const loadReservations = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');

    try {
      // 1. Fetch real reservations
      const response = await fetch('/api/reservations', {
        method: 'GET',
        cache: 'no-store',
        signal,
      });

      if (response.status === 401) {
        router.replace('/login');
        return;
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.message || `Unable to load reservations (HTTP ${response.status}).`);
      }

      const rawData: unknown = await response.json();
      if (!Array.isArray(rawData)) {
        throw new Error('Invalid reservations response.');
      }

      const list = rawData as Reservation[];
      list.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
      if (!signal?.aborted) {
        setReservations(list);
      }

      // 2. Fetch financial summaries in background
      try {
        const finResponse = await fetch('/api/finance/me/reservations', {
          method: 'GET',
          cache: 'no-store',
          signal,
        });
        if (finResponse.ok) {
          const summaries: unknown = await finResponse.json();
          if (Array.isArray(summaries)) {
            const map: Record<string, ReservationFinance> = {};
            for (const item of summaries) {
              const fin = item as ReservationFinance;
              if (fin.reservation?.id) {
                map[fin.reservation.id] = fin;
              }
            }
            if (!signal?.aborted) {
              setFinancialByReservation(map);
            }
          }
        }
      } catch {
        // Non-blocking secondary data
      }

      // 3. Fetch catalog for vehicle images and details
      try {
        const catResponse = await fetch('/api/vehicles/catalog', {
          method: 'GET',
          cache: 'no-store',
          signal,
        });
        if (catResponse.ok) {
          const catData: unknown = await catResponse.json();
          if (Array.isArray(catData)) {
            const map: Record<string, CatalogVehicle> = {};
            for (const item of catData) {
              const v = item as CatalogVehicle;
              if (v.id) {
                map[v.id] = v;
              }
            }
            if (!signal?.aborted) {
              setVehicleCatalog(map);
            }
          }
        }
      } catch {
        // Non-blocking catalog
      }
    } catch (caught) {
      if (!signal?.aborted) {
        setError(caught instanceof Error ? caught.message : 'Unable to load reservations.');
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [router]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCurrentTime(Date.now());
      void loadReservations();
    }, 0);

    const interval = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 60_000);

    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [loadReservations]);

  // ========================================================
  // STRICT 6-CATEGORY REAL COUNTERS
  // ========================================================

  const categoryCounts = useMemo(() => {
    return calculateCategoryCounts(reservations);
  }, [reservations]);

  // ========================================================
  // FILTERING & SEARCH
  // ========================================================

  const filteredReservations = useMemo(() => {
    const list = reservations.filter((reservation) => {
      const category = getReservationCategory(reservation);

      // 1. Status Category filter
      if (selectedCategory !== 'ALL' && category !== selectedCategory) {
        return false;
      }

      // 2. Search query by reference or vehicle
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const ref = (reservation.reservationNumber || '').toLowerCase();
        const catVehicle = vehicleCatalog[reservation.vehicleId];
        const vName = (
          reservation.vehicleName ||
          (catVehicle ? `${catVehicle.brandName} ${catVehicle.modelName}` : '')
        ).toLowerCase();

        if (!ref.includes(query) && !vName.includes(query)) {
          return false;
        }
      }

      return true;
    });

    return list.sort((a, b) => {
      switch (sortOrder) {
        case 'pickup_nearest':
          return Date.parse(a.pickupAt) - Date.parse(b.pickupAt);
        case 'pickup_latest':
          return Date.parse(b.pickupAt) - Date.parse(a.pickupAt);
        case 'amount_highest':
          return Number(b.totalAmount) - Number(a.totalAmount);
        case 'created_newest':
        default:
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      }
    });
  }, [reservations, selectedCategory, searchQuery, sortOrder, vehicleCatalog]);

  // ========================================================
  // CANCELLATION ACTION
  // ========================================================

  async function handleCancel(reservation: Reservation) {
    if (busyNumber) return;

    const cancellable =
      (reservation.status === 'pending' ||
        reservation.status === 'awaiting_payment' ||
        reservation.status === 'confirmed') &&
      currentTime !== null &&
      Date.parse(reservation.pickupAt) > currentTime;

    if (!cancellable) return;

    const confirmed = await confirm({
      title: 'Cancel Reservation',
      message: `Are you sure you want to cancel reservation ${reservation.reservationNumber}? This action cannot be undone.`,
      confirmLabel: 'Yes, Cancel Reservation',
      cancelLabel: 'Keep Reservation',
      tone: 'danger',
    });

    if (!confirmed) return;

    setBusyNumber(reservation.reservationNumber);

    try {
      const response = await fetch(
        `/api/reservations/by-number/${encodeURIComponent(reservation.reservationNumber)}/cancel`,
        { method: 'PATCH' },
      );

      if (response.status === 401) {
        router.replace('/login');
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${response.status}`);
      }

      toast.success(
        `Reservation ${reservation.reservationNumber} has been cancelled.`,
        'Reservation Cancelled',
      );
      await loadReservations();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : 'Unable to cancel reservation.',
        'Cancellation Failed',
      );
    } finally {
      setBusyNumber(null);
    }
  }

  // ========================================================
  // ONLINE CHECK-IN ACTION
  // ========================================================

  async function handleOnlineCheckIn(reservation: Reservation, vName: string) {
    if (busyNumber) return;
    setBusyNumber(reservation.reservationNumber);

    try {
      const response = await fetch(
        `/api/reservations/by-number/${encodeURIComponent(reservation.reservationNumber)}/check-in-code`,
        { method: 'POST' },
      );

      if (response.status === 401) {
        router.replace('/login');
        return;
      }

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.message || 'Check-in pass is currently unavailable.');
      }

      setCheckinPass({
        reservationNumber: reservation.reservationNumber,
        vehicleName: vName,
        code: data.code,
        expiresAt: data.expiresAt,
        agencyName: data.agencyName,
      });

      toast.success('Your vehicle collection pass has been issued.', 'Check-In Ready');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Check-in unavailable.',
        'Online Check-In',
      );
    } finally {
      setBusyNumber(null);
    }
  }

  // ========================================================
  // CONTRACT MODAL HANDLER
  // ========================================================

  function handleOpenContract(
    reservation: Reservation,
    vName: string,
    brandName: string,
    modelName: string,
    imgUrl?: string | null,
  ) {
    const fin = financialByReservation[reservation.id];
    const rentalId = fin?.rental?.id;
    const contractNumber = fin?.rental?.contractNumber || `CTR-${reservation.reservationNumber.replace('RES-', '')}`;

    setActiveContract({
      contractNumber,
      reservationNumber: reservation.reservationNumber,
      rentalId,
      vehicleName: vName,
      brandName,
      modelName,
      imageUrl: imgUrl,
      customerName: 'Valued Client',
      pickupAt: reservation.pickupAt,
      returnAt: reservation.returnAt,
      pickupLocation: reservation.pickupLocation,
      dropoffLocation: reservation.dropoffLocation,
      rentalDays: reservation.rentalDays,
      dailyPrice: reservation.dailyPrice,
      totalAmount: reservation.totalAmount,
      depositAmount: reservation.depositAmount,
      paymentStatus: fin?.paymentStatus?.replaceAll('_', ' '),
      invoiceNumber: fin?.invoices?.[0]?.invoiceNumber,
    });
  }

  function handleCopyReference(ref: string) {
    navigator.clipboard.writeText(ref).catch(() => null);
    setCopiedNumber(ref);
    setTimeout(() => setCopiedNumber(null), 2000);
  }

  function toggleDossier(id: string) {
    setExpandedDossier((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }

  // ========================================================
  // MAIN RENDER
  // ========================================================

  return (
    <main className={styles.page}>
      <div className={styles.container}>

        {/* Top Navigation Bar */}
        <div className={styles.topBar}>
          <Link href="/account" className={styles.backLink}>
            ← Back to Private Salon
          </Link>

          <div className={styles.topActions}>
            <Link href="/account/payments" className={styles.paymentsCta}>
              <CreditCard size={14} />
              Payments &amp; Deposits
            </Link>

            <Link href="/account/rentals" className={styles.paymentsCta}>
              <Car size={14} />
              My Rentals
            </Link>

            <button
              type="button"
              className={styles.refreshButton}
              title="Refresh reservations"
              disabled={loading}
              onClick={() => void loadReservations()}
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Page Header */}
        <header className={styles.header}>
          <span className={styles.eyebrow}>CONCIERGE PORTFOLIO</span>
          <h1 className={styles.title}>My Reservations</h1>
          <p className={styles.subtitle}>
            Monitor your luxury car bookings, concierge approval stages, payment guarantees, and handover dossiers in real time.
          </p>
        </header>

        {/* Status Category Filter Cards (Strict 6 Categories + All) */}
        <section className={styles.statusOverview} aria-label="Reservation status categories">
          <button
            type="button"
            className={`${styles.statusCard} ${selectedCategory === 'ALL' ? styles.active : ''}`}
            onClick={() => setSelectedCategory('ALL')}
          >
            <span className={styles.statusCardCount}>{reservations.length}</span>
            <span className={styles.statusCardLabel}>All Reservations</span>
          </button>

          {RESERVATION_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              data-category={cat}
              className={`${styles.statusCard} ${selectedCategory === cat ? styles.active : ''}`}
              onClick={() => setSelectedCategory(cat)}
            >
              <span className={styles.statusCardCount}>{categoryCounts[cat]}</span>
              <span className={styles.statusCardLabel}>{cat}</span>
            </button>
          ))}
        </section>

        {/* Search & Toolbar */}
        <div className={styles.toolbar}>
          <div className={styles.searchBox}>
            <Search size={16} className={styles.searchIcon} />
            <input
              type="text"
              placeholder="Search by reference (e.g. RES-2026) or vehicle..."
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

          <div className={styles.sortGroup}>
            <span className={styles.sortLabel}>Sort:</span>
            <select
              value={sortOrder}
              onChange={(e) =>
                setSortOrder(
                  e.target.value as
                    | 'pickup_nearest'
                    | 'created_newest'
                    | 'amount_highest'
                    | 'pickup_latest',
                )
              }
              className={styles.sortSelect}
              aria-label="Sort reservations"
            >
              <option value="pickup_nearest">Nearest Pickup Date</option>
              <option value="created_newest">Newest Booking First</option>
              <option value="amount_highest">Highest Total Value</option>
              <option value="pickup_latest">Furthest Pickup Date</option>
            </select>
          </div>

          <div className={styles.toolbarMeta}>
            {selectedCategory !== 'ALL' && (
              <span className={styles.activeFilterPill}>
                Category: {selectedCategory}
                <X
                  size={12}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedCategory('ALL')}
                />
              </span>
            )}
            <span>
              Showing <strong>{filteredReservations.length}</strong> of {reservations.length}
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
              onClick={() => void loadReservations()}
            >
              Retry
            </button>
          </div>
        )}

        {/* Skeletons Loading */}
        {loading && reservations.length === 0 ? (
          <div className={styles.list}>
            {[1, 2, 3].map((i) => (
              <div key={i} className={styles.skeletonCard}>
                <div className={styles.skeletonPulse} />
              </div>
            ))}
          </div>
        ) : filteredReservations.length === 0 ? (
          /* Empty State */
          <div className={styles.emptyCard}>
            <Car className={styles.emptyIcon} />
            <h2 className={styles.emptyTitle}>
              {searchQuery || selectedCategory !== 'ALL'
                ? 'No matching reservations'
                : 'No reservations in your private garage yet'}
            </h2>
            <p className={styles.emptyText}>
              {searchQuery || selectedCategory !== 'ALL'
                ? 'Try adjusting your search criteria or selecting a different status filter.'
                : 'Experience the world’s most exhilarating supercars and grand tourers. Browse our collection and reserve your journey.'}
            </p>
            {searchQuery || selectedCategory !== 'ALL' ? (
              <button
                type="button"
                className={styles.emptyCta}
                onClick={() => {
                  setSelectedCategory('ALL');
                  setSearchQuery('');
                }}
              >
                Reset Filters
              </button>
            ) : (
              <Link href="/vehicles" className={styles.emptyCta}>
                Browse Fleet <ArrowRight size={14} />
              </Link>
            )}
          </div>
        ) : (
          /* Reservation Cards List */
          <div className={styles.list}>
            {filteredReservations.map((reservation) => {
              const catVehicle = vehicleCatalog[reservation.vehicleId];
              const brandName = reservation.brandName || catVehicle?.brandName || 'Luxury';
              const modelName = reservation.modelName || catVehicle?.modelName || 'Supercar';
              const vehicleImage = reservation.imageUrl || catVehicle?.imageUrl || null;
              const categoryTag = catVehicle?.categoryName || 'Exclusive Collection';
              const vName = reservation.vehicleName || `${brandName} ${modelName}`;

              const statusMeta = getDetailedStatusLabel(reservation);
              const stepInfo = getReservationStepIndex(reservation);

              const canCancel =
                currentTime !== null &&
                (reservation.status === 'pending' ||
                  reservation.status === 'awaiting_payment' ||
                  reservation.status === 'confirmed') &&
                Date.parse(reservation.pickupAt) > currentTime;

              const isAwaitingPayment = reservation.status === 'awaiting_payment';
              const isConfirmed = reservation.status === 'confirmed';
              const isActiveRental =
                reservation.status === 'active_rental' ||
                (reservation.status === 'converted' && reservation.rentalStatus === 'active');
              const isCompleted =
                reservation.status === 'completed' ||
                (reservation.status === 'converted' && reservation.rentalStatus === 'closed');
              const isRejected = statusMeta.category === 'Rejected';

              const finance = financialByReservation[reservation.id];
              const isDossierOpen = !!expandedDossier[reservation.id];

              return (
                <article key={reservation.id || reservation.reservationNumber} className={styles.card}>
                  <div className={styles.cardMain}>

                    {/* Media Column (Left) */}
                    <div className={styles.cardMedia}>
                      {vehicleImage ? (
                        <img
                          src={vehicleImage}
                          alt={vName}
                          className={styles.vehicleImage}
                          loading="lazy"
                        />
                      ) : (
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: '#12141a',
                          }}
                        >
                          <Car size={64} style={{ color: 'var(--champagne-line)', opacity: 0.5 }} />
                        </div>
                      )}
                      <div className={styles.imageOverlay} />

                      <div className={styles.mediaTop}>
                        <div className={styles.referenceBadge}>
                          <span>{reservation.reservationNumber}</span>
                        </div>

                        <span className={`${styles.statusBadge} ${styles[statusMeta.tone]}`}>
                          {statusMeta.label}
                        </span>
                      </div>

                      <div className={styles.mediaBottom}>
                        <p className={styles.vehicleBrand}>{brandName}</p>
                        <h3 className={styles.vehicleModel}>{modelName}</h3>
                        <span className={styles.vehicleCategory}>{categoryTag}</span>
                      </div>
                    </div>

                    {/* Details & Actions Column (Right) */}
                    <div className={styles.cardContent}>

                      {/* Header with Dates */}
                      <div className={styles.cardContentHeader}>
                        <div className={styles.datesMeta}>
                          <Calendar size={14} style={{ color: 'var(--champagne)' }} />
                          <span>
                            Booked on {formatDate(reservation.createdAt)}
                          </span>
                        </div>

                        <span className={styles.activeFilterPill}>
                          Category: {statusMeta.category}
                        </span>
                      </div>

                      {/* Stepper Progress Bar */}
                      <div className={styles.stepper} aria-label="Booking timeline">
                        {stepInfo.stepLabels.map((label, idx) => {
                          const stepNum = idx + 1;
                          let stepState = '';
                          if (stepInfo.isTerminalRejection && stepNum === stepInfo.currentStep) {
                            stepState = styles.rejected;
                          } else if (stepNum < stepInfo.currentStep) {
                            stepState = styles.completed;
                          } else if (stepNum === stepInfo.currentStep) {
                            stepState = styles.current;
                          }

                          return (
                            <div key={label} className={`${styles.stepItem} ${stepState}`}>
                              <div className={styles.stepDot}>
                                {stepInfo.isTerminalRejection && stepNum === stepInfo.currentStep ? (
                                  '✕'
                                ) : stepNum < stepInfo.currentStep ? (
                                  '✓'
                                ) : (
                                  stepNum
                                )}
                              </div>
                              <span className={styles.stepLabel}>{label}</span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Logistics Info Grid */}
                      <div className={styles.infoGrid}>
                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>
                            <Calendar size={12} /> Pickup Date
                          </span>
                          <span className={styles.infoValue}>
                            {formatDate(reservation.pickupAt)}
                          </span>
                          <span className={styles.infoSub}>
                            {reservation.pickupLocation || 'Budapest Luxury Showroom'}
                          </span>
                        </div>

                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>
                            <Clock size={12} /> Return Date
                          </span>
                          <span className={styles.infoValue}>
                            {formatDate(reservation.returnAt)}
                          </span>
                          <span className={styles.infoSub}>
                            {reservation.dropoffLocation || 'Budapest Luxury Showroom'}
                          </span>
                        </div>

                        <div className={styles.infoItem}>
                          <span className={styles.infoLabel}>
                            <MapPin size={12} /> Duration
                          </span>
                          <span className={styles.infoValue}>
                            {reservation.rentalDays} {reservation.rentalDays === 1 ? 'Day' : 'Days'}
                          </span>
                          <span className={styles.infoSub}>
                            Daily Rate: <Price value={reservation.dailyPrice} />
                          </span>
                        </div>
                      </div>

                      {/* Pricing Row */}
                      <div className={styles.pricingRow}>
                        <div className={styles.pricingBlock}>
                          <span className={styles.pricingLabel}>Total Rental:</span>
                          <span className={styles.pricingAmount}>
                            <Price value={reservation.totalAmount} />
                          </span>
                        </div>

                        <div className={styles.pricingBlock}>
                          <span className={styles.pricingLabel}>Security Deposit:</span>
                          <span className={styles.depositAmount}>
                            <Price value={reservation.depositAmount} /> (Pre-authorization hold)
                          </span>
                        </div>
                      </div>

                      {/* Contextual Status Callouts */}
                      {isAwaitingPayment && (
                        <div className={`${styles.callout} ${styles.urgent}`}>
                          <div className={styles.calloutInfo}>
                            <span className={styles.calloutTag}>Action Required · 24-Hour Guarantee Window</span>
                            <h4 className={styles.calloutTitle}>Booking Approved by Concierge</h4>
                            <p className={styles.calloutText}>
                              Please finalize your payment and deposit hold to secure this vehicle.
                              {reservation.paymentDeadlineAt && (
                                <> Guarantee window expires: <strong>{formatDateTime(reservation.paymentDeadlineAt, reservation.agencyTimezone || 'Europe/Paris')}</strong>.</>
                              )}
                            </p>
                          </div>
                          <Link
                            href={`/account/payments/${encodeURIComponent(reservation.reservationNumber)}`}
                            className={styles.payNowCta}
                          >
                            <CreditCard size={14} /> Pay &amp; Guarantee Hold →
                          </Link>
                        </div>
                      )}

                      {isConfirmed && (
                        <div className={`${styles.callout} ${styles.guaranteed}`}>
                          <div className={styles.calloutInfo}>
                            <span className={styles.calloutTag}>✓ Vehicle Guaranteed &amp; Reserved</span>
                            <h4 className={styles.calloutTitle}>Confirmed · Ready for Handover</h4>
                            <p className={styles.calloutText}>
                              Your vehicle hold and security pre-authorization are officially registered. Collection starts {formatDate(reservation.pickupAt)} at the showroom.
                            </p>
                          </div>
                          <button
                            type="button"
                            className={styles.payNowCta}
                            disabled={busyNumber === reservation.reservationNumber}
                            onClick={() => void handleOnlineCheckIn(reservation, vName)}
                          >
                            <Key size={14} />
                            {busyNumber === reservation.reservationNumber ? 'Issuing Pass...' : 'Showroom Check-In Pass'}
                          </button>
                        </div>
                      )}

                      {isActiveRental && (
                        <div className={`${styles.callout} ${styles.activeRental}`}>
                          <div className={styles.calloutInfo}>
                            <span className={styles.calloutTag}>Active Rental · Vehicle In Custody</span>
                            <h4 className={styles.calloutTitle}>Supercar Handed Over</h4>
                            <p className={styles.calloutText}>
                              Scheduled return is {formatDate(reservation.returnAt)}. Track mileage and inspection reports in your rental hub.
                            </p>
                          </div>
                          <Link href="/account/rentals" className={styles.secondaryAction}>
                            View My Rentals →
                          </Link>
                        </div>
                      )}

                      {isCompleted && (
                        <div className={`${styles.callout} ${styles.completed}`}>
                          <div className={styles.calloutInfo}>
                            <span className={styles.calloutTag}>Rental Concluded</span>
                            <h4 className={styles.calloutTitle}>Vehicle Successfully Returned</h4>
                            <p className={styles.calloutText}>
                              Inspection completed and security deposit reconciled.
                              {reservation.depositRefundStatus === 'fully_refunded' && ' Full deposit refund released.'}
                              {reservation.depositRefundStatus === 'partially_refunded' && ' Deposit partially released with retained deductions.'}
                            </p>
                          </div>
                        </div>
                      )}

                      {isRejected && (
                        <div className={`${styles.callout} ${styles.urgent}`} style={{ borderColor: 'var(--danger-line)', background: 'var(--danger-bg)' }}>
                          <div className={styles.calloutInfo}>
                            <span className={styles.calloutTag} style={{ color: 'var(--danger-text)' }}>
                              Booking Closed · {statusMeta.label}
                            </span>
                            <h4 className={styles.calloutTitle} style={{ color: 'var(--danger-text)' }}>
                              Reservation Inactive
                            </h4>
                            <p className={styles.calloutText}>
                              This booking has ended. No further charges or hold pre-authorizations apply to your account.
                            </p>
                          </div>
                          <Link href="/vehicles" className={styles.secondaryAction}>
                            Explore Fleet →
                          </Link>
                        </div>
                      )}

                      {/* Actions Row */}
                      <div className={styles.actionsRow}>
                        <div className={styles.actionButtonsGroup}>
                          <Link
                            href={`/reservations/${encodeURIComponent(reservation.reservationNumber)}`}
                            className={styles.primaryAction}
                          >
                            <FileText size={14} /> View Booking Dossier →
                          </Link>

                          {/* Rental Agreement Modal Trigger */}
                          {(isConfirmed || isActiveRental || isCompleted) && (
                            <button
                              type="button"
                              className={styles.secondaryAction}
                              onClick={() => handleOpenContract(reservation, vName, brandName, modelName, vehicleImage)}
                            >
                              <FileText size={14} /> Rental Agreement
                            </button>
                          )}

                          
                        </div>

                        {canCancel && (
                          <button
                            type="button"
                            className={styles.cancelAction}
                            disabled={busyNumber === reservation.reservationNumber}
                            onClick={() => void handleCancel(reservation)}
                          >
                            {busyNumber === reservation.reservationNumber ? 'Cancelling...' : 'Cancel Reservation'}
                          </button>
                        )}
                      </div>
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

      {/* Showroom Check-In Code Pass Modal */}
      {checkinPass && (
        <CheckInCodeModal
          isOpen={Boolean(checkinPass)}
          onClose={() => setCheckinPass(null)}
          reservationNumber={checkinPass.reservationNumber}
          vehicleName={checkinPass.vehicleName}
          code={checkinPass.code}
          expiresAt={checkinPass.expiresAt}
          agencyName={checkinPass.agencyName}
        />
      )}
    </main>
  );
}
