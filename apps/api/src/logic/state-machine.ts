/**
 * State Machine Guard Module
 * Aligned strictly with docs/policies/STATE_MACHINE.md (LOCKED)
 */

export type BookingState =
    | 'PENDING_PAYMENT'
    | 'PAID_SEARCHING'
    | 'ACCEPTED'
    | 'EN_ROUTE'
    | 'ARRIVED'
    | 'IN_PROGRESS'
    | 'COMPLETE_PENDING'
    | 'CLOSED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'NEEDS_REVIEW';

export type UserRole = 'User' | 'System' | 'Provider' | 'Admin';

interface Transition {
    to: BookingState;
    who: UserRole;
}

const allowedTransitions: Record<string, Transition[]> = {
    'NULL': [{ to: 'PENDING_PAYMENT', who: 'User' }],
    'PENDING_PAYMENT': [
        { to: 'PAID_SEARCHING', who: 'System' },
        { to: 'CANCELLED', who: 'User' },
        { to: 'EXPIRED', who: 'System' }
    ],
    'PAID_SEARCHING': [
        { to: 'ACCEPTED', who: 'Provider' },
        { to: 'EXPIRED', who: 'System' },
        { to: 'CANCELLED', who: 'User' }
    ],
    'ACCEPTED': [
        { to: 'EN_ROUTE', who: 'Provider' },
        { to: 'CANCELLED', who: 'User' },
        { to: 'CANCELLED', who: 'Provider' },
        { to: 'PAID_SEARCHING', who: 'Provider' } // Re-dispatch
    ],
    'EN_ROUTE': [
        { to: 'ARRIVED', who: 'Provider' },
        { to: 'CANCELLED', who: 'User' },
        { to: 'CANCELLED', who: 'Provider' },
        { to: 'PAID_SEARCHING', who: 'Provider' } // Re-dispatch
    ],
    'ARRIVED': [
        { to: 'IN_PROGRESS', who: 'Provider' }, // Requires OTP (enforced in logic)
        { to: 'CANCELLED', who: 'User' },
        { to: 'CANCELLED', who: 'Provider' }
    ],
    'IN_PROGRESS': [{ to: 'COMPLETE_PENDING', who: 'Provider' }],
    'COMPLETE_PENDING': [
        { to: 'CLOSED', who: 'System' }, // Auto-close
        { to: 'NEEDS_REVIEW', who: 'User' } // Issue reported
    ],
    'CLOSED': [], // Terminal
    'CANCELLED': [], // Terminal
    'EXPIRED': [], // Terminal
    'NEEDS_REVIEW': [{ to: 'CLOSED', who: 'Admin' }, { to: 'CANCELLED', who: 'Admin' }],
};

/**
 * Validates a transition based on current state, target state, and user role.
 */
export function isValidTransition(from: BookingState | 'NULL', to: BookingState, role: UserRole): boolean {
    const transitions = allowedTransitions[from];
    if (!transitions) return false;

    return transitions.some(t => t.to === to && t.who === role);
}

/**
 * Payment Invariant: Payout eligibility.
 * From PAYMENTS.md: "Funds are only eligible for payout once the state machine reaches CLOSED."
 */
export function isEligibleForPayout(state: BookingState): boolean {
    return state === 'CLOSED';
}

/**
 * Refund Invariant: Refund eligibility.
 * From PAYMENTS.md: "Refunds are only permitted for bookings in PAID state."
 */
export function isEligibleForRefund(state: BookingState): boolean {
    return state === 'PAID_SEARCHING';
}
