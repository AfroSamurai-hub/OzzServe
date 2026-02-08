/**
 * State Machine Guard Module
 * Aligned strictly with docs/policies/STATE_MACHINE.md (LOCKED)
 */

export type BookingState = 'PENDING' | 'AWAITING_PAYMENT' | 'PAID' | 'IN_PROGRESS' | 'CLOSED' | 'CANCELLED';
export type UserRole = 'User' | 'System' | 'Provider' | 'Admin';

interface Transition {
    to: BookingState;
    who: UserRole;
}

const allowedTransitions: Record<string, Transition[]> = {
    'NULL': [{ to: 'PENDING', who: 'User' }],
    'PENDING': [{ to: 'AWAITING_PAYMENT', who: 'User' }],
    'AWAITING_PAYMENT': [
        { to: 'PAID', who: 'System' },
        { to: 'CANCELLED', who: 'System' }
    ],
    'PAID': [
        { to: 'IN_PROGRESS', who: 'Provider' },
        { to: 'CANCELLED', who: 'Admin' }
    ],
    'IN_PROGRESS': [{ to: 'CLOSED', who: 'Provider' }],
    'CLOSED': [], // Terminal
    'CANCELLED': [], // Terminal
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
    return state === 'PAID';
}
