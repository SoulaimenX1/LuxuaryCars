'use client';

import type { BookingLocation, CalendarSlot } from '@/lib/booking';
import styles from './booking.module.css';

// ==========================================================
// SÉLECTION DES HEURES DE DÉBUT ET DE FIN DE LOCATION
// ==========================================================
//
// Les créneaux proposés sont ceux calculés par le serveur pour l'agence
// attribuée et le véhicule choisi. Aucune heure n'est inventée : si un
// créneau n'est pas renvoyé, il est réellement indisponible.

function formatDateLabel(date: string): string {
  if (!date) return '—';
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function DateTimeSelection({
  agency,
  pickupDate,
  returnDate,
  pickupSlots,
  returnSlots,
  pickupAt,
  returnAt,
  onPickupTime,
  onReturnTime,
  onReset,
}: {
  agency: BookingLocation | null;
  pickupDate: string;
  returnDate: string;
  pickupSlots: CalendarSlot[];
  returnSlots: CalendarSlot[];
  pickupAt: string;
  returnAt: string;
  onPickupTime: (at: string) => void;
  onReturnTime: (at: string) => void;
  onReset: () => void;
}) {
  return (
    <div>
      <div className={styles.twoCols}>
        <div>
          <p className={styles.slotTitle}>Rental start — {formatDateLabel(pickupDate)}</p>
          {pickupDate && pickupSlots.length ? (
            <div className={styles.slotGrid}>
              {pickupSlots.map((slot) => (
                <button
                  key={slot.at}
                  type="button"
                  className={`${styles.slot} ${pickupAt === slot.at ? styles.slotActive : ''}`}
                  aria-pressed={pickupAt === slot.at}
                  onClick={() => onPickupTime(slot.at)}
                >
                  {slot.time}
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.loading}>Select an available rental start date on the calendar.</p>
          )}
        </div>

        <div>
          <p className={styles.slotTitle}>Return — {formatDateLabel(returnDate)}</p>
          {returnDate && returnSlots.length ? (
            <div className={styles.slotGrid}>
              {returnSlots.map((slot) => (
                <button
                  key={slot.at}
                  type="button"
                  className={`${styles.slot} ${returnAt === slot.at ? styles.slotActive : ''}`}
                  aria-pressed={returnAt === slot.at}
                  onClick={() => onReturnTime(slot.at)}
                >
                  {slot.time}
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.slotTitle}>
              {pickupDate ? 'Choose a rental return date on the calendar.' : 'Choose the rental start date first.'}
            </p>
          )}
        </div>
      </div>

      {agency && (
        <div className={styles.summaryLine}>
          Collection and return: <strong>LUXUAR Agency — {agency.name}</strong>
          {agency.timezone ? ` (${agency.timezone})` : ''}
        </div>
      )}

      {(pickupDate || returnDate) && (
        <p style={{ marginTop: '.75rem' }}>
          <button type="button" className={styles.slot} onClick={onReset}>
            Reset selected dates and times
          </button>
        </p>
      )}
    </div>
  );
}
