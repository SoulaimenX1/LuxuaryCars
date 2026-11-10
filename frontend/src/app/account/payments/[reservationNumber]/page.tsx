'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import styles from './payment-detail.module.css';

interface PaymentItem {
  id: string;
  type: string;
  method: string;
  amount: string;
  currency: string;
  paidAt: string;
  reference: string | null;
  provider?: string | null;
  notes?: string | null;
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
  agencyPaymentStatus?: string | null;
  agencyPaymentRequestedAt?: string | null;
  agencyPaymentAgencyName?: string | null;
  agencyPaymentDecidedAt?: string | null;
  agencyPaymentDecisionNotes?: string | null;
  manualPaymentMethod?: string | null;
}

interface FinancialSummary {
  reservation: FinancialReservation;
  payments: PaymentItem[];
  deposit: {
    id: string | null;
    status: string;
    amount: string;
    retainedAmount: string;
    retentionReason: string | null;
  };
  amountPaidEur: string;
  outstandingEur: string;
  paymentStatus: string;
  refundedEur: string;
}

function formatAmount(val: string | number | undefined | null): string {
  const num = Number(val || 0);
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

export default function ReservationPaymentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  const reservationNumber = typeof params?.reservationNumber === 'string' ? params.reservationNumber : '';
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<FinancialSummary | null>(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [paying, setPaying] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Payment method selection: 'card' | 'agency'
  const [selectedMethod, setSelectedMethod] = useState<'card' | 'agency'>('card');

  // Card Form State
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvc, setCardCvc] = useState('');
  const [cardholderName, setCardholderName] = useState('');
  const [billingCountry, setBillingCountry] = useState('FR');
  const [billingZip, setBillingZip] = useState('75008');

  // Agency Form State
  const selectedAgency = 'Agency Counter';
  const [agencyNotes, setAgencyNotes] = useState('');

  const successParam = searchParams.get('success');
  const canceledParam = searchParams.get('canceled');

  // Clock tick for countdown
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch summary by reservation number
  const loadData = useCallback(async () => {
    if (!reservationNumber) return;
    try {
      const authRes = await fetch('/api/auth/me', { cache: 'no-store' });
      if (authRes.status === 401) {
        router.replace('/login');
        return;
      }

      const res = await fetch(`/api/finance/me/reservations/${encodeURIComponent(reservationNumber)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('Reservation financial record not found or access denied.');
      }
      const data: FinancialSummary = await res.json();
      setSummary(data);
      if (data.reservation?.customerName) {
        setCardholderName((prev) => prev || data.reservation.customerName);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error loading payment details';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [reservationNumber, router]);

  useEffect(() => {
    const run = async () => {
      await loadData();
    };
    void run();
  }, [loadData]);

  // Quick fill test card
  const handleQuickFillTestCard = () => {
    setCardNumber('4242 4242 4242 4242');
    setCardExpiry('12/28');
    setCardCvc('888');
    setCardholderName(summary?.reservation?.customerName || 'SOULAIMEN BEN SALAH');
    setBillingCountry('FR');
    setBillingZip('75008');
  };

  // Card format helpers
  const handleCardNumberChange = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 16);
    const parts = clean.match(/.{1,4}/g);
    setCardNumber(parts ? parts.join(' ') : clean);
  };

  const handleExpiryChange = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 4);
    if (clean.length > 2) {
      setCardExpiry(`${clean.slice(0, 2)}/${clean.slice(2)}`);
    } else {
      setCardExpiry(clean);
    }
  };

  // Process Card Payment
  const handlePayCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reservationNumber || paying) return;

    const rawCardNumber = cardNumber.replace(/\s+/g, '');
    if (rawCardNumber.length < 16) {
      setError('Please enter a valid 16-digit card number.');
      return;
    }
    if (!cardExpiry.includes('/') || cardExpiry.length < 5) {
      setError('Please enter an expiration date in MM/YY format.');
      return;
    }
    if (cardCvc.length < 3) {
      setError('Please enter a valid CVC code.');
      return;
    }
    if (!cardholderName.trim()) {
      setError('Please enter the cardholder name.');
      return;
    }

    setPaying(true);
    setError('');
    setSuccessMsg('');

    try {
      const res = await fetch(`/api/finance/confirm-card-payment/${encodeURIComponent(reservationNumber)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardNumber: rawCardNumber,
          cardExpiry,
          cardCvc,
          cardholderName: cardholderName.trim(),
          billingCountry,
          billingZip,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || 'Payment confirmation failed.');
      }

      setSuccessMsg('Payment confirmed successfully! Your luxury booking is now locked in.');
      await loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Payment error occurred';
      setError(msg);
    } finally {
      setPaying(false);
    }
  };

  // Request Agency Payment
  const handleRequestAgencyPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reservationNumber || paying) return;

    if (!selectedAgency) {
      setError('Please select a pickup agency for payment.');
      return;
    }

    setPaying(true);
    setError('');
    setSuccessMsg('');

    try {
      const res = await fetch(`/api/finance/agency-payment/request/${encodeURIComponent(reservationNumber)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyName: selectedAgency,
          notes: agencyNotes.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || 'Failed to submit agency payment request.');
      }

      setSuccessMsg('Agency payment request submitted. Awaiting Admin authorization.');
      await loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error submitting request';
      setError(msg);
    } finally {
      setPaying(false);
    }
  };

  // Fallback: Redirect to Stripe Hosted Checkout
  const handleStripeCheckoutRedirect = async () => {
    if (!reservationNumber || paying) return;
    setPaying(true);
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
        throw new Error('No payment URL returned.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Checkout initiation failed';
      setError(msg);
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.page}>
        <div style={{ textAlign: 'center', padding: '120px 20px', fontFamily: 'var(--sans)', letterSpacing: '0.12em', color: 'var(--muted)', textTransform: 'uppercase' }}>
          Loading luxury payment portal...
        </div>
      </div>
    );
  }

  if (!summary || (error && !summary.reservation)) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <Link href="/account/payments" className={styles.backLink}>
            ← Back to Payments
          </Link>
          <div className={styles.formPanel} style={{ textAlign: 'center', padding: '48px 24px' }}>
            <h3 className={styles.panelTitle} style={{ marginBottom: '12px' }}>Reservation Not Found</h3>
            <p style={{ color: 'var(--muted)', fontSize: '14px', marginBottom: '24px' }}>
              {error || 'Unable to retrieve financial record for this reservation.'}
            </p>
            <Link href="/account/payments" className={styles.payButton} style={{ display: 'inline-flex' }}>
              View All Payments →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { reservation: r, payments } = summary;
  const isAwaiting = r.status === 'awaiting_payment';
  const isConfirmed = r.status === 'confirmed' || r.status === 'active_rental' || r.status === 'completed';
  const countdown = isAwaiting ? formatTimeRemaining(r.paymentDeadlineAt, now) : null;
  const totalDue = Number(r.totalAmount) + Number(r.depositAmount);

  // Agency payment state
  const isAgencyRequested = r.agencyPaymentStatus === 'agency_payment_requested';
  const isAgencyRejected = r.agencyPaymentStatus === 'agency_payment_rejected' || r.agencyPaymentStatus === 'rejected';

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link href="/account/payments" className={styles.backLink}>
          ← Back to All Payments &amp; Deposits
        </Link>

        {/* Feedback banners */}
        {successParam && (
          <div className={styles.bannerSuccess}>
            ✓ <strong>Stripe Checkout Verified!</strong> Your payment has been received and your booking is confirmed.
          </div>
        )}

        {canceledParam && (
          <div className={styles.bannerWarning}>
            ⚠ <strong>Checkout canceled.</strong> You can initiate payment whenever you are ready before the 24h deadline expires.
          </div>
        )}

        {successMsg && (
          <div className={styles.bannerSuccess}>
            ✓ {successMsg}
          </div>
        )}

        {error && (
          <div className={styles.bannerError}>
            ✕ {error}
          </div>
        )}

        {/* Agency payment rejected notice */}
        {isAgencyRejected && isAwaiting && (
          <div className={styles.bannerWarning}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <strong>Agency Payment Request Declined</strong>
              <span>
                {r.agencyPaymentDecisionNotes
                  ? `Reason: ${r.agencyPaymentDecisionNotes}`
                  : 'Your agency payment request was not approved. You can pay securely online with card below.'}
              </span>
            </div>
          </div>
        )}

        {/* Expired payment window notice */}
        {isAwaiting && countdown?.isExpired && (
          <div className={styles.bannerError}>
            ⏱ <strong>Payment window has expired.</strong> This reservation can no longer be settled online.
          </div>
        )}

        {/* Hero Header */}
        <header className={styles.hero}>
          <div>
            <span className={styles.eyebrow}>LUXURY PAYMENT PORTAL</span>
            <h1 className={styles.title}>{r.reservationNumber}</h1>
            <p className={styles.subtitle}>
              {r.vehicleName} · {formatDateTime(r.pickupAt)} → {formatDateTime(r.returnAt)}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {isAgencyRequested && (
              <span className={`${styles.statusTag} ${styles.statusRequested}`}>
                Awaiting Agency Approval
              </span>
            )}
            <span
              className={`${styles.statusTag} ${
                r.status === 'awaiting_payment'
                  ? styles.statusAwaiting
                  : r.status === 'confirmed' || r.status === 'active_rental'
                  ? styles.statusConfirmed
                  : r.status === 'completed'
                  ? styles.statusConfirmed
                  : styles.statusRejected
              }`}
            >
              {r.status.replaceAll('_', ' ')}
            </span>
          </div>
        </header>

        {/* Main Grid: Payment Action (Left) + Financial Sidebar (Right) */}
        <div className={styles.mainGrid}>
          {/* LEFT COLUMN */}
          <div className={styles.paymentStage}>
            {/* If Confirmed: show success status callout */}
            {isConfirmed ? (
              <div className={styles.statusCallout}>
                <h3 className={styles.statusCalloutTitle}>
                  <span style={{ color: 'var(--success)' }}>✓</span> Payment Settled &amp; Booking Confirmed
                </h3>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px', lineHeight: '1.6' }}>
                  {r.manualPaymentMethod
                    ? `Settled via Agency Payment (${r.agencyPaymentAgencyName || 'Physical Agency'}). Your vehicle is reserved and awaiting handover.`
                    : 'Your online card payment and refundable security deposit have been verified. Your vehicle is reserved.'}
                </p>

                <dl className={styles.statusMetaList}>
                  <div>
                    <dt>Reservation Reference</dt>
                    <dd>{r.reservationNumber}</dd>
                  </div>
                  <div>
                    <dt>Settlement Method</dt>
                    <dd>
                      {r.manualPaymentMethod === 'manual_agency' || r.manualPaymentMethod === 'PAID_MANUALLY'
                        ? 'Agency Payment (Authorized)'
                        : 'Credit Card (Stripe Secured)'}
                    </dd>
                  </div>
                  <div>
                    <dt>Rental Total Paid</dt>
                    <dd>€{formatAmount(r.totalAmount)} EUR</dd>
                  </div>
                  <div>
                    <dt>Deposit Guarantee</dt>
                    <dd>€{formatAmount(r.depositAmount)} EUR</dd>
                  </div>
                  {r.paidAt && (
                    <div>
                      <dt>Confirmation Timestamp</dt>
                      <dd>{formatDateTime(r.paidAt)}</dd>
                    </div>
                  )}
                </dl>
              </div>
            ) : isAgencyRequested ? (
              /* Awaiting Agency Approval State */
              <div className={styles.statusCallout}>
                <h3 className={styles.statusCalloutTitle}>
                  <span style={{ color: 'var(--gold)' }}>⏳</span> Awaiting Agency Payment Approval
                </h3>
                <p style={{ margin: 0, color: 'var(--ink)', fontSize: '13px', lineHeight: '1.6' }}>
                  Your request to settle at our agency counter has been submitted.
                  Our concierge team will review and approve your booking shortly.
                </p>

                <dl className={styles.statusMetaList}>
                  <div>
                    <dt>Requested Timestamp</dt>
                    <dd>{formatDateTime(r.agencyPaymentRequestedAt || new Date().toISOString())}</dd>
                  </div>
                  <div>
                    <dt>Amount Due at Pickup</dt>
                    <dd>€{formatAmount(totalDue)} EUR</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd style={{ color: 'var(--gold)' }}>PENDING ADMIN APPROVAL</dd>
                  </div>
                </dl>

                <div style={{ marginTop: '16px', borderTop: '1px solid var(--line)', paddingTop: '16px' }}>
                  <p style={{ fontSize: '12px', color: 'var(--muted)', margin: '0 0 12px' }}>
                    Need to expedite or prefer immediate card confirmation? You can switch back to card payment anytime.
                  </p>
                  <button
                    type="button"
                    className={styles.secondaryAction}
                    onClick={() => setSelectedMethod('card')}
                  >
                    Switch to Instant Card Payment →
                  </button>
                </div>
              </div>
            ) : isAwaiting ? (
              /* ACTIVE PAYMENT SELECTION & CHECKOUT FORM */
              <>
                {/* Method Selector Tabs */}
                <div className={styles.methodSelectorGrid}>
                  <div
                    className={`${styles.methodCard} ${selectedMethod === 'card' ? styles.methodCardActive : ''}`}
                    onClick={() => setSelectedMethod('card')}
                    role="button"
                    tabIndex={0}
                  >
                    <span className={styles.methodBadge}>OPTION A — RECOMMENDED</span>
                    <h3 className={styles.methodTitle}>Pay Online by Card</h3>
                    <p className={styles.methodDesc}>
                      Instant confirmation via 256-bit encrypted luxury payment form. Test mode enabled.
                    </p>
                  </div>

                  <div
                    className={`${styles.methodCard} ${selectedMethod === 'agency' ? styles.methodCardActive : ''}`}
                    onClick={() => setSelectedMethod('agency')}
                    role="button"
                    tabIndex={0}
                  >
                    <span className={styles.methodBadge}>OPTION B — PICKUP</span>
                    <h3 className={styles.methodTitle}>Pay at Agency</h3>
                    <p className={styles.methodDesc}>
                      Request manual payment upon arrival at our boutique agency. Requires Admin approval.
                    </p>
                  </div>
                </div>

                {/* OPTION A: EMBEDDED CARD PAYMENT FORM */}
                {selectedMethod === 'card' && (
                  <div className={styles.formPanel}>
                    <div className={styles.panelHeader}>
                      <div>
                        <h3 className={styles.panelTitle}>Credit &amp; Debit Card</h3>
                        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--muted)' }}>
                          Real Stripe Test Mode integration with instant booking confirmation.
                        </p>
                      </div>
                      <span className={styles.secureBadge}>🔒 256-BIT ENCRYPTED</span>
                    </div>

                    {/* Quick-fill bar for seamless testing */}
                    <div className={styles.quickFillBar} style={{ marginBottom: '20px' }}>
                      <span style={{ color: 'var(--muted)' }}>
                        <strong>Stripe Test Mode</strong>: Click to fill standard test credentials
                      </span>
                      <button
                        type="button"
                        className={styles.quickFillBtn}
                        onClick={handleQuickFillTestCard}
                      >
                        ⚡ Fill Test Card (4242)
                      </button>
                    </div>

                    <form onSubmit={handlePayCard} className={styles.cardForm}>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel} htmlFor="cardholderName">
                          Cardholder Full Name
                        </label>
                        <input
                          id="cardholderName"
                          type="text"
                          className={styles.input}
                          placeholder="e.g. Jean Dupont"
                          value={cardholderName}
                          onChange={(e) => setCardholderName(e.target.value)}
                          required
                        />
                      </div>

                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel} htmlFor="cardNumber">
                          Card Number
                        </label>
                        <input
                          id="cardNumber"
                          type="text"
                          className={styles.input}
                          placeholder="4242 4242 4242 4242"
                          maxLength={19}
                          value={cardNumber}
                          onChange={(e) => handleCardNumberChange(e.target.value)}
                          required
                        />
                      </div>

                      <div className={styles.row2}>
                        <div className={styles.fieldGroup}>
                          <label className={styles.fieldLabel} htmlFor="cardExpiry">
                            Expires (MM/YY)
                          </label>
                          <input
                            id="cardExpiry"
                            type="text"
                            className={styles.input}
                            placeholder="12/28"
                            maxLength={5}
                            value={cardExpiry}
                            onChange={(e) => handleExpiryChange(e.target.value)}
                            required
                          />
                        </div>

                        <div className={styles.fieldGroup}>
                          <label className={styles.fieldLabel} htmlFor="cardCvc">
                            CVC / Security Code
                          </label>
                          <input
                            id="cardCvc"
                            type="password"
                            className={styles.input}
                            placeholder="•••"
                            maxLength={4}
                            value={cardCvc}
                            onChange={(e) => setCardCvc(e.target.value.replace(/\D/g, ''))}
                            required
                          />
                        </div>
                      </div>

                      <div className={styles.row2}>
                        <div className={styles.fieldGroup}>
                          <label className={styles.fieldLabel} htmlFor="billingCountry">
                            Country / Region
                          </label>
                          <select
                            id="billingCountry"
                            className={styles.input}
                            value={billingCountry}
                            onChange={(e) => setBillingCountry(e.target.value)}
                          >
                            <option value="FR">France</option>
                            <option value="HU">Hungary</option>
                            <option value="MC">Monaco</option>
                            <option value="CH">Switzerland</option>
                            <option value="DE">Germany</option>
                            <option value="GB">United Kingdom</option>
                            <option value="US">United States</option>
                            <option value="AE">United Arab Emirates</option>
                          </select>
                        </div>

                        <div className={styles.fieldGroup}>
                          <label className={styles.fieldLabel} htmlFor="billingZip">
                            Postal Code
                          </label>
                          <input
                            id="billingZip"
                            type="text"
                            className={styles.input}
                            placeholder="75008"
                            value={billingZip}
                            onChange={(e) => setBillingZip(e.target.value)}
                          />
                        </div>
                      </div>

                      <button
                        type="submit"
                        className={styles.payButton}
                        disabled={paying || countdown?.isExpired}
                      >
                        {paying ? 'Authorizing & Settling...' : `Authorize & Pay €${formatAmount(totalDue)} EUR →`}
                      </button>

                      <div style={{ textAlign: 'center', marginTop: '12px' }}>
                        <button
                          type="button"
                          className={styles.secondaryAction}
                          onClick={() => void handleStripeCheckoutRedirect()}
                          disabled={paying}
                        >
                          Or Pay via Stripe Hosted Checkout Page →
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* OPTION B: PAY AT AGENCY (MANUAL PAYMENT) */}
                {selectedMethod === 'agency' && (
                  <div className={styles.formPanel}>
                    <div className={styles.panelHeader}>
                      <div>
                        <h3 className={styles.panelTitle}>Pay at Boutique Agency</h3>
                        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--muted)' }}>
                          Settle your rental subtotal and security deposit in person upon vehicle pickup.
                        </p>
                      </div>
                      <span className={styles.secureBadge}>MANUAL ATTESTATION</span>
                    </div>

                    <div className={styles.agencyNotice}>
                      <strong>Agency Settlement Policy:</strong>
                      <br />
                      You may pay in cash, debit card or bank transfer directly at our counter upon vehicle handover.
                      Submitting this request alerts our concierge fleet team for instant approval.
                    </div>

                    <form onSubmit={handleRequestAgencyPayment} className={styles.cardForm}>
                      <div className={styles.fieldGroup}>
                        <label className={styles.fieldLabel} htmlFor="agencyNotes">
                          Special Handover Requests or Preferred Arrival Time (Optional)
                        </label>
                        <textarea
                          id="agencyNotes"
                          rows={3}
                          className={styles.input}
                          placeholder="e.g. Will arrive at 14:00, paying with corporate platinum card at agency counter."
                          value={agencyNotes}
                          onChange={(e) => setAgencyNotes(e.target.value)}
                        />
                      </div>

                      <button
                        type="submit"
                        className={styles.payButton}
                        disabled={paying || countdown?.isExpired}
                      >
                        {paying ? 'Submitting Request...' : 'REQUEST AGENCY PAYMENT →'}
                      </button>
                    </form>
                  </div>
                )}
              </>
            ) : (
              /* Expired or other status */
              <div className={styles.formPanel}>
                <h3 className={styles.panelTitle}>Payment Window Closed</h3>
                <p style={{ color: 'var(--muted)', fontSize: '14px', margin: '8px 0 20px' }}>
                  This reservation is in {r.status} status and cannot be paid online. Please contact concierge support.
                </p>
                <Link href="/account/reservations" className={styles.secondaryAction} style={{ display: 'inline-block' }}>
                  Return to Reservations
                </Link>
              </div>
            )}
          </div>

          {/* RIGHT COLUMN: FINANCIAL SIDEBAR */}
          <aside className={styles.sidebarCard}>
            <div className={styles.vehicleMedia}>
              {r.vehiclePhoto ? (
                <img src={r.vehiclePhoto} alt={r.vehicleName} className={styles.vehicleImg} />
              ) : (
                <div className={styles.vehicleFallback}>
                  <span>LUXUAR</span>
                </div>
              )}
            </div>

            <div className={styles.sidebarContent}>
              <div className={styles.vehicleHead}>
                <h2 className={styles.vehicleName}>{r.vehicleName}</h2>
                <p className={styles.rentalDates}>
                  {formatDateTime(r.pickupAt)} &rarr; {formatDateTime(r.returnAt)} ({r.rentalDays || 1} Days)
                </p>
              </div>

              {/* 24-Hour Countdown Box */}
              {isAwaiting && (
                <div className={styles.countdownBox}>
                  <div>
                    <span className={styles.countdownLabel}>24h Payment Window</span>
                    <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>
                      Auto-cancellation if unpaid
                    </div>
                  </div>
                  <div className={styles.countdownDigits}>
                    {countdown?.isExpired ? 'EXPIRED' : countdown?.formatted}
                  </div>
                </div>
              )}

              {/* Financial Breakdown */}
              <div className={styles.breakdownList}>
                <div className={styles.breakdownRow}>
                  <span>Daily Rate</span>
                  <strong>€{formatAmount(r.dailyPrice || (Number(r.totalAmount) / (r.rentalDays || 1)))}</strong>
                </div>
                <div className={styles.breakdownRow}>
                  <span>Rental Duration</span>
                  <strong>{r.rentalDays || 1} Days</strong>
                </div>
                <div className={styles.breakdownRow}>
                  <span>Rental Subtotal</span>
                  <strong>€{formatAmount(r.totalAmount)} EUR</strong>
                </div>
                <div className={styles.breakdownRow}>
                  <span>Refundable Security Deposit</span>
                  <strong>€{formatAmount(r.depositAmount)} EUR</strong>
                </div>

                <div className={styles.totalRow}>
                  <span className={styles.totalLabel}>Total Due</span>
                  <span className={styles.totalValue}>€{formatAmount(totalDue)}</span>
                </div>
              </div>

              {/* Security Deposit Guarantee Notice */}
              <div className={styles.depositCallout}>
                <strong>Refundable Security Deposit Guarantee</strong>
                The €{formatAmount(r.depositAmount)} deposit is fully refunded back to your payment method immediately upon inspection when the vehicle is returned in good order.
              </div>
            </div>
          </aside>
        </div>

        {/* TRANSACTIONS & RECEIPTS LEDGER */}
        {payments && payments.length > 0 && (
          <section className={styles.transactionsSection}>
            <h3 className={styles.transactionsTitle}>Payment History &amp; Official Receipts</h3>
            <div className={styles.txList}>
              {payments.map((p) => (
                <div key={p.id} className={styles.txItem}>
                  <div>
                    <span className={styles.txType}>{p.type.replaceAll('_', ' ')}</span>
                    <span className={styles.txMeta}>
                      {formatDateTime(p.paidAt)} · Method: {p.method}
                      {p.reference ? ` · Ref: ${p.reference}` : ''}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <span className={styles.txAmount}>€{formatAmount(p.amount)} EUR</span>
                    <a
                      href={`/api/finance/me/payments/${p.id}/receipt`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.receiptButton}
                    >
                      📄 Download Receipt PDF
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
