/**
 * LUXURYCARS — Reservation Status Categorization System
 * 
 * Maps internal backend reservation statuses into the strict six customer-facing
 * categories:
 *  1. Pending Approval
 *  2. Awaiting Payment
 *  3. Confirmed
 *  4. Active Rental
 *  5. Completed
 *  6. Rejected (strictly incorporates all cancelled, cancelled_unpaid and no-show bookings)
 */

export type CustomerReservationCategory =
  | 'Pending Approval'
  | 'Awaiting Payment'
  | 'Confirmed'
  | 'Active Rental'
  | 'Completed'
  | 'Rejected';

export const RESERVATION_CATEGORIES: readonly CustomerReservationCategory[] = [
  'Pending Approval',
  'Awaiting Payment',
  'Confirmed',
  'Active Rental',
  'Completed',
  'Rejected',
] as const;

export interface CategorizableReservation {
  status: string;
  rentalStatus?: string | null;
  paidAt?: string | null;
  paymentDeadlineAt?: string | null;
}

/**
 * Maps any backend reservation to exactly one of the six customer-facing categories.
 * Guarantees that Cancelled and Rejected are grouped strictly into 'Rejected'
 * without double-counting or orphan statuses.
 */
export function getReservationCategory(reservation: CategorizableReservation): CustomerReservationCategory {
  const status = (reservation.status || '').toLowerCase().trim();
  const rentalStatus = (reservation.rentalStatus || '').toLowerCase().trim();

  // 1. Pending approval by agency concierge
  if (status === 'pending') {
    return 'Pending Approval';
  }

  // 2. Concierge approved, customer payment window active
  if (status === 'awaiting_payment') {
    return 'Awaiting Payment';
  }

  // 3. Payment & deposit confirmed, vehicle hold guaranteed
  if (status === 'confirmed') {
    return 'Confirmed';
  }

  // 4. Vehicle in custody (active rental)
  if (status === 'active_rental') {
    return 'Active Rental';
  }

  // 5. Converted to rental record
  if (status === 'converted') {
    if (rentalStatus === 'closed') {
      return 'Completed';
    }
    // 'active' or 'returned' (vehicle returned and inspection/deposit settlement finalizing)
    return 'Active Rental';
  }

  // 6. Rental ended and completed
  if (status === 'completed') {
    return 'Completed';
  }

  // 7. Rejected / Cancelled / Expired Unpaid
  // CRITICAL REQUIREMENT: Cancelled reservations MUST be grouped with Rejected.
  // The 'Rejected' counter must include both rejected and cancelled reservations.
  if (
    status === 'rejected' ||
    status === 'cancelled' ||
    status === 'cancelled_unpaid' ||
    status === 'expired'
  ) {
    return 'Rejected';
  }

  // Default fallback for any unexpected terminal/cancelled state
  return 'Rejected';
}

/**
 * Provides refined editorial label for badges (while keeping category mapping intact).
 */
export function getDetailedStatusLabel(reservation: CategorizableReservation): {
  label: string;
  category: CustomerReservationCategory;
  tone: 'gold' | 'amber' | 'emerald' | 'cyan' | 'crimson' | 'muted';
} {
  const category = getReservationCategory(reservation);
  const status = (reservation.status || '').toLowerCase().trim();
  const rentalStatus = (reservation.rentalStatus || '').toLowerCase().trim();

  switch (category) {
    case 'Pending Approval':
      return {
        label: 'Pending Approval',
        category,
        tone: 'amber',
      };
    case 'Awaiting Payment':
      return {
        label: 'Awaiting Payment · 24h Window',
        category,
        tone: 'amber',
      };
    case 'Confirmed':
      return {
        label: 'Confirmed & Guaranteed',
        category,
        tone: 'gold',
      };
    case 'Active Rental':
      return {
        label: rentalStatus === 'returned' ? 'Return Processing' : 'Active Rental',
        category,
        tone: 'cyan',
      };
    case 'Completed':
      return {
        label: 'Completed',
        category,
        tone: 'emerald',
      };
    case 'Rejected':
      if (status === 'cancelled' || status === 'cancelled_unpaid') {
        return {
          label: 'Rejected (Cancelled)',
          category,
          tone: 'crimson',
        };
      }
      if (status === 'expired') {
        return {
          label: 'Rejected (Expired)',
          category,
          tone: 'crimson',
        };
      }
      return {
        label: 'Rejected',
        category,
        tone: 'crimson',
      };
  }
}

/**
 * Calculates zero-duplicate category counts over a list of reservations.
 */
export function calculateCategoryCounts(
  reservations: CategorizableReservation[],
): Record<CustomerReservationCategory, number> {
  const counts: Record<CustomerReservationCategory, number> = {
    'Pending Approval': 0,
    'Awaiting Payment': 0,
    'Confirmed': 0,
    'Active Rental': 0,
    'Completed': 0,
    'Rejected': 0,
  };

  for (const reservation of reservations) {
    const category = getReservationCategory(reservation);
    counts[category] += 1;
  }

  return counts;
}

/**
 * Stepper progress step index (0 to 4) based on real booking progress.
 */
export function getReservationStepIndex(reservation: CategorizableReservation): {
  currentStep: number;
  totalSteps: number;
  isTerminalRejection: boolean;
  stepLabels: string[];
} {
  const stepLabels = [
    'Request Placed',
    'Concierge Review',
    'Payment & Hold',
    'Active Rental',
    'Return & Settlement',
  ];

  const category = getReservationCategory(reservation);

  if (category === 'Rejected') {
    return {
      currentStep: 1, // Stopped after request / concierge decision
      totalSteps: 5,
      isTerminalRejection: true,
      stepLabels,
    };
  }

  switch (category) {
    case 'Pending Approval':
      return { currentStep: 1, totalSteps: 5, isTerminalRejection: false, stepLabels };
    case 'Awaiting Payment':
      return { currentStep: 2, totalSteps: 5, isTerminalRejection: false, stepLabels };
    case 'Confirmed':
      return { currentStep: 3, totalSteps: 5, isTerminalRejection: false, stepLabels };
    case 'Active Rental':
      return { currentStep: 4, totalSteps: 5, isTerminalRejection: false, stepLabels };
    case 'Completed':
      return { currentStep: 5, totalSteps: 5, isTerminalRejection: false, stepLabels };
  }
}

export interface StatusExplanation {
  title: string;
  description: string;
  reasonCode: string;
}

/**
 * Distinguishes granular reasons within the unified 'Rejected' category
 * (e.g. voluntary cancellation, payment timeout, admin refusal, no-show).
 */
export function getStatusExplanation(
  reservation: CategorizableReservation & {
    noShowReason?: string | null;
    noShowDeadlineAt?: string | null;
  },
): StatusExplanation | null {
  const status = (reservation.status || '').toLowerCase().trim();

  switch (status) {
    case 'cancelled':
      return {
        title: 'Cancelled by Hirer',
        description:
          'This reservation was voluntarily cancelled before vehicle handover. Fleet availability has been restored with zero penalty fees.',
        reasonCode: 'HIRER_VOLUNTARY_CANCELLATION',
      };

    case 'cancelled_unpaid':
      return {
        title: 'Cancelled · 24h Payment Window Expired',
        description:
          'The 24-hour card guarantee deadline elapsed without confirmation. The vehicle hold was automatically released to maintain fair fleet availability.',
        reasonCode: 'PAYMENT_DEADLINE_EXPIRED',
      };

    case 'expired':
      return {
        title: 'Reservation Request Expired',
        description:
          'The booking request timed out prior to formal concierge confirmation. No pre-authorizations or payments were captured.',
        reasonCode: 'RESERVATION_TIMED_OUT',
      };

    case 'rejected':
      return {
        title: 'Concierge Review Declined',
        description:
          'Our private fleet operations desk was unable to approve this reservation request for the requested schedule.',
        reasonCode: 'CONCIERGE_DESK_DECLINED',
      };

    default:
      return null;
  }
}
