'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './reservations.module.css';

import { Price } from '@/components/currency-provider';
import { formatAmount } from '@/lib/format';
import { useConfirm } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';

// ==========================================================
// TYPE DE RÉSERVATION RETOURNÉ PAR NESTJS
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
  pickupLocation?:string|null;dropoffLocation?:string|null;
  // Horodatage du pré-enregistrement en ligne (check-in) s'il a eu lieu.
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
  handoverAt?: string | null;
  handoverBy?: string | null;
  handoverInspection?: Record<string, unknown> | null;
  returnConfirmedAt?: string | null;
  returnConfirmedBy?: string | null;
  returnInspection?: Record<string, unknown> | null;
  depositRefundStatus?: string | null;
  depositRefundedAmount?: string | null;
  depositRetainedAmount?: string | null;
  depositRetentionReason?: string | null;
  stripeRefundId?: string | null;
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
}
interface ApiError { message?: string | string[]; }

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
  rental: { id: string } | null;
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
// OUTILS D'AFFICHAGE
// ==========================================================

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
}

function formatAgencyDateTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function reservationState(reservation: Reservation): string {
  if (reservation.status === 'pending') return 'Pending approval';
  if (reservation.status === 'awaiting_payment') return 'Awaiting payment';
  if (reservation.status === 'confirmed') return 'Confirmed';
  if (reservation.status === 'active_rental') return 'Active rental';
  if (reservation.status === 'completed') return 'Completed';
  if (reservation.status === 'cancelled_unpaid') return 'Cancelled (Unpaid)';
  if (reservation.status === 'rejected') return 'Rejected';
  if (reservation.status === 'cancelled') return 'Cancelled';
  if (reservation.status === 'no_show') return 'No-Show';
  if (reservation.status === 'converted') {
    if (reservation.rentalStatus === 'active') return 'Active rental';
    if (reservation.rentalStatus === 'closed') return 'Completed';
    if (reservation.rentalStatus === 'returned') return 'Return processing';
  }
  return reservation.status.replaceAll('_', ' ');
}

async function readError(response: Response): Promise<string> {
  try {
    const error: ApiError = await response.json();
    if (Array.isArray(error.message)) return error.message.join(' ');
    if (typeof error.message === 'string') return error.message;
  } catch {
    // Réponse non JSON : garder l'erreur générique.
  }
  return `Request failed (HTTP ${response.status}).`;
}

function isReservation(value: unknown): value is Reservation {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<Reservation>;
  return typeof item.reservationNumber === 'string' &&
    typeof item.vehicleId === 'string' &&
    typeof item.pickupAt === 'string' &&
    typeof item.returnAt === 'string' &&
    typeof item.status === 'string' &&
    typeof item.totalAmount === 'string';
}

// ==========================================================
// PAGE /account/reservations
// ==========================================================

export default function MyReservationsPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [vehicleNames, setVehicleNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [financialByReservation, setFinancialByReservation] =
    useState<Record<string, ReservationFinance>>({});
  const [financialError, setFinancialError] = useState('');

  const toast = useToast();

  // Heure courante conservée dans un state.
  // Cela évite d'appeler Date.now() directement pendant le rendu.
  const [currentTime, setCurrentTime] =
    useState<number | null>(null);

  // ========================================================
  // CHARGER UNIQUEMENT LES RÉSERVATIONS DU CLIENT CONNECTÉ
  // ========================================================

  const loadReservations = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');

    try {
      // GET /api/reservations transmet à NestJS GET /reservations/me.
      const response = await fetch('/api/reservations', {
        method: 'GET', cache: 'no-store', signal,
      });

      if (response.status === 401) {
        router.replace('/login');
        return;
      }
      if (!response.ok) throw new Error(await readError(response));

      const data: unknown = await response.json();
      if (!Array.isArray(data) || !data.every(isReservation)) {
        throw new Error('Invalid reservations response.');
      }

      // Afficher les réservations les plus récentes en premier.
      const sorted = [...data].sort((a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
      if (!signal?.aborted) setReservations(sorted);

      try {
        setFinancialError('');
        const financialResponse = await fetch('/api/finance/me/reservations', {
          method: 'GET', cache: 'no-store', signal,
        });
        if (financialResponse.status === 401) {
          router.replace('/login');
          return;
        }
        if (!financialResponse.ok) {
          throw new Error(await readError(financialResponse));
        }
        const summaries: unknown = await financialResponse.json();
        if (!Array.isArray(summaries)) {
          throw new Error('Invalid financial summary response.');
        }
        const summariesById: Record<string, ReservationFinance> = {};
        for (const value of summaries) {
          const summary = value as Partial<ReservationFinance>;
          if (typeof summary.reservation?.id === 'string') {
            summariesById[summary.reservation.id] =
              summary as ReservationFinance;
          }
        }
        if (!signal?.aborted) setFinancialByReservation(summariesById);
      } catch (caught) {
        if (!signal?.aborted) {
          setFinancialError(
            caught instanceof Error
              ? caught.message
              : 'Unable to load financial information.',
          );
        }
      }

      // Enrichissement purement visuel : nom du véhicule si présent
      // dans le catalogue public. Son absence ne bloque pas la page.
      try {
        const catalogResponse = await fetch('/api/vehicles/catalog', {
          method: 'GET', cache: 'no-store', signal,
        });
        if (catalogResponse.ok) {
          const catalog: unknown = await catalogResponse.json();
          if (Array.isArray(catalog)) {
            const names: Record<string, string> = {};
            for (const item of catalog) {
              const vehicle = item as Partial<CatalogVehicle>;
              if (
                typeof vehicle.id === 'string' &&
                typeof vehicle.brandName === 'string' &&
                typeof vehicle.modelName === 'string'
              ) {
                names[vehicle.id] = `${vehicle.brandName} ${vehicle.modelName}`;
              }
            }
            if (!signal?.aborted) setVehicleNames(names);
          }
        }
      } catch {
        // Le catalogue n'est pas obligatoire pour voir l'historique.
      }
    } catch (caught) {
      if (!signal?.aborted) {
        setError(
          caught instanceof Error ? caught.message : 'Unable to load reservations.',
        );
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();

    // React 19 déconseille un setState déclenché
    // synchroniquement depuis le corps de l'effet.
    // On démarre donc le chargement dans une tâche asynchrone.
    const timerId = window.setTimeout(() => {
      setCurrentTime(Date.now());

      void loadReservations(
        controller.signal,
      );
    }, 0);

    // Mettre à jour l'heure une fois par minute
    // afin que le bouton Cancel reste cohérent.
    const intervalId = window.setInterval(
      () => {
        setCurrentTime(Date.now());
      },
      60_000,
    );

    return () => {
      window.clearTimeout(timerId);
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [loadReservations]);

  // ========================================================
  // ANNULER UNE RÉSERVATION (pending ou confirmed)
  // ========================================================

  async function handleCancel(reservation: Reservation) {
    if (busyNumber) return;
    const cancellableStatus =
      reservation.status === 'pending' ||
      reservation.status === 'confirmed';
    if (
      !cancellableStatus ||
      currentTime === null ||
      Date.parse(reservation.pickupAt) <=
        currentTime
    ) {
      return;
    }

    // Confirmation explicite avant modification en base.
    const confirmed = await confirm({
      title: 'Cancel reservation',
      message: `Reservation ${reservation.reservationNumber} will be cancelled. This action cannot be undone from your account.`,
      confirmLabel: 'Yes, cancel it',
      cancelLabel: 'Keep reservation',
      tone: 'danger',
    });
    if (!confirmed) return;

    setError('');
    setSuccess('');
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
      if (!response.ok) throw new Error(await readError(response));

      // Recharger la liste réelle depuis NestJS après l'annulation.
      await loadReservations();
      const message = `Reservation ${reservation.reservationNumber} cancelled.`;
      setSuccess(message);
      toast.success(message, 'Reservation cancelled');
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Unable to cancel reservation.';
      setError(message);
      toast.error(message, 'Reservation');
    } finally {
      setBusyNumber(null);
    }
  }


  // ========================================================
  // INTERFACE
  // ========================================================

  const statusOrder = [
    'Pending approval',
    'Awaiting payment',
    'Confirmed',
    'Active rental',
    'Completed',
    'Cancelled (Unpaid)',
    'Cancelled',
    'Rejected',
    'No-Show',
  ];

  const statusCounts = reservations.reduce<
    Record<string, number>
  >((accumulator, reservation) => {
    const state = reservationState(reservation);
    accumulator[state] = (accumulator[state] ?? 0) + 1;
    return accumulator;
  }, {});

  return (
    <main className={styles.page}>
      <section className={styles.container}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
          <Link href="/account" className={styles.back} style={{ marginBottom: 0 }}>← Back to account</Link>
          <Link
            href="/account/payments"
            className={styles.topPaymentsCta}
          >
            My payments &amp; deposits
            <span aria-hidden="true">→</span>
          </Link>
        </div>
        <p className={styles.eyebrow}>CUSTOMER AREA</p>
        <h1>My reservations</h1>
        <p className={styles.intro}>
          Track your luxury car bookings and manage eligible pending requests.
        </p>

        {!loading && reservations.length > 0 && (
          <div className={styles.summary}>
            {statusOrder.map((status) => (
              <div
                key={status}
                className={styles.summaryItem}
              >
                <strong>
                  {statusCounts[status] ?? 0}
                </strong>
                <span>{status}</span>
              </div>
            ))}
          </div>
        )}

        {error && <div className={styles.error} role="alert">{error}</div>}
        {success && <div className={styles.success} role="status">{success}</div>}
        {financialError && (
          <div className={styles.error} role="alert">
            Financial details are temporarily unavailable: {financialError}
          </div>
        )}

        {loading ? (
          <div className={styles.notice}>Loading your reservations...</div>
        ) : reservations.length === 0 && !error ? (
          <div className={styles.empty}>
            <h2>No reservations yet</h2>
            <p>Your bookings will appear here after you make a reservation.</p>
            <Link href="/vehicles" className={styles.primaryLink}>
              Browse the fleet →
            </Link>
          </div>
        ) : (
          <div className={styles.list}>
            {reservations.map((reservation) => {
              const canCancel =
                currentTime !== null &&
                (reservation.status === 'pending' ||
                  reservation.status === 'confirmed') &&
                Date.parse(reservation.pickupAt) >
                  currentTime;
              const statusClass = reservation.status === 'pending'
                ? styles.pending
                : reservation.status === 'awaiting_payment'
                  ? styles.awaitingPayment
                  : reservation.status === 'confirmed'
                    ? styles.confirmed
                    : reservation.status === 'active_rental'
                      ? styles.activeRental
                      : reservation.status === 'completed'
                        ? styles.completed
                        : reservation.status === 'cancelled_unpaid'
                          ? styles.cancelledUnpaid
                          : styles.otherStatus;

              return (
                <article className={styles.card} key={reservation.reservationNumber}>
                  <div className={styles.cardTop}>
                    <div>
                      <p className={styles.cardLabel}>RESERVATION NUMBER</p>
                      <h2>{reservation.reservationNumber}</h2>
                    </div>
                    <span className={`${styles.status} ${statusClass}`}>
                      {reservationState(reservation)}
                    </span>
                  </div>

                  {reservation.status === 'awaiting_payment' && (
                    <div className={styles.paymentCallout}>
                      <div className={styles.paymentCalloutInfo}>
                        <span className={styles.paymentCalloutBadge}>Action Required · 24-Hour Guarantee Window</span>
                        <h3>Booking Approved — Payment Required</h3>
                        <p>
                          Your reservation request has been approved by LUXUAR Concierge. Please complete your rental payment and security deposit to guarantee collection.
                        </p>
                        {reservation.paymentDeadlineAt && (
                          <div className={styles.deadlineNoteText}>
                            Payment window expires: <strong>{formatAgencyDateTime(reservation.paymentDeadlineAt, reservation.agencyTimezone || 'Europe/Paris')}</strong>
                          </div>
                        )}
                      </div>
                      <Link
                        href={`/account/payments/${encodeURIComponent(reservation.reservationNumber)}`}
                        className={styles.payNowButton}
                      >
                        Pay Rental &amp; Deposit (Stripe) →
                      </Link>
                    </div>
                  )}

                  {reservation.status === 'active_rental' && (
                    <div className={styles.activeRentalCallout}>
                      <div>
                        <span className={styles.calloutTag}>Active Rental · Vehicle In Custody</span>
                        <h3>Vehicle Handed Over</h3>
                        <p>
                          Your luxury rental is currently active. Scheduled return is {formatDate(reservation.returnAt)}.
                        </p>
                      </div>
                      <Link
                        href={`/reservations/${encodeURIComponent(reservation.reservationNumber)}`}
                        className={styles.actionPill}
                      >
                        Inspection &amp; Rental Hub →
                      </Link>
                    </div>
                  )}

                  {reservation.status === 'completed' && (
                    <div className={styles.completedCallout}>
                      <div>
                        <span className={styles.calloutTag}>Rental Closed · Inspection Completed</span>
                        <h3>Return Confirmed</h3>
                        <p>
                          Vehicle returned successfully.{' '}
                          {reservation.depositRefundStatus === 'fully_refunded' && 'Full security deposit refund has been issued to your payment card via Stripe.'}
                          {reservation.depositRefundStatus === 'partially_refunded' && `Partial deposit refund issued: €${formatAmount(reservation.depositRefundedAmount)} refunded, €${formatAmount(reservation.depositRetainedAmount)} retained.`}
                          {reservation.depositRefundStatus === 'retained' && `Security deposit retained for charges: €${formatAmount(reservation.depositRetainedAmount)}.`}
                        </p>
                      </div>
                      <Link
                        href={`/reservations/${encodeURIComponent(reservation.reservationNumber)}`}
                        className={styles.actionPill}
                      >
                        View Return Dossier →
                      </Link>
                    </div>
                  )}

                  <div className={styles.dataGrid}>
                    <div>
                      <span>Vehicle</span>
                      <strong>{vehicleNames[reservation.vehicleId] || 'Luxury vehicle'}</strong>
                      <small>ID: {reservation.vehicleId}</small>
                    </div>
                    <div><span>Rental start</span><strong>{formatDate(reservation.pickupAt)}</strong></div>
                    {reservation.rentalStartedAt && (
                      <div>
                        <span>Actual collection</span>
                        <strong>{formatAgencyDateTime(
                          reservation.rentalStartedAt,
                          reservation.agencyTimezone || 'Europe/Paris',
                        )}</strong>
                      </div>
                    )}
                    <div><span>Rental end</span><strong>{formatDate(reservation.returnAt)}</strong></div>
                    <div><span>Rental days</span><strong>{reservation.rentalDays}</strong></div>
                    <div><span>Daily rate</span><strong><Price value={reservation.dailyPrice} /></strong></div>
                    <div><span>Rental total</span><strong><Price value={reservation.totalAmount} /></strong></div>
                    <div><span>Security deposit</span><strong><Price value={reservation.depositAmount} /></strong></div>
                    {reservation.status === 'confirmed' && reservation.noShowDeadlineAt && (
                      <div className={styles.deadlineNote}>
                        <span>Agency collection deadline</span>
                        <strong>{formatAgencyDateTime(
                          reservation.noShowDeadlineAt,
                          reservation.agencyTimezone || 'Europe/Paris',
                        )}</strong>
                        <small>Please complete vehicle handover by this time. Without a recorded handover, the reservation expires automatically.</small>
                      </div>
                    )}
                    {reservation.status === 'no_show' && (
                      <div className={styles.deadlineNote}>
                        <span>No-Show recorded</span>
                        <strong>{reservation.noShowAt ? formatAgencyDateTime(
                          reservation.noShowAt,
                          reservation.agencyTimezone || 'Europe/Paris',
                        ) : 'Collection deadline missed'}</strong>
                        {reservation.noShowReason && <small>{reservation.noShowReason}</small>}
                      </div>
                    )}
                    {reservation.status === 'active_rental' && (
                      <div>
                        <span>Rental Status</span>
                        <strong>Active Rental · Vehicle Handed Over</strong>
                      </div>
                    )}
                  </div>

                  {(() => {
                    const finance = financialByReservation[reservation.id];
                    if (!finance) {
                      return (
                        <section className={styles.financialPanel} aria-label="Reservation finances">
                          <div className={styles.financialHeading}>
                            <h3>Financial overview</h3>
                            <span>Details unavailable</span>
                          </div>
                          <p>Financial history could not be loaded. Please refresh or contact the agency; no payment status is assumed.</p>
                        </section>
                      );
                    }
                    return (
                      <section className={styles.financialPanel} aria-label="Reservation finances">
                        <div className={styles.financialHeading}>
                          <h3>Financial overview</h3>
                          <span>{finance.paymentStatus.replaceAll('_', ' ')}</span>
                        </div>
                        <div className={styles.financialGrid}>
                          <div><span>Total rental price</span><strong><Price value={reservation.totalAmount} /></strong></div>
                          <div><span>Amount paid</span><strong><Price value={finance.amountPaidEur} /></strong></div>
                          <div><span>Remaining balance</span><strong><Price value={finance.outstandingEur} /></strong></div>
                          <div><span>Required security deposit</span><strong><Price value={finance.deposit.requiredAmount} /></strong></div>
                          <div><span>Deposit received</span><strong><Price value={finance.deposit.receivedAmount} /></strong></div>
                          <div><span>Deposit outstanding</span><strong><Price value={finance.deposit.outstandingAmount} /></strong></div>
                          <div><span>Deposit status</span><strong>{finance.deposit.status.replaceAll('_', ' ')}</strong></div>
                          <div><span>Refunded / retained</span><strong><Price value={finance.deposit.refundedAmount} /> / <Price value={finance.deposit.retainedAmount} /></strong></div>
                        </div>
                        {finance.deposit.retentionReason && (
                          <p>Deposit retention reason: {finance.deposit.retentionReason}</p>
                        )}
                        <div className={styles.financialHistory}>
                          <h4>Payment history</h4>
                          {finance.payments.length === 0
                            ? <p>No payments have been recorded.</p>
                            : finance.payments.map(payment => (
                              <div key={payment.id}>
                                <span>{payment.type.replaceAll('_', ' ')} · {formatDate(payment.paidAt)} · {payment.method} · Ref. {payment.reference || '—'}</span>
                                <strong><Price value={payment.amount} /></strong>
                                <a href={`/api/finance/me/payments/${payment.id}/receipt`}>Receipt</a>
                              </div>
                            ))}
                        </div>
                        {(finance.rental || finance.invoices.length > 0) && (
                          <div className={styles.financialDocuments}>
                            <h4>Documents</h4>
                            {finance.rental && (
                              <a href={`/api/finance/me/${finance.rental.id}/documents/contract`}>Rental contract</a>
                            )}
                            {finance.invoices.map(invoice => finance.rental && (
                              <a key={invoice.id} href={`/api/finance/me/${finance.rental.id}/documents/invoice`}>
                                Invoice {invoice.invoiceNumber} · <Price value={invoice.totalAmount} />
                              </a>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })()}

                  {(reservation.returnSummary || reservation.rentalStatus === 'returned' || reservation.rentalStatus === 'closed') && (
                    <section className={styles.financialPanel} aria-label="Vehicle return summary">
                      <div className={styles.financialHeading}>
                        <h3>Vehicle return</h3>
                        <span>{reservation.returnSummary?.status.replaceAll('_', ' ') ?? 'Summary unavailable'}</span>
                      </div>
                      {reservation.returnSummary ? (
                        <>
                          <div className={styles.financialGrid}>
                            <div><span>Return reference</span><strong>{reservation.returnSummary.reference}</strong></div>
                            <div><span>Actual return</span><strong>{reservation.returnSummary.actualReturnAt
                              ? formatAgencyDateTime(reservation.returnSummary.actualReturnAt, reservation.agencyTimezone || 'Europe/Paris')
                              : 'Not recorded'}</strong></div>
                            <div><span>Deposit refunded</span><strong>{reservation.depositRefundedAmount ? `€${reservation.depositRefundedAmount}` : 'Processed'}</strong></div>
                            {Number(reservation.depositRetainedAmount) > 0 && (
                              <div><span>Damage deduction</span><strong style={{ color: 'var(--danger)' }}>€{reservation.depositRetainedAmount}</strong></div>
                            )}
                            <div><span>Settlement status</span><strong>{reservation.depositRefundStatus?.replaceAll('_', ' ') || 'Settled'}</strong></div>
                            {reservation.depositRetentionReason && (
                              <div style={{ gridColumn: 'span 2' }}><span>Adjustment reason</span><strong>{reservation.depositRetentionReason}</strong></div>
                            )}
                          </div>
                          {reservation.stripeRefundId && <p>Stripe refund reference: <code>{reservation.stripeRefundId}</code></p>}
                          {reservation.returnSummary.damages.length > 0 && (
                            <div className={styles.financialHistory}>
                              <h4>Inspection findings</h4>
                              {reservation.returnSummary.damages.map((damage, index) => (
                                <div key={`${damage.zone}-${index}`}>
                                  <span>{damage.zone} · {damage.severity} · {damage.preExisting ? 'Previously recorded' : 'New finding'}</span>
                                  <strong>{damage.description}</strong>
                                </div>
                              ))}
                            </div>
                          )}
                          {reservation.returnSummary.charges.length > 0 && (
                            <div className={styles.financialHistory}>
                              <h4>Recorded return charges</h4>
                              {reservation.returnSummary.charges.map((charge, index) => (
                                <div key={`${charge.type}-${index}`}>
                                  <span>{charge.type.replaceAll('_', ' ')} · {charge.description}</span>
                                  <strong><Price value={charge.amount} /></strong>
                                </div>
                              ))}
                            </div>
                          )}
                          <p>Available contracts, invoices and payment receipts are listed in your financial documents above.</p>
                        </>
                      ) : (
                        <p>Return inspection details are not available for this rental. Contact support if you need a copy.</p>
                      )}
                    </section>
                  )}

                  {reservation.status === 'confirmed' && (
                    <div className={styles.guaranteedBanner}>
                      <span className={styles.guaranteedTag}>
                        ✓ Guaranteed &amp; Paid · Ready for Collection
                      </span>
                      <h3 className={styles.guaranteedTitle}>
                        Booking Confirmed &amp; Payment Verified
                      </h3>
                      <p className={styles.guaranteedText}>
                        Your vehicle hold and security deposit are fully confirmed via Stripe. Scheduled collection starts {formatDate(reservation.pickupAt)}. No check-in codes or paperwork required.
                      </p>
                    </div>
                  )}

                  <div className={styles.actionsRow}>
                    <Link
                      href={`/reservations/${encodeURIComponent(reservation.reservationNumber)}`}
                      className={styles.trackButton}
                    >
                      Track Reservation &amp; Documents →
                    </Link>
                    {canCancel && (
                      <button type="button" className={styles.cancelButton}
                        disabled={busyNumber !== null}
                        onClick={() => void handleCancel(reservation)}>
                        {busyNumber === reservation.reservationNumber ? 'Cancelling...' : 'Cancel reservation'}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
