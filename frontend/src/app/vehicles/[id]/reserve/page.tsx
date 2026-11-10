'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { VehicleItem } from '@/lib/catalog-types';
import {
  BookingApiError,
  checkInterval,
  createBookingQuote,
  createReservation,
  fetchAlternatives,
  fetchAvailabilityCalendar,
  fetchCustomerLicence,
  fetchOptions,
  fetchQuote,
  fetchVehicleAgency,
  monthKey,
  type AlternativesResponse,
  type AvailabilityCheckResult,
  type BookingLocation,
  type BookingQuote,
  type CalendarResponse,
  type CalendarSlot,
  type PremiumOption,
} from '@/lib/booking';

import VehicleBookingSummary from '@/components/booking/VehicleBookingSummary';
import AvailabilityCalendar from '@/components/booking/AvailabilityCalendar';
import DateTimeSelection from '@/components/booking/DateTimeSelection';
import DriverInformation from '@/components/booking/DriverInformation';
import BookingPriceSummary from '@/components/booking/BookingPriceSummary';
import BookingReview from '@/components/booking/BookingReview';
import UnavailableAlternatives from '@/components/booking/UnavailableAlternatives';

import styles from './reserve.module.css';
import bookingStyles from '@/components/booking/booking.module.css';
import { useToast } from '@/components/toast';

// ==========================================================
// PARCOURS DE RÉSERVATION
// véhicule → dates/heures → agence attribuée →
// heures → options → conducteur → devis autoritaire →
// confirmation en base.
// ==========================================================
//
// Un seul et même workflow pour tous les points d'entrée. Le
// véhicule provient de l'URL et n'est jamais remplacé par une
// voiture « équivalente ». Toute la disponibilité et tous les
// montants proviennent de NestJS/PostgreSQL.
//
interface BookingDraft {
  month: string;
  pickupDate: string;
  pickupTime: string;
  pickupAt: string;
  returnDate: string;
  returnTime: string;
  returnAt: string;
  extraIds: string[];
}

function messageOf(error: unknown): string {
  if (error instanceof BookingApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function formatDate(date: string): string {
  if (!date) return '—';
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function ReservePage() {
  const params = useParams<{ id: string }>();
  const vehicleId = params.id;
  const router = useRouter();

  const toast = useToast();

  const draftKey = `booking-draft:${vehicleId}`;
  const pendingRestore = useRef<BookingDraft | null>(null);
  const previousLocation = useRef('');
  const initialPickup = useRef('');
  const initialReturn = useRef('');
  const prefillApplied = useRef(false);

  const [vehicle, setVehicle] = useState<VehicleItem | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');

  const [agency, setAgency] = useState<BookingLocation | null>(null);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [locationsError, setLocationsError] = useState('');
  void locationsError;
  const locationId = agency?.id ?? '';

  const [month, setMonth] = useState<string>(() => monthKey());
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState('');

  const [pickupDate, setPickupDate] = useState('');
  const [pickupTime, setPickupTime] = useState('');
  const [pickupAt, setPickupAt] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [returnTime, setReturnTime] = useState('');
  const [returnAt, setReturnAt] = useState('');
  const [pickupSlots, setPickupSlots] = useState<CalendarSlot[]>([]);
  const [returnSlots, setReturnSlots] = useState<CalendarSlot[]>([]);

  const [options, setOptions] = useState<PremiumOption[]>([]);
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [promotionCode, setPromotionCode] = useState('');

  const [licence, setLicence] = useState<Record<string, unknown> | null>(null);
  const [licenceMissing, setLicenceMissing] = useState(false);
  const [licenceLoading, setLicenceLoading] = useState(true);
  const [licenceError, setLicenceError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);

  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [availability, setAvailability] = useState<AvailabilityCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const [alternatives, setAlternatives] = useState<AlternativesResponse | null>(null);
  const [alternativesLoading, setAlternativesLoading] = useState(false);
  const [alternativesError, setAlternativesError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Fenêtre modale : permis de conduire obligatoire avant confirmation.
  const [showLicenceModal, setShowLicenceModal] = useState(false);

  // Email verification mandatory modal
  const [showEmailVerificationModal, setShowEmailVerificationModal] = useState(false);
  const [resendingEmail, setResendingEmail] = useState(false);
  const [resendEmailSuccess, setResendEmailSuccess] = useState(false);
  const [resendEmailError, setResendEmailError] = useState('');
  const [verificationEmail, setVerificationEmail] = useState('');

  const extraIdsKey = extraIds.join(',');
  const minMonth = useMemo(() => monthKey(), []);
  const timezone = calendar?.timezone ?? '';
  const selectedLocation = agency;
  const findDay = (date: string) => calendar?.days.find((item) => item.date === date);

  // ----------------------------------------------------------
  // Brouillon : survit à un rafraîchissement (scénario H).
  // ----------------------------------------------------------
  /* eslint-disable react-hooks/set-state-in-effect --
     synchronisation volontaire avec sessionStorage et les API
     serveur (chargement, calendrier, permis, devis). */
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(draftKey);
    } catch {
      raw = null;
    }

    if (raw) {
      try {
        const draft = JSON.parse(raw) as Partial<BookingDraft>;
        const restored: BookingDraft = {
          month: typeof draft.month === 'string' ? draft.month : monthKey(),
          pickupDate: typeof draft.pickupDate === 'string' ? draft.pickupDate : '',
          pickupTime: typeof draft.pickupTime === 'string' ? draft.pickupTime : '',
          pickupAt: typeof draft.pickupAt === 'string' ? draft.pickupAt : '',
          returnDate: typeof draft.returnDate === 'string' ? draft.returnDate : '',
          returnTime: typeof draft.returnTime === 'string' ? draft.returnTime : '',
          returnAt: typeof draft.returnAt === 'string' ? draft.returnAt : '',
          extraIds: Array.isArray(draft.extraIds)
            ? draft.extraIds.filter((value) => typeof value === 'string')
            : [],
        };
        // Tant que ces valeurs ne sont pas appliquées à l'état, la
        // sauvegarde ci-dessous ne doit pas écraser le brouillon stocké.
        pendingRestore.current = restored;
        setMonth(restored.month);
        setPickupDate(restored.pickupDate);
        setPickupTime(restored.pickupTime);
        setPickupAt(restored.pickupAt);
        setReturnDate(restored.returnDate);
        setReturnTime(restored.returnTime);
        setReturnAt(restored.returnAt);
        setExtraIds(restored.extraIds);
      } catch {
        // Un brouillon illisible est simplement ignoré.
      }
    } else if (typeof window !== 'undefined') {
      // Aucun brouillon : reprendre les dates recherchées dans la
      // page de disponibilité (le véhicule, lui, vient de l'URL).
      const search = new URLSearchParams(window.location.search);
      const pickup = search.get('pickupDate');
      const back = search.get('returnDate');
      if (pickup && /^\d{4}-\d{2}-\d{2}$/.test(pickup)) {
        initialPickup.current = pickup;
        setMonth(pickup.slice(0, 7));
      }
      if (back && /^\d{4}-\d{2}-\d{2}$/.test(back)) {
        initialReturn.current = back;
      }
    }
  }, [draftKey]);

  useEffect(() => {
    const pending = pendingRestore.current;
    if (pending) {
      const settled =
        pending.pickupDate === pickupDate &&
        pending.pickupAt === pickupAt &&
        pending.returnDate === returnDate &&
        pending.returnAt === returnAt;
      // Tant que l'état restauré n'est pas appliqué, l'écriture
      // écraserait le brouillon stocké par l'état initial (vide) du
      // même rendu. On attend la fin du chargement des lieux pour ne
      // jamais rester bloqué sur un lieu devenu invalide.
      if (!settled && locationsLoading) return;
      pendingRestore.current = null;
    }
    // Aucune écriture avant la fin du chargement des lieux : pendant
    // cette phase, l'état initial (vide) écraserait un brouillon
    // existant ou le pré-remplissage par paramètres d'URL.
    if (locationsLoading) return;
    const draft: BookingDraft = {
      month,
      pickupDate,
      pickupTime,
      pickupAt,
      returnDate,
      returnTime,
      returnAt,
      extraIds,
    };
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // Le stockage peut être indisponible : la réservation reste possible.
    }
  }, [
    draftKey,
    locationId,
    month,
    pickupDate,
    pickupTime,
    pickupAt,
    returnDate,
    returnTime,
    returnAt,
    extraIds,
    locationsLoading,
  ]);

  // ----------------------------------------------------------
  // Véhicule : toujours celui de l'URL, jamais un équivalent.
  // ----------------------------------------------------------
  useEffect(() => {
    let active = true;
    setCatalogLoading(true);
    setCatalogError('');
    fetch('/api/vehicles/catalog', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: unknown) => {
        if (!active) return;
        const list = Array.isArray(data) ? (data as VehicleItem[]) : [];
        const found = list.find((item) => item.id === vehicleId) ?? null;
        setVehicle(found);
        if (!found) setCatalogError('This vehicle is not available in the collection.');
      })
      .catch(() => {
        if (active) setCatalogError('Unable to load the vehicle details.');
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [vehicleId]);

  // ----------------------------------------------------------
  // Agence attribuée au véhicule (sans sélection client).
  // ----------------------------------------------------------
  useEffect(() => {
    let active = true;
    setLocationsLoading(true);
    setLocationsError('');
    setAgency(null);
    fetchVehicleAgency(vehicleId)
      .then((data) => { if (active) setAgency(data); })
      .catch((error: unknown) => {
        if (!active || isAbort(error)) return;
        setLocationsError(messageOf(error));
      })
      .finally(() => {
        if (active) setLocationsLoading(false);
      });
    return () => { active = false; };
  }, [vehicleId]);

  // Changer de lieu réinitialise les dates (la disponibilité change).
  useEffect(() => {
    if (previousLocation.current && previousLocation.current !== locationId) {
      setPickupDate('');
      setPickupTime('');
      setPickupAt('');
      setReturnDate('');
      setReturnTime('');
      setReturnAt('');
      setPickupSlots([]);
      setReturnSlots([]);
    }
    previousLocation.current = locationId;
  }, [locationId]);

  // ----------------------------------------------------------
  // Calendrier du mois affiché, calculé pour l'agence attribuée.
  // ----------------------------------------------------------
  useEffect(() => {
    if (!locationId) {
      setCalendar(null);
      return;
    }
    let active = true;
    setCalendarLoading(true);
    setCalendarError('');
    fetchAvailabilityCalendar(vehicleId, month)
      .then((data) => { if (active) setCalendar(data); })
      .catch((error: unknown) => {
        if (!active || isAbort(error)) return;
        setCalendar(null);
        setCalendarError(messageOf(error));
      })
      .finally(() => {
        if (active) setCalendarLoading(false);
      });
    return () => { active = false; };
  }, [vehicleId, locationId, month]);

  // Recaler les créneaux des dates choisies et appliquer, une seule
  // fois, les dates recherchées pré-remplies.
  useEffect(() => {
    if (!calendar) return;

    if (!prefillApplied.current && initialPickup.current) {
      const pickupDay = calendar.days.find((day) => day.date === initialPickup.current);
      if (pickupDay && pickupDay.slots.length) {
        prefillApplied.current = true;
        selectPickup(pickupDay.date);
        const back = initialReturn.current;
        const returnDay = back ? calendar.days.find((day) => day.date === back) : undefined;
        if (back && returnDay && back > pickupDay.date && returnDay.returnSlots.length) {
          selectReturn(back);
        }
        return;
      }
    }

    const pickupDay = calendar.days.find((day) => day.date === pickupDate);
    if (pickupDay) setPickupSlots(pickupDay.slots);
    const returnDay = calendar.days.find((day) => day.date === returnDate);
    if (returnDay) setReturnSlots(returnDay.returnSlots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendar, pickupDate, returnDate]);

  // Options premium (affichage uniquement ; le prix reste serveur).
  useEffect(() => {
    let active = true;
    fetchOptions()
      .then((data) => {
        if (!active) return;
        setOptions(data);
        const validIds = new Set(data.map((o) => o.id));
        setExtraIds((prev) => prev.filter((id) => validIds.has(id)));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  // Permis du client connecté (le serveur revalide à la confirmation).
  useEffect(() => {
    let active = true;
    setLicenceLoading(true);
    setLicenceError('');
    fetchCustomerLicence()
      .then(({ profile, missing }) => {
        if (!active) return;
        setLicence(profile);
        setLicenceMissing(missing);
      })
      .catch((error: unknown) => {
        if (!active || isAbort(error)) return;
        if (error instanceof BookingApiError && error.status === 401) {
          setAuthRequired(true);
          return;
        }
        setLicenceError(messageOf(error));
      })
      .finally(() => {
        if (active) setLicenceLoading(false);
      });
    return () => { active = false; };
  }, []);

  // Fermeture de la fenêtre « permis requis » avec la touche Échap.
  useEffect(() => {
    if (!showLicenceModal) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowLicenceModal(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showLicenceModal]);

  // ----------------------------------------------------------
  // Devis autoritaire + revalidation de l'intervalle complet.
  // ----------------------------------------------------------
  useEffect(() => {
    const startMs = pickupAt ? new Date(pickupAt).getTime() : NaN;
    const endMs = returnAt ? new Date(returnAt).getTime() : NaN;
    if (
      !locationId ||
      !pickupAt ||
      !returnAt ||
      Number.isNaN(startMs) ||
      Number.isNaN(endMs) ||
      endMs <= startMs
    ) {
      setQuote(null);
      setQuoteError('');
      setAvailability(null);
      setChecking(false);
      setQuoteLoading(false);
      return;
    }
    let active = true;
    setQuoteLoading(true);
    setChecking(true);
    setQuoteError('');

    const validExtras = options.length
      ? extraIds.filter((id) => options.some((o) => o.id === id))
      : extraIds;
    const cleanPromo = promotionCode.trim().toUpperCase();

    const quotePayload: Record<string, unknown> = {
      vehicleId,
      pickupAt,
      returnAt,
    };
    if (validExtras.length) quotePayload.extraIds = validExtras;
    if (/^[A-Z0-9_-]{3,30}$/.test(cleanPromo)) quotePayload.promotionCode = cleanPromo;

    void Promise.allSettled([
      fetchQuote(quotePayload)
        .then((q) => { if (active) setQuote(q); })
        .catch((error: unknown) => {
          if (!active || isAbort(error)) return;
          setQuote(null);
          setQuoteError(messageOf(error));
        }),
      checkInterval(
        {
          vehicleId,
          pickupAt,
          returnAt,
        }
      )
        .then((a) => { if (active) setAvailability(a); })
        .catch((error: unknown) => {
          if (!active || isAbort(error)) return;
          setAvailability({
            available: false,
            reason: 'error',
            message: messageOf(error),
            details: null,
          });
        }),
    ]).finally(() => {
      if (active) {
        setQuoteLoading(false);
        setChecking(false);
      }
    });

    return () => { active = false; };
  }, [vehicleId, locationId, pickupAt, returnAt, extraIdsKey, promotionCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----------------------------------------------------------
  // Alternatives : uniquement lorsque le véhicule choisi est
  // indisponible. Le serveur calcule la prochaine période libre
  // et des véhicules réellement disponibles sur l'intervalle.
  // ----------------------------------------------------------
  useEffect(() => {
    if (
      !locationId ||
      !pickupAt ||
      !returnAt ||
      !availability ||
      availability.available
    ) {
      setAlternatives(null);
      setAlternativesError('');
      setAlternativesLoading(false);
      return;
    }
    let active = true;
    setAlternativesLoading(true);
    setAlternativesError('');
    fetchAlternatives(
      {
        vehicleId,
        pickupAt,
        returnAt,
      }
    )
      .then((data) => { if (active) setAlternatives(data); })
      .catch((error: unknown) => {
        if (!active || isAbort(error)) return;
        setAlternatives(null);
        setAlternativesError(messageOf(error));
      })
      .finally(() => {
        if (active) setAlternativesLoading(false);
      });
    return () => { active = false; };
  }, [vehicleId, locationId, pickupAt, returnAt, availability]);

  /* eslint-enable react-hooks/set-state-in-effect */

  // ----------------------------------------------------------
  // Sélection des dates et des heures.
  // ----------------------------------------------------------
  function clearDates() {
    setPickupDate('');
    setPickupTime('');
    setPickupAt('');
    setReturnDate('');
    setReturnTime('');
    setReturnAt('');
    setPickupSlots([]);
    setReturnSlots([]);
  }

  function selectPickup(date: string) {
    if (!date) {
      clearDates();
      return;
    }
    const slots = findDay(date)?.slots ?? [];
    setPickupDate(date);
    setPickupSlots(slots);
    setPickupTime(slots[0]?.time ?? '');
    setPickupAt(slots[0]?.at ?? '');
    if (returnDate && returnDate <= date) {
      setReturnDate('');
      setReturnTime('');
      setReturnAt('');
      setReturnSlots([]);
    }
  }

  function selectReturn(date: string) {
    const slots = findDay(date)?.returnSlots ?? [];
    setReturnDate(date);
    setReturnSlots(slots);
    setReturnTime(slots[0]?.time ?? '');
    setReturnAt(slots[0]?.at ?? '');
  }

  function selectPickupTime(at: string) {
    const slot = pickupSlots.find((item) => item.at === at);
    setPickupAt(at);
    setPickupTime(slot?.time ?? '');
    if (returnAt && at >= returnAt) {
      setReturnAt('');
      setReturnTime('');
    }
  }

  function selectReturnTime(at: string) {
    const slot = returnSlots.find((item) => item.at === at);
    setReturnAt(at);
    setReturnTime(slot?.time ?? '');
  }

  // Applique une période réellement disponible calculée par le
  // serveur (prochaine fenêtre libre du même véhicule). Les dates
  // et heures sont dérivées dans le fuseau du point de service :
  // la valeur autoritaire reste l'instant ISO fourni par l'API.
  function applyInterval(nextPickupAt: string, nextReturnAt: string) {
    const zone = calendar?.timezone || timezone || undefined;
    const dateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const timeFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const pickupValue = new Date(nextPickupAt);
    const returnValue = new Date(nextReturnAt);
    if (Number.isNaN(pickupValue.getTime()) || Number.isNaN(returnValue.getTime())) return;

    const nextPickupDate = dateFmt.format(pickupValue);
    const nextReturnDate = dateFmt.format(returnValue);

    setPickupDate(nextPickupDate);
    setPickupTime(timeFmt.format(pickupValue));
    setPickupAt(nextPickupAt);
    setReturnDate(nextReturnDate);
    setReturnTime(timeFmt.format(returnValue));
    setReturnAt(nextReturnAt);

    // Réaligner les créneaux affichés si le mois courant contient
    // ces journées, sinon basculer sur le mois de la prise en charge.
    const pickupDay = findDay(nextPickupDate);
    setPickupSlots(pickupDay?.slots ?? []);
    const returnDay = findDay(nextReturnDate);
    setReturnSlots(returnDay?.returnSlots ?? []);
    const targetMonth = nextPickupDate.slice(0, 7);
    if (targetMonth !== month) setMonth(targetMonth);
  }

  async function confirm() {
    if (authRequired) {
      router.push(`/auth/login?returnUrl=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    // Sans permis enregistré, la confirmation ouvre une fenêtre
    // explicative au lieu d'appeler l'API.
    if (licenceMissing || !licence || !licence.licenseNumber) {
      setSubmitError('');
      setShowLicenceModal(true);
      return;
    }
    const expiresOn = typeof licence.licenseExpiresOn === 'string'
      ? licence.licenseExpiresOn.slice(0, 10)
      : '';
    if (returnDate && expiresOn && expiresOn < returnDate) {
      setSubmitError('Your driving licence expires before the selected return date.');
      setShowLicenceModal(true);
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      // Étape 1 : devis persisté côté serveur (prix entièrement
      // autoritaire, réutilisable quelques minutes). Aucun montant
      // n'est accepté du navigateur.
      const persistedQuote = await createBookingQuote({
        vehicleId,
        pickupAt,
        returnAt,
        ...(extraIds.length ? { extraIds } : {}),
        ...(promotionCode.trim() ? { promotionCode: promotionCode.trim() } : {}),
      });
      // Étape 2 : réservation refermant le devis accepté — le
      // serveur revalide propriété, validité, empreinte et total
      // recalculé avant toute écriture.
      const result = await createReservation({
        vehicleId,
        pickupAt,
        returnAt,
        quoteId: persistedQuote.id,
        ...(extraIds.length ? { extraIds } : {}),
        ...(promotionCode.trim() ? { promotionCode: promotionCode.trim() } : {}),
      });
      const number =
        typeof result.reservationNumber === 'string' ? result.reservationNumber.trim() : '';
      if (!number) {
        throw new Error('The reservation was created without a reference number.');
      }
      try {
        sessionStorage.removeItem(draftKey);
      } catch {
        // Ignorer un stockage indisponible.
      }
      toast.success(`Reservation ${number} received. We will confirm it shortly.`, 'Booking');
      router.push(`/reservations/${encodeURIComponent(number)}/confirmation`);
    } catch (error) {
      const text = messageOf(error);
      // Le serveur revalide le permis : une absence détectée côté
      // API ouvre la même fenêtre, plutôt qu'un message en ligne.
      if (/customer profile|driving licen[cs]e/i.test(text)) {
        setShowLicenceModal(true);
        return;
      }
      if (
        (error instanceof BookingApiError &&
          error.status === 403 &&
          error.code === 'EMAIL_VERIFICATION_REQUIRED') ||
        /email verification|verify your email/i.test(text)
      ) {
        if (error instanceof BookingApiError && error.email) setVerificationEmail(error.email);
        setShowEmailVerificationModal(true);
        setSubmitError(text);
        toast.error('Email verification is required before reserving.', 'Verification Required');
        return;
      }
      setSubmitError(text);
      toast.error(text, 'Booking');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendVerification() {
    setResendingEmail(true);
    setResendEmailError('');
    setResendEmailSuccess(false);
    try {
      let email = verificationEmail;
      if (!email) {
        const meRes = await fetch('/api/auth/me');
        if (meRes.ok) {
          const meData = await meRes.json();
          email = meData?.email || '';
        }
      }
      if (!email) {
        throw new Error('Unable to resolve your email address. Please sign in again.');
      }
      const response = await fetch('/api/auth/verify-email/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message || 'Failed to resend verification email.');
      }
      setResendEmailSuccess(true);
      toast.success('Verification email sent! Please check your inbox.', 'Email Sent');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error resending verification email';
      setResendEmailError(msg);
      toast.error(msg, 'Verification');
    } finally {
      setResendingEmail(false);
    }
  }

  // ----------------------------------------------------------
  // Rendu
  // ----------------------------------------------------------
  if (catalogLoading) {
    return (
      <main className={styles.page}>
        <p className={bookingStyles.loading}>Loading the vehicle…</p>
      </main>
    );
  }

  if (!vehicle) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Vehicle unavailable</h1>
        <p className={bookingStyles.error} role="alert">
          {catalogError || 'This vehicle is not available in the collection.'}
        </p>
        <p>
          <Link href="/vehicles" className={bookingStyles.inlineLink}>
            ← Back to the collection
          </Link>
        </p>
      </main>
    );
  }

  const vehicleLabel = `${vehicle.brandName} ${vehicle.modelName}`;
  const agencyLabel = selectedLocation
    ? `LUXUAR Agency — ${selectedLocation.name}`
    : 'Agency not confirmed';
  const pickupLabel = pickupDate
    ? `${formatDate(pickupDate)} · ${pickupTime}${timezone ? ` (${timezone})` : ''}`
    : 'Not selected';
  const returnLabel = returnDate
    ? `${formatDate(returnDate)} · ${returnTime}${timezone ? ` (${timezone})` : ''}`
    : 'Not selected';
  const isClientLicenceVerified = Boolean(
    !authRequired &&
    !licenceLoading &&
    !licenceMissing &&
    licence &&
    typeof licence.licenseNumber === 'string' &&
    licence.licenseNumber.trim().length > 0 &&
    (!returnDate ||
      typeof licence.licenseExpiresOn !== 'string' ||
      licence.licenseExpiresOn.slice(0, 10) >= returnDate),
  );

  const canConfirm = Boolean(
    isClientLicenceVerified &&
    agency &&
    !locationsLoading &&
    availability?.available &&
    quote &&
    !quoteLoading &&
    !checking &&
    pickupAt &&
    returnAt &&
    new Date(returnAt).getTime() > new Date(pickupAt).getTime() &&
    !submitting,
  );

  return (
    <main className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/vehicles">Collection</Link>
        <span>/</span>
        <Link href={`/vehicles/${vehicleId}`}>{vehicleLabel}</Link>
        <span>/</span>
        <span>Reserve</span>
      </nav>

      <h1 className={styles.title}>Reserve this vehicle</h1>
      <p className={styles.subtitle}>
        You are reserving the exact vehicle shown below. Availability, prices and the security deposit
        are calculated by our system from live data.
      </p>

      {authRequired && (
        <div className={bookingStyles.noticeBox} role="alert">
          Please{' '}
          <Link
            href="/login"
            className={bookingStyles.inlineLink}
            title="Sign in to confirm your reservation"
          >
            sign in
          </Link>{' '}
          to complete and confirm your reservation.
        </div>
      )}

      {!authRequired && !licenceLoading && !isClientLicenceVerified && (
        <div className={bookingStyles.noticeBox} role="alert">
          <strong>Client verification required:</strong> Non-verified clients cannot create
          reservations. Please{' '}
          <Link
            href="/account/profile"
            className={bookingStyles.inlineLink}
            title="Verify your driving licence profile"
          >
            complete and verify your driving licence profile
          </Link>{' '}
          before booking.
        </div>
      )}

      <div className={styles.layout}>
        <div>
          <section className={bookingStyles.step}>
            <header className={bookingStyles.stepHeader}>
              <span className={bookingStyles.stepNumber}>1</span>
              <h2 className={bookingStyles.stepTitle}>Your vehicle</h2>
            </header>
            <VehicleBookingSummary vehicle={vehicle} />
          </section>

          {locationId && (
            <>
            <section className={bookingStyles.step}>
              <header className={bookingStyles.stepHeader}>
                <span className={bookingStyles.stepNumber}>2</span>
                <h2 className={bookingStyles.stepTitle}>Choose your dates</h2>
              </header>
              <AvailabilityCalendar
                month={month}
                calendar={calendar}
                loading={calendarLoading}
                error={calendarError}
                pickupDate={pickupDate}
                returnDate={returnDate}
                minMonth={minMonth}
                onMonthChange={setMonth}
                onPickup={selectPickup}
                onReturn={selectReturn}
              />
              {pickupAt && returnAt && availability && !availability.available && (
                <UnavailableAlternatives
                  data={alternatives}
                  loading={alternativesLoading}
                  error={alternativesError}
                  timezone={timezone}
                  onUseInterval={applyInterval}
                />
              )}
            </section>

          <section className={bookingStyles.step}>
            <header className={bookingStyles.stepHeader}>
              <span className={bookingStyles.stepNumber}>3</span>
              <h2 className={bookingStyles.stepTitle}>Rental start &amp; end times</h2>
            </header>
            <DateTimeSelection
              agency={agency}
              pickupDate={pickupDate}
              returnDate={returnDate}
              pickupSlots={pickupSlots}
              returnSlots={returnSlots}
              pickupAt={pickupAt}
              returnAt={returnAt}
              onPickupTime={selectPickupTime}
              onReturnTime={selectReturnTime}
              onReset={clearDates}
            />
          </section>

          <section className={bookingStyles.step}>
            <header className={bookingStyles.stepHeader}>
              <span className={bookingStyles.stepNumber}>4</span>
              <h2 className={bookingStyles.stepTitle}>Optional services</h2>
            </header>
            {options.length === 0 ? (
              <p className={bookingStyles.loading}>No optional service is currently offered.</p>
            ) : (
              <>
              <div className={bookingStyles.optionList}>
                {options.map((option) => {
                  const active = extraIds.includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className={`${bookingStyles.option} ${active ? bookingStyles.optionActive : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() =>
                          setExtraIds((current) =>
                            current.includes(option.id)
                              ? current.filter((id) => id !== option.id)
                              : [...current, option.id],
                          )
                        }
                      />
                      <span className={bookingStyles.optionBody}>
                        <span className={bookingStyles.optionName}>{option.name}</span>
                        {option.description && (
                          <span className={bookingStyles.optionMeta}>{option.description}</span>
                        )}
                        <span className={bookingStyles.optionMeta}>
                          {option.amount} EUR
                          {option.pricing === 'daily' ? ' / day' : ' once'}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className={bookingStyles.optionList} style={{ marginTop: '1rem' }}>
                <label className={bookingStyles.option} style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                  <span className={bookingStyles.optionName}>Promotion code (optional)</span>
                  <input
                    type="text"
                    value={promotionCode}
                    onChange={(e) => setPromotionCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30))}
                    placeholder="e.g. VIP10"
                    style={{ marginTop: '0.5rem', padding: '0.5rem', width: '100%', maxWidth: '280px' }}
                  />
                </label>
              </div>
              </>
            )}
          </section>

          <section className={bookingStyles.step}>
            <header className={bookingStyles.stepHeader}>
              <span className={bookingStyles.stepNumber}>6</span>
              <h2 className={bookingStyles.stepTitle}>Driver information</h2>
            </header>
            <DriverInformation
              profile={licence}
              missing={licenceMissing}
              loading={licenceLoading}
              error={licenceError}
              returnDate={returnDate}
            />
          </section>
            </>
          )}
        </div>

        {locationId && <aside className={styles.aside}>
          <section className={bookingStyles.step}>
            <header className={bookingStyles.stepHeader}>
              <span className={bookingStyles.stepNumber}>7</span>
              <h2 className={bookingStyles.stepTitle}>Your price</h2>
            </header>
            <BookingPriceSummary quote={quote} loading={quoteLoading} error={quoteError} />
          </section>

          <section className={bookingStyles.step}>
            <header className={bookingStyles.stepHeader}>
              <span className={bookingStyles.stepNumber}>8</span>
              <h2 className={bookingStyles.stepTitle}>Review &amp; confirm</h2>
            </header>
            <BookingReview
              vehicleLabel={vehicleLabel}
              agencyLabel={agencyLabel}
              pickupLabel={pickupLabel}
              returnLabel={returnLabel}
              quote={quote}
              availability={availability}
              checking={checking}
              submitting={submitting}
              error={submitError}
              disabled={!canConfirm}
              onConfirm={confirm}
            />
            {!availability && !checking && (
              <p className={bookingStyles.loading} style={{ marginTop: '.75rem' }}>
                Choose rental dates and times to enable confirmation.
              </p>
            )}
          </section>
        </aside>}
      </div>

      {showLicenceModal && (
        <div
          className={bookingStyles.modalOverlay}
          role="presentation"
          onClick={() => setShowLicenceModal(false)}
        >
          <div
            className={bookingStyles.modalCard}
            role="dialog"
            aria-modal="true"
            aria-labelledby="licence-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <span className={bookingStyles.modalEyebrow}>Driving licence required</span>

            <h2 id="licence-modal-title" className={bookingStyles.modalTitle}>
              You must register your driving licence
            </h2>

            <p className={bookingStyles.modalMessage}>
              You need to add your driving licence details to your profile before
              confirming.
            </p>

            <div className={bookingStyles.modalActions}>
              <Link href="/account/profile" className={bookingStyles.modalPrimary} autoFocus>
                Add my licence
              </Link>

              <button
                type="button"
                className={bookingStyles.modalSecondary}
                onClick={() => setShowLicenceModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showEmailVerificationModal && (
        <div
          className={bookingStyles.modalOverlay}
          role="presentation"
          onClick={() => setShowEmailVerificationModal(false)}
        >
          <div
            className={bookingStyles.modalCard}
            role="dialog"
            aria-modal="true"
            aria-labelledby="email-verify-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <span className={bookingStyles.modalEyebrow}>Verification Required</span>

            <h2 id="email-verify-modal-title" className={bookingStyles.modalTitle}>
              Email Verification Mandatory
            </h2>

            <p className={bookingStyles.modalMessage}>
              For the security of every LUXUAR rental, your email address must be verified before a
              reservation can be requested. Please open the verification link we sent you, or request a
              new one below. Your selected dates are kept.
            </p>

            {resendEmailSuccess && (
              <p style={{ color: 'var(--success)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                ✓ A new verification link has been sent to your email address. Please check your inbox.
              </p>
            )}

            {resendEmailError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                {resendEmailError}
              </p>
            )}

            <div className={bookingStyles.modalActions}>
              <button
                type="button"
                className={bookingStyles.modalPrimary}
                disabled={resendingEmail}
                onClick={() => void handleResendVerification()}
              >
                {resendingEmail ? 'Sending...' : 'Resend verification email'}
              </button>

              <Link href="/verify-email" className={bookingStyles.modalSecondary}>
                Go to email verification
              </Link>

              <button
                type="button"
                className={bookingStyles.modalSecondary}
                onClick={() => setShowEmailVerificationModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
