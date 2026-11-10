'use client';

import { useEffect, useCallback } from 'react';
import { X, Key, Clock, MapPin, CheckCircle } from 'lucide-react';
import styles from './check-in-code-modal.module.css';

interface CheckInCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  reservationNumber: string;
  vehicleName: string;
  code: string;
  expiresAt: string;
  agencyName: string;
}

export default function CheckInCodeModal({
  isOpen,
  onClose,
  reservationNumber,
  vehicleName,
  code,
  expiresAt,
  agencyName,
}: CheckInCodeModalProps) {
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

  if (!isOpen) return null;

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkin-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.badge}>
            <Key size={13} />
            Showroom Express Check-In
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          <h3 id="checkin-title" className={styles.title}>
            Vehicle Collection Pass
          </h3>
          <p className={styles.lead}>
            Present this VIP handover code to your concierge upon arrival at the showroom to collect your {vehicleName}.
          </p>

          <div className={styles.codeCard}>
            <span className={styles.codeLabel}>ONE-TIME HANDOVER PIN</span>
            <div className={styles.codeDigits}>
              {code.split('').map((char, i) => (
                <span key={i} className={styles.digitBox}>
                  {char}
                </span>
              ))}
            </div>
            <span className={styles.codeRef}>Booking Ref: {reservationNumber}</span>
          </div>

          <div className={styles.metaGrid}>
            <div className={styles.metaItem}>
              <MapPin size={14} className={styles.metaIcon} />
              <div>
                <span className={styles.metaLabel}>Showroom</span>
                <strong className={styles.metaValue}>{agencyName || 'Budapest Luxury Showroom'}</strong>
              </div>
            </div>

            <div className={styles.metaItem}>
              <Clock size={14} className={styles.metaIcon} />
              <div>
                <span className={styles.metaLabel}>Valid Until</span>
                <strong className={styles.metaValue}>
                  {expiresAt
                    ? new Date(expiresAt).toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                        day: '2-digit',
                        month: 'short',
                      })
                    : 'Collection window'}
                </strong>
              </div>
            </div>
          </div>

          <div className={styles.footerNote}>
            <CheckCircle size={14} style={{ color: '#22c55e', flexShrink: 0 }} />
            <span>
              Your security deposit hold and driving licence have been verified. An agent will conduct the departure inspection with you.
            </span>
          </div>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.doneBtn} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
