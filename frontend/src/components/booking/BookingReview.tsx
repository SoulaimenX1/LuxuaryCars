'use client';

import { Price } from '@/components/currency-provider';
import type { AvailabilityCheckResult, BookingQuote } from '@/lib/booking';
import styles from './booking.module.css';

// ==========================================================
// REVUE ET CONFIRMATION
// ==========================================================
//
// La confirmation appelle le service NestJS réel : disponibilité
// revérifiée, prix recalculé, réservation enregistrée en
// PostgreSQL. Aucun paiement n'est simulé.

export default function BookingReview({
  vehicleLabel,
  // agencyLabel,
  pickupLabel,
  returnLabel,
  quote,
  availability,
  checking,
  submitting,
  error,
  disabled,
  onConfirm,
}: {
  vehicleLabel: string;
  agencyLabel: string;
  pickupLabel: string;
  returnLabel: string;
  quote: BookingQuote | null;
  availability: AvailabilityCheckResult | null;
  checking: boolean;
  submitting: boolean;
  error: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const available = availability?.available === true;

  return (
    <div>
      {error && (
        <div className={styles.errorBox} role="alert">
          {error}
        </div>
      )}

      {!checking && availability && !available && (
        <div className={styles.errorBox} role="alert">
          {availability.message ?? 'This period is not available for the selected vehicle.'}
        </div>
      )}

      {available && (
        <div className={styles.noticeBox}>
          Availability confirmed for the selected interval.
        </div>
      )}

      <ul className={styles.reviewList}>
        <li>
          <span>Vehicle</span>
          <span>{vehicleLabel}</span>
        </li>
        <li>
          <span>Rental start</span>
          <span>{pickupLabel}</span>
        </li>
        <li>
          <span>Return date &amp; time</span>
          <span>{returnLabel}</span>
        </li>
        <li>
          <span>Duration</span>
          <span>
            {quote ? `${quote.rentalDays} ${quote.rentalDays === 1 ? 'day' : 'days'}` : '—'}
          </span>
        </li>
        <li>
          <span>Rental total</span>
          <span>{quote ? <Price value={quote.totalAmount} /> : '—'}</span>
        </li>
        <li>
          <span>Security deposit</span>
          <span>{quote ? <Price value={quote.depositAmount} /> : '—'}</span>
        </li>
      </ul>

      {checking && <p className={styles.loading}>Verifying availability…</p>}

      <button
        type="button"
        className={styles.confirmButton}
        disabled={disabled || checking || submitting}
        onClick={onConfirm}
      >
        {submitting ? 'Confirming…' : 'Confirm reservation'}
      </button>

      <p className={styles.terms} style={{ listStyle: 'none', paddingLeft: 0 }}>
        Your request is reviewed by our team first. No payment is taken now: once approved, you have 24
        hours to pay securely online from My Payments, and the reservation is confirmed only after your
        payment is verified. The security deposit is shown separately and is refundable according to the
        rental terms.
      </p>
    </div>
  );
}
