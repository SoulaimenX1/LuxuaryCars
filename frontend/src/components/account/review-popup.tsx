'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/components/toast';
import styles from './review-popup.module.css';

// ==========================================================
// AVIS APRÈS LOCATION — complètement optionnel pour le client
// ----------------------------------------------------------
// Après une location terminée, le client peut donner son avis s'il le
// souhaite. La démarche est 100% facultative :
//   • Fermeture / Échap / « Maybe later » reporte l'affichage pour la session
//   • « Skip review » ignore définitivement la demande pour cette réservation
//   • Les champs titre et commentaire sont strictement optionnels
//   • La navigation et l'accès au compte ne sont jamais bloqués
// ==========================================================

interface Reviewable {
  reservationNumber: string;
  vehicleId: string;
  closedAt: string;
  vehicleLabel: string | null;
  hasServices: boolean;
  services: string[];
}

export default function ReviewPopup() {
  const toast = useToast();

  const [queue, setQueue] = useState<Reviewable[]>([]);
  const [open, setOpen] = useState(false);

  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [serviceRating, setServiceRating] = useState(5);
  const [serviceComment, setServiceComment] = useState('');

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const dialogRef = useRef<HTMLDivElement>(null);
  const current = queue[0] ?? null;
  const total = queue.length;

  // ----------------------------------------------------------
  // Chargement des réservations éligibles
  // Respecte le choix du client : si reporté dans la session
  // ou explicitement ignoré, la modale ne s'ouvre pas.
  // ----------------------------------------------------------
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        if (typeof window !== 'undefined' && sessionStorage.getItem('luxuar_review_postponed') === 'true') {
          return;
        }

        const response = await fetch('/api/premium/me/reviewable', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) return;
        const rows: Reviewable[] = await response.json();
        if (controller.signal.aborted) return;
        if (Array.isArray(rows) && rows.length > 0) {
          let skipped: string[] = [];
          try {
            skipped = JSON.parse(localStorage.getItem('luxuar_skipped_reviews') || '[]');
          } catch {
            skipped = [];
          }
          const unskipped = rows.filter((r) => !skipped.includes(r.reservationNumber));
          if (unskipped.length > 0) {
            setQueue(unskipped);
            setOpen(true);
          }
        }
      } catch {
        // Silencieux : une fenêtre d'avis ne doit jamais gêner la navigation.
      }
    }

    void load();
    return () => {};
  }, []);

  const resetForm = useCallback(() => {
    setRating(5);
    setTitle('');
    setComment('');
    setServiceRating(5);
    setServiceComment('');
    setProblem('');
  }, []);

  // Reporte la demande pour la session actuelle (fermeture non bloquante)
  const postponeReview = useCallback(() => {
    try {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('luxuar_review_postponed', 'true');
      }
    } catch {
      // ignore
    }
    setProblem('');
    setOpen(false);
  }, []);

  // Ignore définitivement cette réservation sans bloquer le client
  const skipReview = useCallback(() => {
    if (!current) return;
    try {
      if (typeof window !== 'undefined') {
        const skipped: string[] = JSON.parse(localStorage.getItem('luxuar_skipped_reviews') || '[]');
        if (!skipped.includes(current.reservationNumber)) {
          skipped.push(current.reservationNumber);
          localStorage.setItem('luxuar_skipped_reviews', JSON.stringify(skipped));
        }
      }
    } catch {
      // ignore
    }
    toast.info('Review skipped. Your feedback is always optional and can be submitted anytime from your account.', 'Feedback');
    const remaining = queue.slice(1);
    setQueue(remaining);
    resetForm();
    setOpen(false);
  }, [current, queue, resetForm, toast]);

  // ----------------------------------------------------------
  // Accessibilité : fermeture par Échap, focus, blocage du fond.
  // ----------------------------------------------------------
  useEffect(() => {
    if (!open) return;

    dialogRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        postponeReview();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, postponeReview]);

  const vehicleName = useMemo(
    () => current?.vehicleLabel ?? current?.vehicleId.slice(0, 8) ?? '',
    [current],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!current) return;

    setProblem('');
    setBusy(true);
    try {
      const finalTitle = title.trim() || `${rating} Star Experience`;
      const finalComment = comment.trim() || `Customer rated vehicle ${rating} out of 5 stars for ${vehicleName}.`;

      const payload: {
        reservationNumber: string;
        rating: number;
        title: string;
        comment: string;
        serviceRating?: number;
        serviceComment?: string;
      } = {
        reservationNumber: current.reservationNumber,
        rating,
        title: finalTitle,
        comment: finalComment,
      };

      if (current.hasServices && (serviceRating || serviceComment.trim())) {
        payload.serviceRating = serviceRating;
        payload.serviceComment = serviceComment.trim() || `Service rated ${serviceRating} out of 5 stars.`;
      }

      const response = await fetch('/api/premium/me/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ message: 'Unable to save review' }));
        setProblem(typeof data.message === 'string' ? data.message : 'Unable to save review');
        return;
      }

      try {
        if (typeof window !== 'undefined') {
          const skipped: string[] = JSON.parse(localStorage.getItem('luxuar_skipped_reviews') || '[]');
          if (!skipped.includes(current.reservationNumber)) {
            skipped.push(current.reservationNumber);
            localStorage.setItem('luxuar_skipped_reviews', JSON.stringify(skipped));
          }
        }
      } catch {
        // ignore
      }

      toast.success('Thank you. Your review has been published.', 'Review');

      const remaining = queue.slice(1);
      setQueue(remaining);
      resetForm();
      if (remaining.length === 0) setOpen(false);
    } catch {
      setProblem('Unable to save review');
    } finally {
      setBusy(false);
    }
  }

  if (!open || !current) return null;

  return (
    <div className={styles.overlay}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-popup-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className={styles.close}
          aria-label="Close review window"
          onClick={postponeReview}
        >
          {'\u00d7'}
        </button>

        <p className={styles.eyebrow}>YOUR OPINION MATTERS · OPTIONAL</p>
        <h2 id="review-popup-title" className={styles.heading}>
          How was your experience?
        </h2>
        <p className={styles.lead}>
          Your rental is complete — sharing your feedback is completely optional. Tell us about the vehicle or skip at any time.
        </p>

        <div className={styles.context}>
          <span className={styles.contextVehicle}>{vehicleName}</span>
          <span className={styles.contextMeta}>
            {current.reservationNumber}
            {total > 1 ? ` · ${total} rentals to review` : ''}
          </span>
        </div>

        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <fieldset className={styles.section}>
            <legend>About the vehicle</legend>

            <label className={styles.field}>
              <span>Rating</span>
              <select
                value={rating}
                onChange={(event) => setRating(Number(event.target.value))}
              >
                {[5, 4, 3, 2, 1].map((value) => (
                  <option key={value} value={value}>
                    {value} star{value > 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span>Title <span className={styles.optionalTag}>(optional)</span></span>
              <input
                maxLength={100}
                placeholder="A memorable drive (optional)"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span>Your experience <span className={styles.optionalTag}>(optional)</span></span>
              <textarea
                maxLength={1500}
                rows={4}
                placeholder="Share what stood out during your rental (optional)..."
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </label>
          </fieldset>

          {current.hasServices ? (
            <fieldset className={styles.section}>
              <legend>About the services (optional)</legend>

              {current.services.length > 0 ? (
                <ul className={styles.services}>
                  {current.services.map((service) => (
                    <li key={service} className={styles.service}>
                      {service}
                    </li>
                  ))}
                </ul>
              ) : null}

              <label className={styles.field}>
                <span>Service rating</span>
                <select
                  value={serviceRating}
                  onChange={(event) => setServiceRating(Number(event.target.value))}
                >
                  {[5, 4, 3, 2, 1].map((value) => (
                    <option key={value} value={value}>
                      {value} star{value > 1 ? 's' : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.field}>
                <span>Your opinion on the service <span className={styles.optionalTag}>(optional)</span></span>
                <textarea
                  maxLength={1500}
                  rows={3}
                  placeholder="How did our team and optional services do? (optional)..."
                  value={serviceComment}
                  onChange={(event) => setServiceComment(event.target.value)}
                />
              </label>
            </fieldset>
          ) : null}

          {problem ? (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          ) : null}

          <div className={styles.actions}>
            <button type="button" className={styles.skip} onClick={skipReview}>
              Skip review
            </button>
            <button type="button" className={styles.later} onClick={postponeReview}>
              Maybe later
            </button>
            <button type="submit" className={styles.submit} disabled={busy}>
              {busy ? 'Publishing…' : 'Publish review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
