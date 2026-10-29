'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useConfirm } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';
import styles from './reservation-finance.module.css';

interface Payment {
  id: string;
  type: string;
  method: string;
  amount: string;
  currency: string;
  paidAt: string;
  reference: string | null;
}

interface FinanceSummary {
  reservation: {
    id: string;
    reservationNumber: string;
    status: string;
    customerName: string;
    vehicleName: string;
    pickupAt: string;
    returnAt: string;
    totalAmount: string;
    depositAmount: string;
  };
  rental: {
    id: string;
    status: string;
    contractNumber: string;
  } | null;
  payments: Payment[];
  charges: { id: string; type: string; description: string; amount: string }[];
  deposit: {
    status: string;
    requiredAmount: string;
    receivedAmount: string;
    outstandingAmount: string;
    releasedAmount: string;
    refundedAmount: string;
    retainedAmount: string;
    retentionReason: string | null;
  };
  invoices: { id: string; invoiceNumber: string; totalAmount: string }[];
  amountPaidEur: string;
  outstandingEur: string;
  paymentStatus: string;
}

interface Props {
  reservationId: string;
  reservationStatus: string;
}

const euro = (value: string) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
  }).format(Number(value));

const endpoint = (path: string) => `/api/admin/operations/${path}`;

async function responseError(response: Response) {
  try {
    const body: { message?: string | string[] } = await response.json();
    return Array.isArray(body.message)
      ? body.message.join(' ')
      : body.message ?? `Request failed (HTTP ${response.status})`;
  } catch {
    return `Request failed (HTTP ${response.status})`;
  }
}

export function ReservationFinancePanel({
  reservationId,
  reservationStatus,
}: Props) {
  const confirm = useConfirm();
  const toast = useToast();
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [paymentType, setPaymentType] =
    useState<'rental_payment' | 'refund'>('rental_payment');

  async function load() {
    const response = await fetch(
      endpoint(`finance/reservations/${reservationId}`),
      { cache: 'no-store' },
    );
    if (!response.ok) throw new Error(await responseError(response));
    setSummary(await response.json() as FinanceSummary);
  }

  useEffect(() => {
    let active = true;
    void fetch(endpoint(`finance/reservations/${reservationId}`), {
      cache: 'no-store',
    }).then(async response => {
      if (!response.ok) throw new Error(await responseError(response));
      return response.json() as Promise<FinanceSummary>;
    }).then(data => {
      if (active) setSummary(data);
    }).catch(caught => {
      if (active) {
        setError(caught instanceof Error
          ? caught.message
          : 'Unable to load financial dossier.');
      }
    });
    return () => { active = false; };
  }, [reservationId]);

  async function record(
    suffix: string,
    body: Record<string, string | number>,
    confirmation: string,
  ) {
    if (busy || !(await confirm({
      title: 'Record verified funds',
      message: `${confirmation} No gateway charge will be initiated.`,
      confirmLabel: 'Record verified entry',
    }))) return;

    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        endpoint(`finance/reservations/${reservationId}/${suffix}`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      await load();
      setAmount('');
      setDepositAmount('');
      setReference('');
      toast.success('Verified financial entry recorded.', 'Finance');
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : 'Unable to record financial entry.';
      setError(message);
      toast.error(message, 'Finance');
    } finally {
      setBusy(false);
    }
  }

  function submitPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!summary) return;
    const transactionType = canCollect ? paymentType : 'refund';
    void record(
      'payments',
      {
        type: transactionType,
        method,
        amount: Number(amount),
        reference,
      },
      `${transactionType === 'refund' ? 'Record an externally verified refund' : 'Record a verified rental payment'} of ${amount} EUR against ${summary.reservation.reservationNumber}?`,
    );
  }

  function submitDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!summary) return;
    void record(
      'deposit/receipt',
      {
        method,
        amount: Number(depositAmount),
        reference,
      },
      `Record ${depositAmount} EUR as an externally received security deposit for ${summary.reservation.reservationNumber}?`,
    );
  }

  if (error && !summary) {
    return <p className={styles.error} role="alert">{error}</p>;
  }
  if (!summary) return <p className={styles.loading}>Loading financial dossier…</p>;

  const canCollect = ['confirmed', 'converted'].includes(reservationStatus) &&
    summary.rental?.status !== 'closed' &&
    Number(summary.outstandingEur) > 0;
  const canRefund = Number(summary.amountPaidEur) > 0;
  const canReceiveDeposit = ['confirmed', 'converted'].includes(reservationStatus) &&
    summary.rental?.status !== 'closed' &&
    Number(summary.deposit.outstandingAmount) > 0;
  const displayedPaymentType = canCollect ? paymentType : 'refund';

  return (
    <section className={styles.panel} aria-label="Reservation financial dossier">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>FINANCIAL DOSSIER</p>
          <h3>{summary.reservation.reservationNumber}</h3>
        </div>
        <span className={styles.status}>{summary.paymentStatus.replaceAll('_', ' ')}</span>
      </header>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <div className={styles.details}>
        <div><span>Customer</span><strong>{summary.reservation.customerName}</strong></div>
        <div><span>Vehicle</span><strong>{summary.reservation.vehicleName}</strong></div>
        <div><span>Rental dates</span><strong>{new Date(summary.reservation.pickupAt).toLocaleDateString('en-GB')} – {new Date(summary.reservation.returnAt).toLocaleDateString('en-GB')}</strong></div>
        <div><span>Agreed rental price</span><strong>{euro(summary.reservation.totalAmount)}</strong></div>
        <div><span>Amount paid</span><strong>{euro(summary.amountPaidEur)}</strong></div>
        <div><span>Outstanding balance</span><strong>{euro(summary.outstandingEur)}</strong></div>
        <div><span>Required deposit</span><strong>{euro(summary.deposit.requiredAmount)}</strong></div>
        <div><span>Deposit received / outstanding</span><strong>{euro(summary.deposit.receivedAmount)} / {euro(summary.deposit.outstandingAmount)}</strong></div>
        <div><span>Deposit status</span><strong>{summary.deposit.status.replaceAll('_', ' ')}</strong></div>
        <div><span>Deposit refunded / retained</span><strong>{euro(summary.deposit.refundedAmount)} / {euro(summary.deposit.retainedAmount)}</strong></div>
        {summary.rental && <div><span>Rental contract</span><strong>{summary.rental.contractNumber} ({summary.rental.status})</strong></div>}
      </div>

      {summary.deposit.retentionReason && (
        <p className={styles.note}>Deposit retention reason: {summary.deposit.retentionReason}</p>
      )}

      {(canCollect || canRefund || canReceiveDeposit) && (
        <div className={styles.forms}>
          {(canCollect || canRefund) && (
            <form onSubmit={submitPayment}>
              <h4>{displayedPaymentType === 'refund' ? 'Record verified refund' : 'Record verified rental payment'}</h4>
              {(canCollect && canRefund) && (
                <label>Transaction type
                  <select value={paymentType} onChange={event => {
                    setPaymentType(event.target.value as 'rental_payment' | 'refund');
                    setAmount('');
                  }}>
                    <option value="rental_payment">Rental payment</option>
                    <option value="refund">Refund</option>
                  </select>
                </label>
              )}
              <label>Amount (EUR)
                <input required type="number" min="0.01"
                max={displayedPaymentType === 'refund'
                    ? summary.amountPaidEur
                    : summary.outstandingEur}
                  step="0.01" value={amount} onChange={event => setAmount(event.target.value)} />
              </label>
              <label>Method
                <select value={method} onChange={event => setMethod(event.target.value)}>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="cash">Cash</option>
                  <option value="card">Externally verified card payment</option>
                </select>
              </label>
              <label>External reference
                <input required maxLength={100} value={reference} onChange={event => setReference(event.target.value)} />
              </label>
              <button disabled={busy}>{displayedPaymentType === 'refund' ? 'Record refund' : 'Record payment'}</button>
            </form>
          )}
          {canReceiveDeposit && (
            <form onSubmit={submitDeposit}>
              <h4>Record deposit receipt</h4>
              <label>Amount received (EUR)
                <input required type="number" min="0.01" max={summary.deposit.outstandingAmount} step="0.01" value={depositAmount} onChange={event => setDepositAmount(event.target.value)} />
              </label>
              <label>Method
                <select value={method} onChange={event => setMethod(event.target.value)}>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="cash">Cash</option>
                  <option value="card">Externally verified card payment</option>
                </select>
              </label>
              <label>External reference
                <input required maxLength={100} value={reference} onChange={event => setReference(event.target.value)} />
              </label>
              <button disabled={busy}>Record deposit</button>
            </form>
          )}
        </div>
      )}

      <div className={styles.history}>
        <h4>Transaction history</h4>
        {summary.payments.length === 0
          ? <p>No financial transactions recorded.</p>
          : summary.payments.map(payment => (
            <article key={payment.id}>
              <div>
                <strong>{payment.type.replaceAll('_', ' ')}</strong>
                <span>{new Date(payment.paidAt).toLocaleString('en-GB')} · {payment.method} · Ref. {payment.reference || '—'}</span>
              </div>
              <strong>{euro(payment.amount)}</strong>
              <a href={endpoint(`finance/payments/${payment.id}/receipt`)}>Receipt</a>
            </article>
          ))}
      </div>

      {(summary.invoices.length > 0 || summary.rental) && (
        <div className={styles.documents}>
          <h4>Documents</h4>
          {summary.rental && (
            <a href={endpoint(`finance/${summary.rental.id}/documents/contract`)}>Open rental contract</a>
          )}
          {summary.invoices.map(invoice => summary.rental && (
            <a key={invoice.id} href={endpoint(`finance/${summary.rental.id}/documents/invoice`)}>
              Invoice {invoice.invoiceNumber} · {euro(invoice.totalAmount)}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
