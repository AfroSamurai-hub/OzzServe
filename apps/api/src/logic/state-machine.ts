/**
 * State Machine Guard Module
 * Reads allowed transitions from doc/policies/STATE_MACHINE.md logic.
 */

export type BookingState = 'PENDING' | 'AWAITING_PAYMENT' | 'PAID' | 'IN_PROGRESS' | 'CLOSED' | 'CANCELLED';

const allowedTransitions: Record<string, BookingState[]> = {
    'PENDING': ['AWAITING_PAYMENT', 'CANCELLED'],
    'AWAITING_PAYMENT': ['PAID', 'CANCELLED'],
    'PAID': ['IN_PROGRESS', 'CANCELLED'],
    'IN_PROGRESS': ['CLOSED'],
    'CLOSED': [], // Terminal
    'CANCELLED': [], // Terminal
};

export function isValidTransition(from: BookingState | 'NULL', to: BookingState): boolean {
    if (from === 'NULL') {
        return to === 'PENDING';
    }
    return allowedTransitions[from]?.includes(to) ?? false;
}
