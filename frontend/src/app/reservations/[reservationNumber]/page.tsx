'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './reservation.module.css';
import { Price } from '@/components/currency-provider';
import { useToast } from '@/components/toast';
import { useConfirm } from '@/components/confirm-dialog';

interface ReservationData {
  id: string;
  reservationNumber: string;
  status: string;
  vehicleId: string;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  dailyPrice: string;
  depositAmount: string;
  totalAmount: string;
  extrasAmount?: string;
  discountAmount?: string;
  customerNotes?: string | null;
  decisionReason?: string | null;
  paymentDeadlineAt?: string | null;
  stripeSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeRefundId?: string | null;
  paymentUrl?: string | null;
  paidAt?: string | null;
  returnConfirmedAt?: string | null;
  depositRefundStatus?: string;
  depositRefundedAmount?: string;
  depositRetainedAmount?: string;
  depositRetentionReason?: string | null;
  vehicleName?: string;
  brandName?: string;
  modelName?: string;
  licensePlate?: string;
  imageUrl?: string | null;
  pickupLocation?: string | null;
}

export default function ReservationDetailPage() {
  const params = useParams<{ reservationNumber: string }>();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const resNumber = decodeURIComponent(params.reservationNumber ?? '').toUpperCase();

  const [reservation, setReservation] = useState<ReservationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);
  const [timeLeft, setTimeLeft] = useState<{ hours: number; minutes: number; seconds: number; expired: boolean } | null>(null);

  // Load reservation data
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const response = await fetch(`/api/reservations/by-number/${encodeURIComponent(resNumber)}`, {
        cache: 'no-store',
      });

      if (response.status === 401) {
        router.push(`/login?redirect=/reservations/${resNumber}`);
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      setReservation(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load reservation.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [resNumber, router]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadData();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadData]);

  // 24-hour countdown timer for awaiting_payment
  const paymentDeadline = reservation?.paymentDeadlineAt;
  const reservationStatus = reservation?.status;

  useEffect(() => {
    if (!paymentDeadline || reservationStatus !== 'awaiting_payment') {
      const t = setTimeout(() => setTimeLeft(null), 0);
      return () => clearTimeout(t);
    }

    const deadlineStr = paymentDeadline;
    function calculateTime() {
      const target = new Date(deadlineStr).getTime();
      const diff = target - Date.now();
      if (diff <= 0) {
        setTimeLeft({ hours: 0, minutes: 0, seconds: 0, expired: true });
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      setTimeLeft({ hours, minutes, seconds, expired: false });
    }

    const initial = setTimeout(calculateTime, 0);
    const interval = setInterval(calculateTime, 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [paymentDeadline, reservationStatus]);


  // Handle cancel pending reservation
  async function handleCancel() {
    if (!reservation) return;
    const ok = await confirm({
      title: 'Cancel Reservation',
      message: `Are you sure you wish to cancel reservation ${reservation.reservationNumber}? This action cannot be undone.`,
      confirmLabel: 'Cancel Reservation',
      tone: 'danger',
    });
    if (!ok) return;

    setProcessing(true);
    try {
      const res = await fetch(`/api/reservations/by-number/${reservation.reservationNumber}/cancel`, {
        method: 'PATCH',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Cancellation failed');

      toast.success('Reservation cancelled.', 'Cancelled');
      await loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Cancellation failed';
      toast.error(msg);
    } finally {
      setProcessing(false);
    }
  }

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <div className={styles.loadingState}>
            <p className={styles.eyebrow}>LUXUAR Concierge</p>
            <h2 className={styles.title}>Loading reservation dossier...</h2>
          </div>
        </div>
      </main>
    );
  }

  if (error || !reservation) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <div className={styles.errorState}>
            <p className={styles.eyebrow}>Notice</p>
            <h2 className={styles.title}>{error || 'Reservation not found'}</h2>
            <Link href="/account/reservations" className={styles.backLink}>
              ← Back to My Reservations
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const vName = reservation.vehicleName || `${reservation.brandName || ''} ${reservation.modelName || 'Luxury Vehicle'}`.trim();
  const rentalTotal = Number(reservation.totalAmount || 0);
  const depositTotal = Number(reservation.depositAmount || 0);
  const grandTotal = rentalTotal + depositTotal;

  // Step tracker active index
  let stepIndex = 1;
  if (reservation.status === 'awaiting_payment') stepIndex = 2;
  else if (reservation.status === 'confirmed') stepIndex = 3;
  else if (reservation.status === 'active_rental') stepIndex = 4;
  else if (reservation.status === 'completed') stepIndex = 5;

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <Link href="/account/reservations" className={styles.backLink}>
          ← Back to My Reservations
        </Link>

        {/* Header Block */}
        <div className={styles.headerBlock}>
          <span className={styles.eyebrow}>LUXUAR · Reservation Dossier</span>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{vName}</h1>
            <span className={styles.resNumberPill}>
              Ref: {reservation.reservationNumber}
            </span>
          </div>
        </div>

        {/* 5-Step Workflow Tracker */}
        <div className={styles.stepper}>
          <div className={`${styles.stepItem} ${stepIndex >= 1 ? (stepIndex === 1 ? styles.stepActive : styles.stepDone) : ''}`}>
            <div className={styles.stepHeader}>
              <div className={styles.stepCircle}>{stepIndex > 1 ? '✓' : '1'}</div>
              <span className={styles.stepTitle}>1. Request Submitted</span>
            </div>
            <span className={styles.stepSub}>Dates &amp; vehicle chosen</span>
          </div>

          <div className={`${styles.stepItem} ${stepIndex >= 2 ? (stepIndex === 2 ? styles.stepActive : styles.stepDone) : ''}`}>
            <div className={styles.stepHeader}>
              <div className={styles.stepCircle}>{stepIndex > 2 ? '✓' : '2'}</div>
              <span className={styles.stepTitle}>2. Concierge Review</span>
            </div>
            <span className={styles.stepSub}>License &amp; fleet check</span>
          </div>

          <div className={`${styles.stepItem} ${stepIndex >= 3 ? (stepIndex === 3 ? styles.stepActive : styles.stepDone) : ''}`}>
            <div className={styles.stepHeader}>
              <div className={styles.stepCircle}>{stepIndex > 3 ? '✓' : '3'}</div>
              <span className={styles.stepTitle}>3. Stripe Payment</span>
            </div>
            <span className={styles.stepSub}>24h window · Escrow deposit</span>
          </div>

          <div className={`${styles.stepItem} ${stepIndex >= 4 ? (stepIndex === 4 ? styles.stepActive : styles.stepDone) : ''}`}>
            <div className={styles.stepHeader}>
              <div className={styles.stepCircle}>{stepIndex > 4 ? '✓' : '4'}</div>
              <span className={styles.stepTitle}>4. Rental Active</span>
            </div>
            <span className={styles.stepSub}>Starts automatically</span>
          </div>

          <div className={`${styles.stepItem} ${stepIndex >= 5 ? styles.stepDone : ''}`}>
            <div className={styles.stepHeader}>
              <div className={styles.stepCircle}>{stepIndex >= 5 ? '✓' : '5'}</div>
              <span className={styles.stepTitle}>5. Return &amp; Refund</span>
            </div>
            <span className={styles.stepSub}>Return &amp; deposit settlement</span>
          </div>
        </div>

        {/* Main 2-Column Grid */}
        <div className={styles.layoutGrid}>
          {/* Left Column: Status Dossier & Actions */}
          <div className={styles.panel}>
            {/* Status Hero */}
            {reservation.status === 'pending' && (
              <div className={`${styles.statusHero} ${styles.statusPending}`}>
                <span className={styles.statusTag} style={{ background: 'var(--champagne-line)', color: 'var(--noir)' }}>
                  Awaiting Review
                </span>
                <p className={styles.statusDesc}>
                  Your reservation request has been received and is currently being reviewed by the LUXUAR Concierge. Once approved, you will receive an invitation to settle your payment within a 24-hour payment window.
                </p>
                <div style={{ marginTop: '8px' }}>
                  <button
                    onClick={handleCancel}
                    disabled={processing}
                    className={styles.cancelButton}
                  >
                    Cancel Reservation Request
                  </button>
                </div>
              </div>
            )}

            {reservation.status === 'awaiting_payment' && (
              <div className={`${styles.statusHero} ${styles.statusAwaitingPayment}`}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                  <span className={styles.statusTag} style={{ background: '#d48806', color: '#fff' }}>
                    Payment Required
                  </span>
                  {timeLeft && !timeLeft.expired && (
                    <span style={{ fontSize: '12px', fontWeight: 700, color: '#d48806' }}>
                      24h Payment Window
                    </span>
                  )}
                </div>

                <p className={styles.statusDesc}>
                  Your reservation has been approved! To confirm your vehicle hold, please settle the rental price and refundable deposit before the deadline expires.
                </p>

                {timeLeft && (
                  <div className={styles.timerBox}>
                    <span className={styles.timerLabel}>Time Remaining:</span>
                    <span className={styles.timerValue}>
                      {timeLeft.expired ? (
                        <span style={{ color: 'var(--danger)' }}>EXPIRED</span>
                      ) : (
                        `${String(timeLeft.hours).padStart(2, '0')}:${String(timeLeft.minutes).padStart(2, '0')}:${String(timeLeft.seconds).padStart(2, '0')}`
                      )}
                    </span>
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' }}>
                  <Link
                    href={`/account/payments/${encodeURIComponent(reservation.reservationNumber)}`}
                    className={styles.payButton}
                    style={{ textAlign: 'center', textDecoration: 'none' }}
                  >
                    Proceed to Secure Payment Portal (Stripe) →
                  </Link>
                </div>
              </div>
            )}

            {reservation.status === 'confirmed' && (
              <div className={`${styles.statusHero} ${styles.statusConfirmed}`}>
                <span className={styles.statusTag} style={{ background: 'var(--success)', color: '#fff' }}>
                  Confirmed &amp; Paid
                </span>
                <p className={styles.statusDesc}>
                  Your payment has been verified by Stripe. Your luxury vehicle is reserved for you, and your rental will start automatically at the scheduled start time.
                </p>
                {reservation.stripePaymentIntentId && (
                  <div style={{ fontSize: '12px', color: 'var(--muted)', fontFamily: 'monospace' }}>
                    Stripe Payment ID: {reservation.stripePaymentIntentId}
                  </div>
                )}
                {reservation.paidAt && (
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                    Paid on: {new Date(reservation.paidAt).toLocaleString('en-GB')}
                  </div>
                )}
              </div>
            )}

            {reservation.status === 'active_rental' && (
              <div className={`${styles.statusHero} ${styles.statusActiveRental}`}>
                <span className={styles.statusTag} style={{ background: '#1d72b8', color: '#fff' }}>
                  Active Rental
                </span>
                <p className={styles.statusDesc}>
                  Your rental is now active. Please return the vehicle by the agreed return time to your assigned LUXUAR agency.
                </p>
              </div>
            )}

            {reservation.status === 'completed' && (
              <div className={`${styles.statusHero} ${styles.statusCompleted}`}>
                <span className={styles.statusTag} style={{ background: 'var(--success)', color: '#fff' }}>
                  Completed &amp; Settled
                </span>
                <p className={styles.statusDesc}>
                  Your rental journey is concluded. Your return has been confirmed by LUXUAR and your security deposit settlement has been finalized.
                </p>
                <div className={styles.refundBlock}>
                  <span className={styles.refundTitle}>Deposit Settlement</span>
                  <div className={styles.inspectionList}>
                    <div className={styles.inspectionRow}>
                      <dt>Deposit Refunded</dt>
                      <dd style={{ color: 'var(--success)' }}>
                        <Price value={reservation.depositRefundedAmount || reservation.depositAmount} />
                      </dd>
                    </div>
                    <div className={styles.inspectionRow}>
                      <dt>Retained (Damages/Fees)</dt>
                      <dd style={{ color: Number(reservation.depositRetainedAmount) > 0 ? 'var(--danger)' : 'var(--muted)' }}>
                        <Price value={reservation.depositRetainedAmount || '0'} />
                      </dd>
                    </div>
                    {reservation.stripeRefundId && (
                      <div className={styles.inspectionRow} style={{ gridColumn: 'span 2' }}>
                        <dt>Stripe Refund Reference</dt>
                        <dd style={{ fontFamily: 'monospace', fontSize: '11px' }}>{reservation.stripeRefundId}</dd>
                      </div>
                    )}
                    {reservation.depositRetentionReason && (
                      <div className={styles.inspectionRow} style={{ gridColumn: 'span 2' }}>
                        <dt>Adjustment Reason</dt>
                        <dd>{reservation.depositRetentionReason}</dd>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {reservation.status === 'cancelled_unpaid' && (
              <div className={`${styles.statusHero} ${styles.statusCancelled}`}>
                <span className={styles.statusTag} style={{ background: 'var(--danger)', color: '#fff' }}>
                  Payment Expired
                </span>
                <p className={styles.statusDesc}>
                  The 24-hour payment window for this reservation elapsed without a verified Stripe payment. In accordance with LUXUAR reservation terms, the vehicle hold has been released.
                </p>
                <Link href="/vehicles" className={styles.payButton} style={{ textDecoration: 'none', textAlign: 'center' }}>
                  Browse Available Fleet
                </Link>
              </div>
            )}

            {reservation.status === 'rejected' && (
              <div className={`${styles.statusHero} ${styles.statusRejected}`}>
                <span className={styles.statusTag} style={{ background: 'var(--danger)', color: '#fff' }}>
                  Declined
                </span>
                <p className={styles.statusDesc}>
                  Your reservation request could not be accepted.
                  {reservation.decisionReason ? ` Reason: ${reservation.decisionReason}` : ''}
                </p>
                <Link href="/vehicles" className={styles.payButton} style={{ textDecoration: 'none', textAlign: 'center' }}>
                  Browse Available Fleet
                </Link>
              </div>
            )}

            {/* Rental period */}
            <div>
              <h2 className={styles.panelTitle}>Rental Period</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginTop: '16px' }}>
                <div className={styles.specItem}>
                  <span className={styles.specLabel}>Rental start</span>
                  <span className={styles.specValue}>{new Date(reservation.pickupAt).toLocaleString('en-GB')}</span>
                </div>
                <div className={styles.specItem}>
                  <span className={styles.specLabel}>Return</span>
                  <span className={styles.specValue}>{new Date(reservation.returnAt).toLocaleString('en-GB')}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Financial Breakdown & Vehicle Presentation */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
            {/* Vehicle Presentation Card */}
            <div className={styles.vehicleCard}>
              <div className={styles.vehicleMedia}>
                {reservation.imageUrl ? (
                  <img src={reservation.imageUrl} alt={vName} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)' }}>
                    LUXUAR FLEET
                  </div>
                )}
              </div>
              <div className={styles.vehicleBody}>
                <h3 className={styles.vehicleName}>{vName}</h3>
                <div className={styles.vehicleSpecs}>
                  <div className={styles.specItem}>
                    <span className={styles.specLabel}>Duration</span>
                    <span className={styles.specValue}>{reservation.rentalDays} day(s)</span>
                  </div>
                  <div className={styles.specItem}>
                    <span className={styles.specLabel}>Daily Rate</span>
                    <span className={styles.specValue}><Price value={reservation.dailyPrice} /></span>
                  </div>
                  {reservation.licensePlate && (
                    <div className={styles.specItem}>
                      <span className={styles.specLabel}>Plate</span>
                      <span className={styles.specValue}>{reservation.licensePlate}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Financial Separation Card */}
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>Financial Summary</h2>
              <div className={styles.pricingTable}>
                <div className={styles.priceRow}>
                  <span>Vehicle Rental ({reservation.rentalDays} days)</span>
                  <span><Price value={Number(reservation.dailyPrice) * reservation.rentalDays} /></span>
                </div>
                {Number(reservation.extrasAmount) > 0 && (
                  <div className={styles.priceRow}>
                    <span>Optional Services</span>
                    <span><Price value={reservation.extrasAmount!} /></span>
                  </div>
                )}
                {Number(reservation.discountAmount) > 0 && (
                  <div className={styles.priceRow} style={{ color: 'var(--success)' }}>
                    <span>Promotion Discount</span>
                    <span>-<Price value={reservation.discountAmount!} /></span>
                  </div>
                )}
                <div className={styles.priceRow} style={{ fontWeight: 600 }}>
                  <span>Rental Total</span>
                  <span><Price value={reservation.totalAmount} /></span>
                </div>
                <div className={styles.priceRow} style={{ color: 'var(--gold-text)', fontWeight: 600 }}>
                  <span>Refundable Security Deposit</span>
                  <span><Price value={reservation.depositAmount} /></span>
                </div>
                <div className={styles.priceRowTotal}>
                  <span>Total Amount</span>
                  <span><Price value={grandTotal} /></span>
                </div>
              </div>

              <div className={styles.depositNotice}>
                <strong>Security Deposit Policy:</strong> The security deposit is separate from the rental price and is refundable according to the rental terms after your return is confirmed.
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
