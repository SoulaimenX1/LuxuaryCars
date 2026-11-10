'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import styles from './reservations.module.css';
import { formatAmount } from '@/lib/format';
import { useConfirm } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';
import { ReservationFinancePanel } from './ReservationFinancePanel';

interface Reservation {
  id: string;
  reservationNumber: string;
  vehicleId: string;
  customerId: string;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  dailyPrice: string;
  depositAmount: string;
  totalAmount: string;
  status: string;
  createdAt: string;
  customerNotes: string | null;
  decisionReason: string | null;
  noShowAt?: string | null;
  noShowReason?: string | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  pickupLocation?: string | null;
  dropoffLocation?: string | null;
  paymentDeadlineAt?: string | null;
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
}

interface Vehicle {
  id: string;
  brandName: string;
  modelName: string;
  imageUrl?: string | null;
}

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface EditForm {
  vehicleId: string;
  pickupAt: string;
  returnAt: string;
}

interface EditPreview {
  available: boolean;
  message: string | null;
  currentTotal: string;
  newTotal: string;
  priceDifference: string;
  rentalDays: number;
  pickupLocationName: string | null;
  dropoffLocationName: string | null;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ApiError {
  message?: string | string[];
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const data: ApiError = await response.json();
    return Array.isArray(data.message) ? data.message.join(', ') : data.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export interface StatusMeta {
  label: string;
  badgeClass: string;
  description: string;
}

export const RESERVATION_STATUS_META: Record<string, StatusMeta> = {
  pending: {
    label: 'Pending Approval',
    badgeClass: 'badgePending',
    description: 'Submitted by customer; awaiting administrator review.',
  },
  awaiting_payment: {
    label: 'Awaiting Payment',
    badgeClass: 'badgeAwaiting',
    description: 'Approved by concierge; awaiting customer payment and deposit guarantee within the 24-hour window.',
  },
  confirmed: {
    label: 'Confirmed',
    badgeClass: 'badgeConfirmed',
    description: 'Payment guaranteed and vehicle secured for the scheduled journey dates.',
  },
  active_rental: {
    label: 'Active Rental',
    badgeClass: 'badgeActive',
    description: 'Vehicle keys dispatched and currently in customer custody.',
  },
  converted: {
    label: 'Converted to Rental',
    badgeClass: 'badgeConverted',
    description: 'Reservation dispatched and converted to an active rental agreement in fleet operations.',
  },
  completed: {
    label: 'Completed',
    badgeClass: 'badgeCompleted',
    description: 'Rental lifecycle completed, vehicle inspected, and deposit settled.',
  },
  rejected: {
    label: 'Rejected',
    badgeClass: 'badgeRejected',
    description: 'Reservation declined by an authorized administrator.',
  },
  cancelled: {
    label: 'Cancelled',
    badgeClass: 'badgeCancelled',
    description: 'Reservation voluntarily cancelled prior to trip commencement.',
  },
  cancelled_unpaid: {
    label: 'Cancelled — Unpaid',
    badgeClass: 'badgeCancelledUnpaid',
    description: 'Payment was not completed within the mandatory guarantee window.',
  },
  expired: {
    label: 'Expired',
    badgeClass: 'badgeExpired',
    description: 'Booking reservation or authorization expired according to business rules.',
  },
};

export default function AdminReservationsPage() {
  const confirm = useConfirm();
  const toast = useToast();

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState<string>('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Filtering states
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [vehicleFilter, setVehicleFilter] = useState('all');
  const [customerFilter, setCustomerFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');

  // Direct entry view

  // Inspection Drawer & Selection
  const [inspectingReservation, setInspectingReservation] = useState<Reservation | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Rejection Dialog State
  const [rejectModalReservation, setRejectModalReservation] = useState<Reservation | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Edit Modal State
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ vehicleId: '', pickupAt: '', returnAt: '' });
  const [editPreview, setEditPreview] = useState<EditPreview | null>(null);
  const [editMessage, setEditMessage] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editValidated, setEditValidated] = useState<string | null>(null);
  const editRequestSeq = useRef(0);

  const [processing, setProcessing] = useState<string | null>(null);

  // Current time state
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setCurrentTime(Date.now());
    const start = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 60000);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(timer);
    };
  }, []);

  // Sync / Refresh
  async function refresh(silent = false) {
    if (!silent) setIsRefreshing(true);
    try {
      const response = await fetch('/api/admin/reservations', { cache: 'no-store' });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result: unknown = await response.json();
      if (!Array.isArray(result)) throw new Error('Invalid reservations response.');
      setReservations(result as Reservation[]);
      setLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      // If a reservation is being inspected, update its state
      setInspectingReservation((prev) => {
        if (!prev) return null;
        return (result as Reservation[]).find((r) => r.id === prev.id) || prev;
      });
    } catch (caught) {
      if (!silent) {
        const msg = caught instanceof Error ? caught.message : 'Failed to refresh data.';
        setError(msg);
      }
    } finally {
      if (!silent) setIsRefreshing(false);
    }
  }

  // Initial Load
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [r, v, c] = await Promise.all([
          fetch('/api/admin/reservations', { cache: 'no-store' }),
          fetch('/api/vehicles/catalog', { cache: 'no-store' }),
          fetch('/api/admin/customers', { cache: 'no-store' }),
        ]);
        if (!r.ok) throw new Error(await errorMessage(r));
        const resList: unknown = await r.json();
        if (!Array.isArray(resList)) throw new Error('Invalid reservation list.');
        if (!active) return;
        setReservations(resList as Reservation[]);
        setLastSync(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        if (v.ok) {
          const data: unknown = await v.json();
          if (Array.isArray(data)) setVehicles(data as Vehicle[]);
        }
        if (c.ok) {
          const data: unknown = await c.json();
          if (Array.isArray(data)) setCustomers(data as Customer[]);
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Unable to load reservations.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  // Helper mappings
  const customerMap = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const vehicleMap = useMemo(() => new Map(vehicles.map((v) => [v.id, v])), [vehicles]);

  const customerName = (id: string) => {
    const customer = customerMap.get(id);
    return customer ? `${customer.firstName} ${customer.lastName}` : id.slice(0, 8);
  };

  const customerEmail = (id: string) => customerMap.get(id)?.email || '';

  const vehicleName = (id: string) => {
    const vehicle = vehicleMap.get(id);
    return vehicle ? `${vehicle.brandName} ${vehicle.modelName}` : id.slice(0, 8);
  };

  const vehicleImage = (id: string) => vehicleMap.get(id)?.imageUrl || null;

  // KPIs
  const archivedCount = useMemo(() => reservations.filter((r) => r.archivedAt).length, [reservations]);
  const pendingCount = useMemo(() => reservations.filter((r) => r.status === 'pending' && !r.archivedAt).length, [reservations]);
  const awaitingPaymentCount = useMemo(() => reservations.filter((r) => r.status === 'awaiting_payment' && !r.archivedAt).length, [reservations]);
  const confirmedCount = useMemo(() => reservations.filter((r) => r.status === 'confirmed' && !r.archivedAt).length, [reservations]);
  const activeRentalCount = useMemo(() => reservations.filter((r) => r.status === 'active_rental' && !r.archivedAt).length, [reservations]);
  const completedCount = useMemo(() => reservations.filter((r) => r.status === 'completed' && !r.archivedAt).length, [reservations]);

  // Operational window for confirmed rentals

  // Archive permission
  const canArchive = (r: Reservation): boolean => {
    if (r.archivedAt) return true;
    if (['rejected', 'cancelled', 'cancelled_unpaid', 'completed', 'expired'].includes(r.status)) {
      return true;
    }
    if (r.status !== 'confirmed') return false;
    return currentTime !== null && new Date(r.returnAt).getTime() <= currentTime;
  };

  // Edit permission
  const canEdit = (r: Reservation) =>
    currentTime !== null &&
    (r.status === 'pending' || r.status === 'confirmed') &&
    new Date(r.pickupAt).getTime() > currentTime;

  // Filtered reservations
  const visible = useMemo(() => {
    return reservations.filter((r) => {
      if (r.status === 'no_show') return false;
      const cName = customerName(r.customerId);
      const cEmail = customerEmail(r.customerId);
      const vName = vehicleName(r.vehicleId);
      const searchTarget = `${r.reservationNumber} ${cName} ${cEmail} ${vName}`.toLowerCase();
      const query = search.toLowerCase().trim();

      return (
        searchTarget.includes(query) &&
        (status === 'all' || r.status === status) &&
        (vehicleFilter === 'all' || r.vehicleId === vehicleFilter) &&
        (customerFilter === 'all' || r.customerId === customerFilter) &&
        (archiveFilter === 'all' || (archiveFilter === 'archived') === Boolean(r.archivedAt)) &&
        (!fromDate || r.returnAt.slice(0, 10) >= fromDate) &&
        (!toDate || r.pickupAt.slice(0, 10) <= toDate)
      );
    });
  }, [reservations, search, status, vehicleFilter, customerFilter, archiveFilter, fromDate, toDate, customerMap, vehicleMap]);


  const hasActiveFilters =
    search !== '' ||
    status !== 'all' ||
    vehicleFilter !== 'all' ||
    customerFilter !== 'all' ||
    fromDate !== '' ||
    toDate !== '' ||
    archiveFilter !== 'active';

  function resetAllFilters() {
    setSearch('');
    setStatus('all');
    setVehicleFilter('all');
    setCustomerFilter('all');
    setFromDate('');
    setToDate('');
    setArchiveFilter('active');
  }

  // Direct status filter from URL (?status=pending, etc.)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncStatusFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const urlStatus = params.get('status');
      const validStatuses = [
        'all',
        'pending',
        'awaiting_payment',
        'confirmed',
        'active_rental',
        'converted',
        'completed',
        'cancelled_unpaid',
        'cancelled',
        'rejected',
        'expired',
      ];
      if (urlStatus && validStatuses.includes(urlStatus) && !params.get('focus')) {
        setStatus(urlStatus);
      }
    };

    syncStatusFromUrl();
    window.addEventListener('popstate', syncStatusFromUrl);
    return () => window.removeEventListener('popstate', syncStatusFromUrl);
  }, []);

  // Direct focus from URL (?focus=RES-...)
  const lastFocusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const focus = new URLSearchParams(window.location.search).get('focus');
    if (!focus || lastFocusedRef.current === focus.toUpperCase()) return;
    const target = reservations.find((r) => r.reservationNumber.toUpperCase() === focus.toUpperCase());
    if (!target) return;
    lastFocusedRef.current = focus.toUpperCase();
    const apply = window.setTimeout(() => {
      setStatus('all');
      setVehicleFilter('all');
      setCustomerFilter('all');
      setArchiveFilter('all');
      setSearch('');
      setFocusedId(target.id);
      setInspectingReservation(target);
    }, 0);
    const scroll = window.setTimeout(() => {
      document.getElementById(`reservation-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }, 150);
    const clear = window.setTimeout(() => setFocusedId(null), 5000);
    return () => {
      window.clearTimeout(apply);
      window.clearTimeout(scroll);
      window.clearTimeout(clear);
    };
  }, [loading, reservations]);

  // Copy reservation number
  async function copyResNumber(num: string) {
    try {
      await navigator.clipboard.writeText(num);
      toast.success(`Copied ${num} to clipboard`, 'Copied');
    } catch {
      toast.info(num, 'Reservation Number');
    }
  }

  // Operations
  async function approveReservation(reservation: Reservation) {
    if (processing) return;
    const approved = await confirm({
      title: 'Approve reservation',
      message: `Reservation ${reservation.reservationNumber} will be approved. The customer will receive an official email invitation to pay via Stripe Checkout with a 24-hour guarantee window.`,
      confirmLabel: 'Approve & Request Payment',
      cancelLabel: 'Cancel',
      tone: 'success',
    });
    if (!approved) return;

    setProcessing(reservation.reservationNumber);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/admin/reservations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationNumber: reservation.reservationNumber,
          action: 'approve',
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      await refresh(true);
      const outcome = `Reservation ${reservation.reservationNumber} has been approved. Stripe payment window generated.`;
      setSuccess(outcome);
      toast.success(outcome, 'Reservation approved');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Action failed.';
      setError(message);
      toast.error(message, 'Approval failed');
    } finally {
      setProcessing(null);
    }
  }

  function openRejectModal(reservation: Reservation) {
    setRejectModalReservation(reservation);
    setRejectReason('');
  }

  async function submitRejection() {
    if (!rejectModalReservation || processing) return;
    const reason = rejectReason.trim();
    if (reason.length < 5 || reason.length > 500) {
      toast.error('Rejection reason must be between 5 and 500 characters.', 'Validation');
      return;
    }

    setProcessing(rejectModalReservation.reservationNumber);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/admin/reservations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationNumber: rejectModalReservation.reservationNumber,
          action: 'reject',
          reason,
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      await refresh(true);
      const outcome = `Reservation ${rejectModalReservation.reservationNumber} has been rejected.`;
      setSuccess(outcome);
      toast.success(outcome, 'Reservation rejected');
      setRejectModalReservation(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Rejection failed.';
      setError(message);
      toast.error(message, 'Rejection failed');
    } finally {
      setProcessing(null);
    }
  }

  async function cancelUnpaid(reservation: Reservation) {
    if (processing) return;
    const approved = await confirm({
      title: 'Cancel unpaid booking',
      message: `Reservation ${reservation.reservationNumber} will be marked as CANCELLED_UNPAID and its vehicle released back to the fleet.`,
      confirmLabel: 'Cancel unpaid booking',
      cancelLabel: 'Keep booking',
      tone: 'danger',
    });
    if (!approved) return;

    setProcessing(reservation.reservationNumber);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/admin/reservations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationNumber: reservation.reservationNumber,
          action: 'cancel_unpaid',
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      await refresh(true);
      const msg = `Reservation ${reservation.reservationNumber} cancelled due to expired payment window.`;
      setSuccess(msg);
      toast.success(msg, 'Reservation cancelled');
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : 'Action failed';
      setError(msg);
      toast.error(msg, 'Cancellation');
    } finally {
      setProcessing(null);
    }
  }

  async function setArchive(reservation: Reservation, archive: boolean) {
    if (processing) return;
    const approved = await confirm({
      title: archive ? 'Archive reservation' : 'Restore reservation',
      message: archive
        ? `Reservation ${reservation.reservationNumber} will be archived and hidden from active operations.`
        : `Reservation ${reservation.reservationNumber} will be restored to active operations.`,
      confirmLabel: archive ? 'Archive reservation' : 'Restore reservation',
      cancelLabel: 'Cancel',
    });
    if (!approved) return;

    setProcessing(reservation.reservationNumber);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/admin/reservations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationNumber: reservation.reservationNumber,
          action: archive ? 'archive' : 'restore',
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      await refresh(true);
      const outcome = `Reservation ${reservation.reservationNumber} has been ${archive ? 'archived' : 'restored'}.`;
      setSuccess(outcome);
      toast.success(outcome, 'Reservation updated');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Action failed.';
      setError(message);
      toast.error(message, 'Reservation update failed');
    } finally {
      setProcessing(null);
    }
  }

  async function removeReservation(reservation: Reservation) {
    if (processing) return;
    const approved = await confirm({
      title: 'Delete reservation',
      message: `Reservation ${reservation.reservationNumber} will be permanently deleted from the database. This action cannot be undone.`,
      confirmLabel: 'Delete reservation',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
    if (!approved) return;

    setProcessing(reservation.reservationNumber);
    setError('');
    setSuccess('');
    try {
      const response = await fetch(`/api/admin/reservations?reservationNumber=${encodeURIComponent(reservation.reservationNumber)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      await refresh(true);
      if (inspectingReservation?.id === reservation.id) {
        setInspectingReservation(null);
      }
      const outcome = `Reservation ${reservation.reservationNumber} has been permanently deleted.`;
      setSuccess(outcome);
      toast.success(outcome, 'Reservation deleted');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Action failed.';
      setError(message);
      toast.error(message, 'Deletion failed');
    } finally {
      setProcessing(null);
    }
  }

  // Edit logic
  function openEdit(r: Reservation) {
    setEditing(r);
    editRequestSeq.current += 1;
    setEditPreview(null);
    setEditValidated(null);
    setEditMessage('');
    setEditForm({
      vehicleId: r.vehicleId,
      pickupAt: toLocalInput(r.pickupAt),
      returnAt: toLocalInput(r.returnAt),
    });
  }

  function updateEditForm(patch: Partial<EditForm>) {
    setEditForm((form) => ({ ...form, ...patch }));
    editRequestSeq.current += 1;
    setEditPreview(null);
    setEditValidated(null);
    setEditMessage('');
  }

  function closeEdit() {
    editRequestSeq.current += 1;
    setEditing(null);
    setEditPreview(null);
    setEditValidated(null);
    setEditMessage('');
  }

  function buildEditPayload(): Record<string, string> {
    if (!editing) return {};
    const payload: Record<string, string> = {};
    if (editForm.vehicleId && editForm.vehicleId !== editing.vehicleId) payload.vehicleId = editForm.vehicleId;
    if (editForm.pickupAt && editForm.pickupAt !== toLocalInput(editing.pickupAt)) {
      payload.pickupAt = new Date(editForm.pickupAt).toISOString();
    }
    if (editForm.returnAt && editForm.returnAt !== toLocalInput(editing.returnAt)) {
      payload.returnAt = new Date(editForm.returnAt).toISOString();
    }
    return payload;
  }

  function validateEditForm(): string | null {
    if (!editing) return null;
    const pickupIso = editForm.pickupAt ? new Date(editForm.pickupAt).toISOString() : new Date(editing.pickupAt).toISOString();
    const returnIso = editForm.returnAt ? new Date(editForm.returnAt).toISOString() : new Date(editing.returnAt).toISOString();
    if (new Date(returnIso).getTime() <= new Date(pickupIso).getTime()) {
      return 'The rental end date must be after the rental start date.';
    }
    return null;
  }

  async function previewEdit() {
    if (!editing || editBusy) return;
    const payload = buildEditPayload();
    if (Object.keys(payload).length === 0) {
      setEditPreview(null);
      setEditValidated(null);
      setEditMessage('Change at least one value to preview the impact.');
      return;
    }
    const invalid = validateEditForm();
    if (invalid) {
      setEditPreview(null);
      setEditValidated(null);
      setEditMessage(invalid);
      return;
    }
    const signature = JSON.stringify(payload);
    const seq = ++editRequestSeq.current;
    setEditBusy(true);
    setEditMessage('');
    setEditPreview(null);
    setEditValidated(null);
    try {
      const response = await fetch(`/api/admin/reservations/${encodeURIComponent(editing.reservationNumber)}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const data: EditPreview = await response.json();
      if (seq !== editRequestSeq.current) return;
      setEditPreview(data);
      if (data.available) {
        setEditValidated(signature);
        setEditMessage('');
      } else {
        setEditValidated(null);
        setEditMessage(data.message ?? 'The new period is unavailable.');
      }
    } catch (caught) {
      if (seq !== editRequestSeq.current) return;
      setEditValidated(null);
      setEditMessage(caught instanceof Error ? caught.message : 'Preview failed.');
    } finally {
      setEditBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing || editBusy) return;
    const payload = buildEditPayload();
    if (Object.keys(payload).length === 0) {
      setEditMessage('No modification to save.');
      return;
    }
    if (editValidated !== JSON.stringify(payload)) {
      setEditMessage('Check availability & price for the current values before saving.');
      return;
    }
    setEditBusy(true);
    try {
      const approved = await confirm({
        title: 'Update reservation',
        message: `Reservation ${editing.reservationNumber} will be updated. Availability is rechecked and prices recalculated by the server.`,
        confirmLabel: 'Save changes',
        cancelLabel: 'Cancel',
      });
      if (!approved) return;
      setEditMessage('');
      const response = await fetch(`/api/admin/reservations/${encodeURIComponent(editing.reservationNumber)}/edit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result = (await response.json()) as { priceDifference?: string };
      const number = editing.reservationNumber;
      await refresh(true);
      setEditing(null);
      setEditPreview(null);
      setEditValidated(null);
      const diff = result?.priceDifference ? ` Price change: ${formatAmount(result.priceDifference)} EUR.` : '';
      const outcome = `Reservation ${number} has been updated.${diff}`;
      setSuccess(outcome);
      toast.success(outcome, 'Reservation updated');
    } catch (caught) {
      setEditValidated(null);
      const message = caught instanceof Error ? caught.message : 'Update failed.';
      setEditMessage(message);
      toast.error(message, 'Reservation update error');
    } finally {
      setEditBusy(false);
    }
  }

  // Format Status Badge
  function renderStatusBadge(statusStr: string) {
    const meta = RESERVATION_STATUS_META[statusStr] || {
      label: statusStr.replace(/_/g, ' '),
      badgeClass: 'badgePending',
      description: 'Reservation status recorded in system.',
    };

    const badgeClass = styles[meta.badgeClass as keyof typeof styles] || styles.badgePending;

    return (
      <span className={`${styles.statusBadge} ${badgeClass}`} title={meta.description}>
        <span className={styles.statusDot} />
        {meta.label}
      </span>
    );
  }

  // Handle escape to close drawer
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (rejectModalReservation) setRejectModalReservation(null);
        else if (editing) closeEdit();
        else if (inspectingReservation) setInspectingReservation(null);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [inspectingReservation, editing, rejectModalReservation]);

  return (
    <main className={styles.page}>
      <section className={styles.container}>
        {/* Navigation & Controls */}
        <div className={styles.navBar}>
          <div className={styles.breadcrumb}>
            <Link href="/admin" className={styles.backLink}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              Dashboard
            </Link>
            <span>/</span>
            <span className={styles.breadcrumbCurrent}>Reservations</span>
          </div>

          <div className={styles.lastSync}>
            {lastSync && <span>Last synced: {lastSync}</span>}
            <button
              type="button"
              className={styles.refreshButton}
              onClick={() => void refresh()}
              disabled={isRefreshing}
              title="Refresh reservations"
              aria-label="Refresh reservations"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={isRefreshing ? styles.spin : ''}
              >
                <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
              Refresh
            </button>
          </div>
        </div>

        {/* Premium Header */}
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>Reservations</h1>
          </div>
        </header>

        {/* Feedback Alerts */}
        {error && (
          <div role="alert" className={`${styles.feedbackAlert} ${styles.alertError}`}>
            <span>{error}</span>
            <button type="button" className={styles.alertDismiss} onClick={() => setError('')} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {success && (
          <div role="status" className={`${styles.feedbackAlert} ${styles.alertSuccess}`}>
            <span>{success}</span>
            <button type="button" className={styles.alertDismiss} onClick={() => setSuccess('')} aria-label="Dismiss message">
              ×
            </button>
          </div>
        )}

        {/* Interactive KPI Quick-Filter Cards */}
        <div className={styles.kpiGrid} role="region" aria-label="Quick status filters">
          <button
            type="button"
            className={`${styles.kpiCard} ${styles.kpiTotal} ${status === 'all' && archiveFilter === 'active' ? styles.kpiCardActive : ''}`}
            onClick={() => {
              setStatus('all');
              setArchiveFilter('active');
            }}
          >
            <span className={styles.kpiLabel}>Total Active</span>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{reservations.length - archivedCount}</span>
              <span className={styles.kpiIndicator} />
            </div>
          </button>

          <button
            type="button"
            className={`${styles.kpiCard} ${styles.kpiPending} ${status === 'pending' && archiveFilter === 'active' ? styles.kpiCardActive : ''}`}
            onClick={() => {
              setStatus('pending');
              setArchiveFilter('active');
            }}
          >
            <span className={styles.kpiLabel}>Pending</span>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{pendingCount}</span>
              <span className={styles.kpiIndicator} />
            </div>
          </button>

          <button
            type="button"
            className={`${styles.kpiCard} ${styles.kpiAwaiting} ${status === 'awaiting_payment' && archiveFilter === 'active' ? styles.kpiCardActive : ''}`}
            onClick={() => {
              setStatus('awaiting_payment');
              setArchiveFilter('active');
            }}
          >
            <span className={styles.kpiLabel}>Awaiting Pay</span>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{awaitingPaymentCount}</span>
              <span className={styles.kpiIndicator} />
            </div>
          </button>

          <button
            type="button"
            className={`${styles.kpiCard} ${styles.kpiConfirmed} ${status === 'confirmed' && archiveFilter === 'active' ? styles.kpiCardActive : ''}`}
            onClick={() => {
              setStatus('confirmed');
              setArchiveFilter('active');
            }}
          >
            <span className={styles.kpiLabel}>Confirmed</span>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{confirmedCount}</span>
              <span className={styles.kpiIndicator} />
            </div>
          </button>

          <button
            type="button"
            className={`${styles.kpiCard} ${styles.kpiActive} ${status === 'active_rental' && archiveFilter === 'active' ? styles.kpiCardActive : ''}`}
            onClick={() => {
              setStatus('active_rental');
              setArchiveFilter('active');
            }}
          >
            <span className={styles.kpiLabel}>Active Rentals</span>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{activeRentalCount}</span>
              <span className={styles.kpiIndicator} />
            </div>
          </button>

          <button
            type="button"
            className={`${styles.kpiCard} ${styles.kpiCompleted} ${status === 'completed' && archiveFilter === 'active' ? styles.kpiCardActive : ''}`}
            onClick={() => {
              setStatus('completed');
              setArchiveFilter('active');
            }}
          >
            <span className={styles.kpiLabel}>Completed</span>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{completedCount}</span>
              <span className={styles.kpiIndicator} />
            </div>
          </button>

          <button
            type="button"
            className={`${styles.kpiCard} ${styles.kpiArchived} ${archiveFilter === 'archived' ? styles.kpiCardActive : ''}`}
            onClick={() => {
              setStatus('all');
              setArchiveFilter('archived');
            }}
          >
            <span className={styles.kpiLabel}>Archived</span>
            <div className={styles.kpiValueRow}>
              <span className={styles.kpiValue}>{archivedCount}</span>
              <span className={styles.kpiIndicator} />
            </div>
          </button>
        </div>

        {/* Filters & Search Toolbar */}
        <div className={styles.toolbar} role="search" aria-label="Reservation search and filters">
          <div className={styles.searchRow}>
            <div className={styles.searchBox}>
              <span className={styles.searchIcon}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                type="text"
                className={styles.searchInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by reservation #, customer, email, or vehicle..."
                aria-label="Search reservations"
              />
              {search && (
                <button
                  type="button"
                  className={styles.searchClear}
                  onClick={() => setSearch('')}
                  aria-label="Clear search query"
                >
                  ✕
                </button>
              )}
            </div>

            <div className={styles.segmentedArchive} role="group" aria-label="Filter by archive state">
              <button
                type="button"
                className={`${styles.segmentButton} ${archiveFilter === 'active' ? styles.segmentButtonActive : ''}`}
                onClick={() => setArchiveFilter('active')}
              >
                Current (Not Archived)
              </button>
              <button
                type="button"
                className={`${styles.segmentButton} ${archiveFilter === 'archived' ? styles.segmentButtonActive : ''}`}
                onClick={() => setArchiveFilter('archived')}
              >
                Archived ({archivedCount})
              </button>
              <button
                type="button"
                className={`${styles.segmentButton} ${archiveFilter === 'all' ? styles.segmentButtonActive : ''}`}
                onClick={() => setArchiveFilter('all')}
              >
                All Records
              </button>
            </div>
          </div>

          <div className={styles.filterGrid}>
            <div className={styles.filterSelectGroup}>
              <select
                className={styles.filterSelect}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label="Filter by reservation status"
              >
                <option value="all">All statuses</option>
                <option value="pending">Pending Approval</option>
                <option value="awaiting_payment">Awaiting Payment</option>
                <option value="confirmed">Confirmed</option>
                <option value="active_rental">Active Rental</option>
                <option value="converted">Converted to Rental</option>
                <option value="completed">Completed</option>
                <option value="cancelled_unpaid">Cancelled — Unpaid</option>
                <option value="cancelled">Cancelled</option>
                <option value="rejected">Rejected</option>
                <option value="expired">Expired</option>
              </select>
            </div>

            <div className={styles.filterSelectGroup}>
              <select
                className={styles.filterSelect}
                value={vehicleFilter}
                onChange={(e) => setVehicleFilter(e.target.value)}
                aria-label="Filter by vehicle"
              >
                <option value="all">All vehicles</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.brandName} {v.modelName}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.filterSelectGroup}>
              <select
                className={styles.filterSelect}
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                aria-label="Filter by customer"
              >
                <option value="all">All customers</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.firstName} {c.lastName}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.dateRangeGroup}>
              <input
                type="date"
                className={styles.dateInput}
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                title="From pickup date"
                aria-label="Filter from pickup date"
              />
              <span className={styles.dateSeparator}>→</span>
              <input
                type="date"
                className={styles.dateInput}
                min={fromDate || undefined}
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                title="Until return date"
                aria-label="Filter until return date"
              />
            </div>

            {hasActiveFilters && (
              <button type="button" className={styles.resetFiltersBtn} onClick={resetAllFilters}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Reset filters
              </button>
            )}
          </div>
        </div>

        {!loading && (
          <div className={styles.resultsCountBar}>
            <span className={styles.resultsCount}>
              Showing <strong>{visible.length}</strong> {visible.length === 1 ? 'reservation' : 'reservations'}
            </span>
          </div>
        )}

        {/* Loading Spinner */}
        {loading && (
          <div className={styles.loadingContainer}>
            <div className={styles.loadingSpinner} />
            <p>Loading reservations and fleet dossiers...</p>
          </div>
        )}

        {!loading && (
          <>
            {visible.length === 0 ? (
              <div className={styles.emptyState}>
                <svg className={styles.emptyStateIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                  <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                </svg>
                <h3 className={styles.emptyStateTitle}>No reservations found</h3>
                <p className={styles.emptyStateDesc}>
                  No bookings match the active criteria. Try adjusting your search query, status, or date range.
                </p>
                {hasActiveFilters && (
                  <button type="button" className={styles.btnSecondary} onClick={resetAllFilters}>
                    Reset all filters
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* Desktop Luxury Table */}
                <div className={styles.tableContainer}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Vehicle &amp; Booking</th>
                        <th>Customer</th>
                        <th>Rental Period</th>
                        <th>Financials</th>
                        <th>Status</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => {
                        const img = vehicleImage(r.vehicleId);
                        const isFocused = focusedId === r.id;
                        return (
                          <tr
                            key={r.id}
                            id={`reservation-${r.id}`}
                            className={`${styles.tableRow} ${isFocused ? styles.tableRowFocused : ''}`}
                            onClick={() => setInspectingReservation(r)}
                          >
                            {/* Vehicle & Booking */}
                            <td>
                              <div className={styles.vehicleCell}>
                                {img ? (
                                  <img src={img} alt={vehicleName(r.vehicleId)} className={styles.vehicleThumb} />
                                ) : (
                                  <div className={styles.vehicleThumbFallback}>LUX</div>
                                )}
                                <div className={styles.vehicleInfo}>
                                  <span className={styles.vehicleName}>{vehicleName(r.vehicleId)}</span>
                                  <div className={styles.resNumberPill}>
                                    <span>{r.reservationNumber}</span>
                                  </div>
                                </div>
                              </div>
                            </td>

                            {/* Customer */}
                            <td>
                              <div className={styles.customerCell}>
                                <div className={styles.customerAvatar}>
                                  {customerName(r.customerId).slice(0, 2).toUpperCase()}
                                </div>
                                <div className={styles.customerInfo}>
                                  <span className={styles.customerName}>{customerName(r.customerId)}</span>
                                  <span className={styles.customerEmail} title={customerEmail(r.customerId)}>{customerEmail(r.customerId)}</span>
                                </div>
                              </div>
                            </td>

                            {/* Period */}
                            <td>
                              <div className={styles.scheduleCell}>
                                <div className={styles.scheduleDates}>
                                  <span>{r.pickupAt.slice(0, 10)}</span>
                                  <span className={styles.scheduleArrow}>→</span>
                                  <span>{r.returnAt.slice(0, 10)}</span>
                                </div>
                                <span className={styles.scheduleDuration}>
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                  </svg>
                                  {r.rentalDays} day{r.rentalDays > 1 ? 's' : ''}
                                </span>
                              </div>
                            </td>

                            {/* Financials */}
                            <td>
                              <div className={styles.financeCell}>
                                <span className={styles.totalAmount}>€{formatAmount(r.totalAmount)}</span>
                                <span className={styles.depositAmount}>€{formatAmount(r.depositAmount)} dep.</span>
                              </div>
                            </td>

                            {/* Status */}
                            <td>
                              <div className={styles.statusCell}>
                                {renderStatusBadge(r.status)}
                                {r.archivedAt && <span className={styles.archivedPill}>Archived</span>}
                              </div>
                            </td>

                            {/* Actions — Primary View Details + Clear Archive / Restore */}
                            <td className={styles.actionsCell} onClick={(e) => e.stopPropagation()}>
                              <div className={styles.reservationActions}>
                                <button
                                  type="button"
                                  className={styles.viewDetailsButton}
                                  onClick={() => setInspectingReservation(r)}
                                  title={`Inspect dossier & actions for ${r.reservationNumber}`}
                                  aria-label={`View details for reservation ${r.reservationNumber}`}
                                >
                                  View Details →
                                </button>

                                {!r.archivedAt && canArchive(r) && (
                                  <button
                                    type="button"
                                    className={styles.archiveActionButton}
                                    disabled={Boolean(processing)}
                                    onClick={() => void setArchive(r, true)}
                                    title={`Archive reservation ${r.reservationNumber}`}
                                    aria-label={`Archive reservation ${r.reservationNumber}`}
                                  >
                                    <span>📦</span>
                                    <span>Archive</span>
                                  </button>
                                )}

                                {r.archivedAt && (
                                  <button
                                    type="button"
                                    className={styles.restoreActionButton}
                                    disabled={Boolean(processing)}
                                    onClick={() => void setArchive(r, false)}
                                    title={`Restore reservation ${r.reservationNumber}`}
                                    aria-label={`Restore reservation ${r.reservationNumber}`}
                                  >
                                    <span>↺</span>
                                    <span>Restore</span>
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Responsive Cards (< 900px) */}
                <div className={styles.mobileCardsList}>
                  {visible.map((r) => {
                    const img = vehicleImage(r.vehicleId);
                    return (
                      <div
                        key={r.id}
                        id={`reservation-${r.id}`}
                        className={styles.mobileCard}
                        onClick={() => setInspectingReservation(r)}
                      >
                        <div className={styles.mobileCardHeader}>
                          <div className={styles.mobileCardVehicle}>
                            {img ? (
                              <img src={img} alt={vehicleName(r.vehicleId)} className={styles.vehicleThumb} />
                            ) : (
                              <div className={styles.vehicleThumbFallback}>LUX</div>
                            )}
                            <div className={styles.vehicleInfo}>
                              <span className={styles.vehicleName}>{vehicleName(r.vehicleId)}</span>
                              <div className={styles.resNumberPill}>
                                  <span>{r.reservationNumber}</span>
                                </div>
                            </div>
                          </div>
                          <div>
                            {renderStatusBadge(r.status)}
                            {r.archivedAt && <div className={styles.archivedPill}>Archived</div>}
                          </div>
                        </div>

                        <div className={styles.mobileCardBody}>
                          <div className={styles.mobileField}>
                            <span className={styles.mobileFieldLabel}>Customer</span>
                            <span className={styles.mobileFieldValue}>{customerName(r.customerId)}</span>
                            <span className={styles.customerEmail} title={customerEmail(r.customerId)}>
                              {customerEmail(r.customerId)}
                            </span>
                          </div>
                          <div className={styles.mobileField}>
                            <span className={styles.mobileFieldLabel}>Total Price</span>
                            <span className={styles.mobileFieldValue}>€{formatAmount(r.totalAmount)}</span>
                          </div>
                          <div className={styles.mobileField}>
                            <span className={styles.mobileFieldLabel}>Dates</span>
                            <span className={styles.mobileFieldValue}>
                              {r.pickupAt.slice(0, 10)} → {r.returnAt.slice(0, 10)}
                            </span>
                          </div>
                          <div className={styles.mobileField}>
                            <span className={styles.mobileFieldLabel}>Deposit</span>
                            <span className={styles.mobileFieldValue}>€{formatAmount(r.depositAmount)}</span>
                          </div>
                        </div>

                        <div className={styles.mobileCardFooter} onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className={styles.mobileViewDetailsBtn}
                            onClick={() => setInspectingReservation(r)}
                            title={`Inspect dossier & actions for ${r.reservationNumber}`}
                            aria-label={`View details for reservation ${r.reservationNumber}`}
                          >
                            View Details →
                          </button>

                          {!r.archivedAt && canArchive(r) && (
                            <button
                              type="button"
                              className={styles.mobileArchiveBtn}
                              disabled={Boolean(processing)}
                              onClick={() => void setArchive(r, true)}
                              title={`Archive reservation ${r.reservationNumber}`}
                              aria-label={`Archive reservation ${r.reservationNumber}`}
                            >
                              <span>📦 Archive</span>
                            </button>
                          )}

                          {r.archivedAt && (
                            <button
                              type="button"
                              className={styles.mobileArchiveBtn}
                              disabled={Boolean(processing)}
                              onClick={() => void setArchive(r, false)}
                              title={`Restore reservation ${r.reservationNumber}`}
                              aria-label={`Restore reservation ${r.reservationNumber}`}
                            >
                              <span>↺ Restore</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {/* SLIDE-OVER DETAIL DRAWER */}
        {inspectingReservation && (
          <div
            className={styles.drawerBackdrop}
            onClick={() => setInspectingReservation(null)}
            role="dialog"
            aria-modal="true"
            aria-label={`Reservation dossier for ${inspectingReservation.reservationNumber}`}
          >
            <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
              {/* Header */}
              <div className={styles.drawerHeader}>
                <div className={styles.drawerHeaderInfo}>
                  <div className={styles.resNumberPill}>
                    <span>{inspectingReservation.reservationNumber}</span>
                    <button
                      type="button"
                      className={styles.copyBtn}
                      onClick={() => void copyResNumber(inspectingReservation.reservationNumber)}
                      title="Copy reservation reference"
                      aria-label="Copy reservation reference"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                  </div>
                  <h3 className={styles.drawerHeaderTitle}>Reservation Dossier</h3>
                </div>
                <button
                  type="button"
                  className={styles.drawerCloseBtn}
                  onClick={() => setInspectingReservation(null)}
                  aria-label="Close dossier drawer"
                >
                  ×
                </button>
              </div>

              {/* Body */}
              <div className={styles.drawerBody}>
                {/* Vehicle Hero Banner */}
                <div className={styles.drawerVehicleBanner}>
                  {vehicleImage(inspectingReservation.vehicleId) ? (
                    <img
                      src={vehicleImage(inspectingReservation.vehicleId) || ''}
                      alt={vehicleName(inspectingReservation.vehicleId)}
                      className={styles.drawerVehicleImage}
                    />
                  ) : (
                    <div className={styles.vehicleThumbFallback} style={{ width: '100%', height: '100%' }}>
                      LUXUAR FLEET
                    </div>
                  )}
                  <div className={styles.drawerVehicleOverlay}>
                    <h4>{vehicleName(inspectingReservation.vehicleId)}</h4>
                  </div>
                </div>

                {/* Status & Quick Action Card */}
                <div className={styles.drawerActionsCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className={styles.drawerSectionTitle}>STATUS &amp; ACTIONS</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {renderStatusBadge(inspectingReservation.status)}
                      {inspectingReservation.archivedAt && (
                        <span className={styles.archivedPill}>Archived Record</span>
                      )}
                    </div>
                  </div>

                  {/* Status Explanation Box */}
                  <div className={styles.statusExplainer}>
                    <div className={styles.statusExplainerHeader}>
                      <span className={styles.statusExplainerTitle}>STATUS MEANING &amp; LIFECYCLE</span>
                      <span className={inspectingReservation.archivedAt ? styles.archivedStatusTag : styles.activeStatusTag}>
                        {inspectingReservation.archivedAt ? 'Archived Record' : 'Current / In Operations'}
                      </span>
                    </div>
                    <p className={styles.statusExplainerDesc}>
                      <strong>
                        {RESERVATION_STATUS_META[inspectingReservation.status]?.label || inspectingReservation.status}:
                      </strong>{' '}
                      {RESERVATION_STATUS_META[inspectingReservation.status]?.description || 'Reservation status recorded.'}
                    </p>
                    {inspectingReservation.decisionReason && (
                      <p className={styles.statusExplainerNote}>
                        <strong>Decision Reason:</strong> {inspectingReservation.decisionReason}
                      </p>
                    )}
                  </div>

                  <div className={styles.drawerActionsRow}>
                    {inspectingReservation.status === 'pending' && (
                      <>
                        <button
                          type="button"
                          className={styles.btnPrimary}
                          disabled={Boolean(processing)}
                          onClick={() => void approveReservation(inspectingReservation)}
                        >
                          Approve &amp; Request Payment
                        </button>
                        <button
                          type="button"
                          className={styles.btnDanger}
                          disabled={Boolean(processing)}
                          onClick={() => openRejectModal(inspectingReservation)}
                        >
                          Reject
                        </button>
                      </>
                    )}

                    {inspectingReservation.status === 'awaiting_payment' && (
                        <button
                          type="button"
                          className={styles.btnDanger}
                          disabled={Boolean(processing)}
                          onClick={() => void cancelUnpaid(inspectingReservation)}
                        >
                          Cancel Unpaid
                        </button>
                    )}

                    {inspectingReservation.status === 'confirmed' && (
                        <Link href="/admin/rentals" className={styles.btnPrimary}>
                          View Active Rentals →
                        </Link>
                    )}

                    {inspectingReservation.status === 'active_rental' && (
                        <Link href="/admin/returns" className={styles.btnPrimary}>
                          Returns &amp; Deposits →
                        </Link>
                    )}

                    

                    {canEdit(inspectingReservation) && (
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        disabled={Boolean(processing)}
                        onClick={() => openEdit(inspectingReservation)}
                      >
                        Edit Dates / Vehicle
                      </button>
                    )}

                    {!inspectingReservation.archivedAt && canArchive(inspectingReservation) && (
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        disabled={Boolean(processing)}
                        onClick={() => void setArchive(inspectingReservation, true)}
                      >
                        📦 Archive Record
                      </button>
                    )}

                    {inspectingReservation.archivedAt && (
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        disabled={Boolean(processing)}
                        onClick={() => void setArchive(inspectingReservation, false)}
                      >
                        ↺ Restore to Current
                      </button>
                    )}

                    {inspectingReservation.status === 'cancelled' && (
                      <button
                        type="button"
                        className={styles.btnDanger}
                        disabled={Boolean(processing)}
                        onClick={() => void removeReservation(inspectingReservation)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {/* Customer Information */}
                <div className={styles.drawerSection}>
                  <span className={styles.drawerSectionTitle}>CUSTOMER INFORMATION</span>
                  <div className={styles.drawerGridCards}>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Full Name</span>
                      <span className={styles.drawerDataValue}>{customerName(inspectingReservation.customerId)}</span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Email Address</span>
                      <span className={styles.drawerDataValue}>{customerEmail(inspectingReservation.customerId)}</span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Customer ID</span>
                      <span className={styles.drawerDataValue} style={{ fontSize: '11px', fontFamily: 'monospace' }}>
                        {inspectingReservation.customerId}
                      </span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Customer Notes</span>
                      <span className={styles.drawerDataValue}>{inspectingReservation.customerNotes || 'None'}</span>
                    </div>
                  </div>
                </div>

                {/* Rental Schedule & Locations */}
                <div className={styles.drawerSection}>
                  <span className={styles.drawerSectionTitle}>SCHEDULE &amp; LOCATIONS</span>
                  <div className={styles.drawerGridCards}>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Pickup Date &amp; Time</span>
                      <span className={styles.drawerDataValue}>
                        {new Date(inspectingReservation.pickupAt).toLocaleString()}
                      </span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Return Date &amp; Time</span>
                      <span className={styles.drawerDataValue}>
                        {new Date(inspectingReservation.returnAt).toLocaleString()}
                      </span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Rental Duration</span>
                      <span className={styles.drawerDataValue}>{inspectingReservation.rentalDays} day(s)</span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Pickup Location</span>
                      <span className={styles.drawerDataValue}>
                        {inspectingReservation.pickupLocation || 'Main Showroom'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Financial Summary */}
                <div className={styles.drawerSection}>
                  <span className={styles.drawerSectionTitle}>FINANCIAL SPECIFICATIONS</span>
                  <div className={styles.drawerGridCards}>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Total Rental Amount</span>
                      <span className={styles.drawerDataValue} style={{ color: 'var(--gold-text)' }}>
                        €{formatAmount(inspectingReservation.totalAmount)}
                      </span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Refundable Security Deposit</span>
                      <span className={styles.drawerDataValue}>€{formatAmount(inspectingReservation.depositAmount)}</span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Daily Rate</span>
                      <span className={styles.drawerDataValue}>€{formatAmount(inspectingReservation.dailyPrice)}</span>
                    </div>
                    <div className={styles.drawerDataCard}>
                      <span className={styles.drawerDataLabel}>Payment Deadline</span>
                      <span className={styles.drawerDataValue}>
                        {inspectingReservation.paymentDeadlineAt
                          ? new Date(inspectingReservation.paymentDeadlineAt).toLocaleString()
                          : '—'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Operational Details (Decision, Notes) */}
                {inspectingReservation.decisionReason && (
                  <div className={styles.drawerSection}>
                    <span className={styles.drawerSectionTitle}>AUDIT &amp; DECISION LOGS</span>
                    <div className={styles.drawerDataCard}>
                      <p style={{ margin: 0 }}>
                        <strong>Decision Reason:</strong> {inspectingReservation.decisionReason}
                      </p>
                    </div>
                  </div>
                )}

                {/* Full Financial Ledger & Management Panel */}
                {['confirmed', 'converted', 'active_rental', 'completed'].includes(inspectingReservation.status) && (
                  <div className={styles.drawerSection}>
                    <span className={styles.drawerSectionTitle}>FINANCIAL DOSSIER &amp; LEDGER</span>
                    <ReservationFinancePanel
                      reservationId={inspectingReservation.id}
                      reservationStatus={inspectingReservation.status}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* REJECT MODAL */}
        {rejectModalReservation && (
          <div
            className={styles.modalOverlay}
            role="dialog"
            aria-modal="true"
            aria-label={`Reject reservation ${rejectModalReservation.reservationNumber}`}
          >
            <div className={styles.modal}>
              <div className={styles.modalHead}>
                <div>
                  <span className={styles.resNumberPill}>{rejectModalReservation.reservationNumber}</span>
                  <h3>Reject Reservation</h3>
                </div>
                <button
                  type="button"
                  className={styles.modalClose}
                  onClick={() => setRejectModalReservation(null)}
                  aria-label="Close dialog"
                >
                  ×
                </button>
              </div>

              <div className={styles.modalBody}>
                <p style={{ fontSize: '13.5px', color: 'var(--muted)', margin: 0 }}>
                  Please specify the official reason for declining this reservation. The client will be notified with this
                  explanation.
                </p>

                <div>
                  <label htmlFor="rejectReasonInput" className={styles.editField}>
                    Rejection Reason (Required)
                  </label>
                  <textarea
                    id="rejectReasonInput"
                    className={styles.reasonInput}
                    maxLength={500}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="e.g., Requested vehicle undergoing scheduled VIP maintenance during this period..."
                    rows={4}
                  />
                  <div
                    className={`${styles.charCounter} ${
                      rejectReason.length < 5 && rejectReason.length > 0 ? styles.charCounterError : ''
                    }`}
                  >
                    {rejectReason.length} / 500 characters (minimum 5)
                  </div>
                </div>
              </div>

              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  disabled={Boolean(processing)}
                  onClick={() => setRejectModalReservation(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.btnDanger}
                  disabled={Boolean(processing) || rejectReason.trim().length < 5}
                  onClick={() => void submitRejection()}
                >
                  {processing ? 'Rejecting...' : 'Confirm Rejection'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* EDIT MODAL */}
        {editing && (
          <div
            className={styles.modalOverlay}
            role="dialog"
            aria-modal="true"
            aria-label={`Edit reservation ${editing.reservationNumber}`}
          >
            <div className={styles.modal}>
              <div className={styles.modalHead}>
                <div>
                  <span className={styles.resNumberPill}>{editing.reservationNumber}</span>
                  <h3>Edit Reservation Schedule &amp; Fleet</h3>
                </div>
                <button type="button" className={styles.modalClose} onClick={closeEdit} aria-label="Close edit dialog">
                  ×
                </button>
              </div>

              <div className={styles.modalBody}>
                <label className={styles.editField}>
                  Vehicle
                  <select
                    value={editForm.vehicleId}
                    onChange={(e) => updateEditForm({ vehicleId: e.target.value })}
                  >
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.brandName} {v.modelName}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.editField}>
                  Rental Start Date &amp; Time
                  <input
                    type="datetime-local"
                    value={editForm.pickupAt}
                    onChange={(e) => updateEditForm({ pickupAt: e.target.value })}
                  />
                </label>

                <label className={styles.editField}>
                  Rental End Date &amp; Time
                  <input
                    type="datetime-local"
                    value={editForm.returnAt}
                    onChange={(e) => updateEditForm({ returnAt: e.target.value })}
                  />
                </label>

                <p className={styles.editHint}>
                  Prices and availability are verified and recalculated server-side. Financial ledgers and paid balances
                  are never altered silently.
                </p>

                {editPreview && (
                  <div className={styles.previewBox}>
                    <div className={styles.previewRow}>
                      <span>Fleet Availability</span>
                      <strong style={{ color: editPreview.available ? '#16a34a' : '#dc2626' }}>
                        {editPreview.available ? '✓ Available' : '✕ Unavailable'}
                      </strong>
                    </div>
                    <div className={styles.previewRow}>
                      <span>Current Total</span>
                      <strong>{formatAmount(editPreview.currentTotal)} EUR</strong>
                    </div>
                    <div className={styles.previewRow}>
                      <span>New Total</span>
                      <strong>{formatAmount(editPreview.newTotal)} EUR</strong>
                    </div>
                    <div className={styles.previewRow}>
                      <span>Price Difference</span>
                      <strong style={{ color: 'var(--gold-text)' }}>
                        {formatAmount(editPreview.priceDifference)} EUR
                      </strong>
                    </div>
                    <div className={styles.previewRow}>
                      <span>New Duration</span>
                      <strong>{editPreview.rentalDays} day(s)</strong>
                    </div>
                  </div>
                )}

                {editMessage && (
                  <div role="alert" className={`${styles.feedbackAlert} ${styles.alertError}`}>
                    {editMessage}
                  </div>
                )}
              </div>

              <div className={styles.modalActions}>
                <button type="button" className={styles.btnSecondary} disabled={editBusy} onClick={closeEdit}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  disabled={editBusy}
                  onClick={() => void previewEdit()}
                >
                  {editBusy ? 'Checking...' : 'Check Availability & Price'}
                </button>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={editBusy || editValidated !== JSON.stringify(buildEditPayload())}
                  title={editValidated !== JSON.stringify(buildEditPayload()) ? 'Check availability first' : undefined}
                  onClick={() => void saveEdit()}
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
