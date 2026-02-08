import { describe, test, expect } from 'vitest';
import { isValidTransition, isEligibleForPayout, isEligibleForRefund, BookingState, UserRole } from '../src/logic/state-machine.js';

describe('Logic: State Machine Guards (Contract Aligned)', () => {

    test('Happy Path Lifecycle', () => {
        // NULL -> PENDING (User)
        expect(isValidTransition('NULL', 'PENDING', 'User')).toBe(true);
        // PENDING -> AWAITING_PAYMENT (User)
        expect(isValidTransition('PENDING', 'AWAITING_PAYMENT', 'User')).toBe(true);
        // AWAITING_PAYMENT -> PAID (System)
        expect(isValidTransition('AWAITING_PAYMENT', 'PAID', 'System')).toBe(true);
        // PAID -> IN_PROGRESS (Provider)
        expect(isValidTransition('PAID', 'IN_PROGRESS', 'Provider')).toBe(true);
        // IN_PROGRESS -> CLOSED (Provider)
        expect(isValidTransition('IN_PROGRESS', 'CLOSED', 'Provider')).toBe(true);
    });

    describe('Illegal Transitions (5 Examples)', () => {
        test('PENDING -> CLOSED (Skipping steps)', () => {
            expect(isValidTransition('PENDING', 'CLOSED', 'User')).toBe(false);
        });
        test('PAID -> PENDING (Going backward)', () => {
            expect(isValidTransition('PAID', 'PENDING', 'Admin')).toBe(false);
        });
        test('CLOSED -> PENDING (From terminal state)', () => {
            expect(isValidTransition('CLOSED', 'PENDING', 'System')).toBe(false);
        });
        test('CANCELLED -> PAID (From terminal state)', () => {
            expect(isValidTransition('CANCELLED', 'PAID', 'System')).toBe(false);
        });
        test('NULL -> PAID (Skipping creation)', () => {
            expect(isValidTransition('NULL', 'PAID', 'User')).toBe(false);
        });
    });

    describe('Unauthorized Transitions (2 Examples)', () => {
        test('PAID -> IN_PROGRESS (User instead of Provider)', () => {
            expect(isValidTransition('PAID', 'IN_PROGRESS', 'User')).toBe(false);
        });
        test('AWAITING_PAYMENT -> PAID (Admin instead of System)', () => {
            expect(isValidTransition('AWAITING_PAYMENT', 'PAID', 'Admin')).toBe(false);
        });
    });

    describe('Payment Invariants (2 Examples)', () => {
        test('Payout only after CLOSED', () => {
            expect(isEligibleForPayout('IN_PROGRESS')).toBe(false);
            expect(isEligibleForPayout('CLOSED')).toBe(true);
        });
        test('Refund only in PAID state', () => {
            expect(isEligibleForRefund('PENDING')).toBe(false);
            expect(isEligibleForRefund('PAID')).toBe(true);
            expect(isEligibleForRefund('CLOSED')).toBe(false);
        });
    });
});
