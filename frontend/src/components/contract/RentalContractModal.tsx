'use client';

import { useEffect, useCallback } from 'react';
import {
  X,
  Download,
  Calendar,
  ShieldCheck,
  Car,
  Printer,
  FileText,
  CheckCircle,
} from 'lucide-react';
import styles from './contract-modal.module.css';
import { Price } from '@/components/currency-provider';

export interface RentalContractData {
  contractNumber: string;
  reservationNumber: string;
  rentalId?: string;
  vehicleName: string;
  brandName?: string;
  modelName?: string;
  licensePlate?: string;
  imageUrl?: string | null;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  pickupAt: string;
  returnAt: string;
  pickupLocation?: string | null;
  dropoffLocation?: string | null;
  rentalDays: number;
  dailyPrice: string;
  totalAmount: string;
  depositAmount: string;
  paymentStatus?: string;
  invoiceNumber?: string | null;
}

interface RentalContractModalProps {
  isOpen: boolean;
  onClose: () => void;
  contract: RentalContractData | null;
}

function formatDate(val: string | null | undefined): string {
  if (!val) return '—';
  const d = new Date(val);
  return Number.isNaN(d.getTime())
    ? val
    : d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
}

function formatDateTime(val: string | null | undefined): string {
  if (!val) return '—';
  const d = new Date(val);
  return Number.isNaN(d.getTime())
    ? val
    : d.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export default function RentalContractModal({
  isOpen,
  onClose,
  contract,
}: RentalContractModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen || !contract) return null;

  const pdfUrl = contract.rentalId
    ? `/api/finance/me/${encodeURIComponent(contract.rentalId)}/documents/contract`
    : null;

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="contract-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modalWindow}>
        {/* Navigation & Actions Bar */}
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <span className={styles.docBadge}>
              <FileText size={14} />
              Official Rental Contract
            </span>
          </div>

          <div className={styles.topBarActions}>
            <button
              type="button"
              className={styles.closeButton}
              title="Print Agreement"
              onClick={() => window.print()}
            >
              <Printer size={15} />
            </button>

            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.pdfDownloadBtn}
                title="Download Official A4 PDF Agreement"
              >
                <Download size={13} />
                Download PDF
              </a>
            )}

            <button
              type="button"
              className={styles.closeButton}
              title="Close contract dossier"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Paper Contract Layout */}
        <div className={styles.docBody}>
          {/* Header Band */}
          <div className={styles.docHeaderBand}>
            <div>
              <span className={styles.brandEyebrow}>
                LUXURYCARS · MAISON DE LOCATION HAUTE PERFORMANCE
              </span>
              <h2 id="contract-modal-title" className={styles.docTitle}>
                LUXURY VEHICLE HIRE AGREEMENT
              </h2>
              <p className={styles.docSubtitle}>
                Official Rental Dossier &amp; Terms Acknowledgement
              </p>
            </div>

            <div className={styles.headerRefBox}>
              <div className={styles.refRow}>
                <span className={styles.refLabel}>CONTRACT:</span>
                <span className={styles.refValue}>{contract.contractNumber}</span>
              </div>
              <div className={styles.refRow}>
                <span className={styles.refLabel}>RESERVATION:</span>
                <span className={styles.refValue}>{contract.reservationNumber}</span>
              </div>
            </div>
          </div>

          {/* Vehicle Showcase */}
          <div className={styles.vehicleShowcase}>
            <div className={styles.vehicleImageFrame}>
              {contract.imageUrl ? (
                <img
                  src={contract.imageUrl}
                  alt={contract.vehicleName}
                  className={styles.vehicleImage}
                />
              ) : (
                <Car size={54} style={{ color: 'var(--champagne)', opacity: 0.6 }} />
              )}
            </div>

            <div className={styles.vehicleMeta}>
              <p className={styles.vehicleBrand}>
                {contract.brandName || 'LUXURYCARS SELECTION'}
              </p>
              <h3 className={styles.vehicleName}>
                {contract.vehicleName || contract.modelName || 'High-Performance Supercar'}
              </h3>
              {contract.licensePlate && (
                <div className={styles.vehiclePlate}>
                  <span>Assigned Vehicle Plate:</span>
                  <span className={styles.platePill}>{contract.licensePlate}</span>
                </div>
              )}
            </div>
          </div>

          {/* Customer & Logistics + Financials Grid */}
          <div className={styles.dossierGrid}>
            {/* Box 1: Hirer & Handover Logistics */}
            <div className={styles.dossierBox}>
              <div className={styles.boxHeader}>
                <Calendar size={14} style={{ color: 'var(--champagne)' }} />
                <h4 className={styles.boxTitle}>Hirer &amp; Handover Schedule</h4>
              </div>

              <dl className={styles.dataList}>
                <dt className={styles.dataLabel}>Customer</dt>
                <dd className={styles.dataValue}>{contract.customerName || 'Valued Client'}</dd>

                {contract.customerEmail && (
                  <>
                    <dt className={styles.dataLabel}>Email</dt>
                    <dd className={styles.dataValue}>{contract.customerEmail}</dd>
                  </>
                )}

                <dt className={styles.dataLabel}>Collection</dt>
                <dd className={styles.dataValue}>
                  {formatDateTime(contract.pickupAt)}
                  <div style={{ fontSize: 11, color: 'var(--muted-text)', marginTop: 2 }}>
                    {contract.pickupLocation || 'Budapest Luxury Showroom'}
                  </div>
                </dd>

                <dt className={styles.dataLabel}>Return</dt>
                <dd className={styles.dataValue}>
                  {formatDateTime(contract.returnAt)}
                  <div style={{ fontSize: 11, color: 'var(--muted-text)', marginTop: 2 }}>
                    {contract.dropoffLocation || 'Budapest Luxury Showroom'}
                  </div>
                </dd>

                <dt className={styles.dataLabel}>Duration</dt>
                <dd className={styles.dataValue}>
                  {contract.rentalDays} {contract.rentalDays === 1 ? 'Day' : 'Days'} agreed hire
                </dd>
              </dl>
            </div>

            {/* Box 2: Financial Terms & Security Deposit */}
            <div className={styles.dossierBox}>
              <div className={styles.boxHeader}>
                <ShieldCheck size={14} style={{ color: 'var(--champagne)' }} />
                <h4 className={styles.boxTitle}>Settlement &amp; Guarantee</h4>
              </div>

              <dl className={styles.dataList}>
                <dt className={styles.dataLabel}>Daily Rate</dt>
                <dd className={styles.dataValue}>
                  <Price value={contract.dailyPrice} /> / day
                </dd>

                <dt className={styles.dataLabel}>Rental Total</dt>
                <dd className={`${styles.dataValue} ${styles.dataHighlight}`}>
                  <Price value={contract.totalAmount} />
                </dd>

                <dt className={styles.dataLabel}>Deposit Hold</dt>
                <dd className={styles.dataValue}>
                  <Price value={contract.depositAmount} />
                </dd>

                <dt className={styles.dataLabel}>Status</dt>
                <dd className={styles.dataValue}>
                  <span style={{ color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <CheckCircle size={12} />
                    {contract.paymentStatus || 'Verified & Pre-authorized'}
                  </span>
                </dd>

                {contract.invoiceNumber && (
                  <>
                    <dt className={styles.dataLabel}>Invoice Ref</dt>
                    <dd className={styles.dataValue}>{contract.invoiceNumber}</dd>
                  </>
                )}
              </dl>

              <p className={styles.depositNote}>
                * Security deposit is pre-authorized against the client’s verified card and fully reconciled following return inspection.
              </p>
            </div>
          </div>

          {/* Terms & Conditions */}
          <div className={styles.termsSection}>
            <h4 className={styles.termsTitle}>Summary Rental Conditions &amp; Policies</h4>
            <ol className={styles.termsList}>
              <li>
                <strong>VEHICLE CUSTODY &amp; HANDOVER:</strong> The vehicle is delivered in immaculate aesthetic and mechanical condition. A photographic digital inspection of mileage, fuel level and bodywork is recorded upon departure.
              </li>
              <li>
                <strong>FUEL &amp; REFUELING POLICY:</strong> The vehicle must be returned with the identical fuel level recorded at handover. Any fuel deficit is reconciled against the security deposit according to showroom fuel tariffs.
              </li>
              <li>
                <strong>SECURITY DEPOSIT PRE-AUTHORIZATION:</strong> The agreed security deposit remains held throughout the rental period. Upon formal return inspection, the deposit is released in full or adjusted for any non-preexisting damage.
              </li>
              <li>
                <strong>AUTHORIZED DRIVERS:</strong> Only drivers registered with valid driving licences covering the full hire duration may operate the vehicle. Track use, racing, and unauthorized third-party driving are strictly prohibited.
              </li>
              <li>
                <strong>FINES &amp; TRAFFIC INFRACTIONS:</strong> The registered hirer assumes sole legal responsibility for any fines, tolls, and speed infractions incurred during custody.
              </li>
            </ol>
          </div>

          {/* Signature Blocks */}
          <div className={styles.signatureSection}>
            <div className={styles.signatureBox}>
              <h5 className={styles.signTitle}>HIRER ACKNOWLEDGEMENT</h5>
              <p className={styles.signNotice}>
                I confirm having inspected the vehicle, agree to the rental terms and accept financial responsibility for custody.
              </p>
              <div className={styles.signLine}>
                <span>Client Signature: {contract.customerName}</span>
                <span>Date: {formatDate(contract.pickupAt)}</span>
              </div>
            </div>

            <div className={styles.signatureBox}>
              <h5 className={styles.signTitle}>CONCIERGE HANDOVER SIGN-OFF</h5>
              <p className={styles.signNotice}>
                Authorized LUXURYCARS concierge handover officer sign-off &amp; verified keys transmission.
              </p>
              <div className={styles.signLine}>
                <span>Showroom Agent: LUXURYCARS Desk</span>
                <span>Stamp: VERIFIED</span>
              </div>
            </div>
          </div>

          {/* Footer Note */}
          <div className={styles.docFooter}>
            LUXURYCARS · DEMONSTRATION DOCUMENT · OFFICIAL LUXURY RENTAL SYSTEM · BUDAPEST LUXURY SHOWROOM
          </div>
        </div>
      </div>
    </div>
  );
}
