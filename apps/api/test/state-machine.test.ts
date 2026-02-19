import { describe, test, expect } from 'vitest';
import { isValidTransition, isEligibleForPayout, isEligibleForRefund, BookingState, UserRole } from '../src/logic/state-machine.js';

describe('Logic: State Machine Guards (Contract Aligned)', () => {

    test('Happy Path Lifecycle', () => {
        // NULL -> PENDING_PAYMENT (User)
        expect(isValidTransition('NULL', 'PENDING_PAYMENT', 'User')).toBe(true);
        // PENDING_PAYMENT -> PAID_SEARCHING (System)
        expect(isValidTransition('PENDING_PAYMENT', 'PAID_SEARCHING', 'System')).toBe(true);
        // PAID_SEARCHING -> ACCEPTED (Provider)
        expect(isValidTransition('PAID_SEARCHING', 'ACCEPTED', 'Provider')).toBe(true);
        // ACCEPTED -> EN_ROUTE (Provider)
        expect(isValidTransition('ACCEPTED', 'EN_ROUTE', 'Provider')).toBe(true);
        // EN_ROUTE -> ARRIVED (Provider)
        expect(isValidTransition('EN_ROUTE', 'ARRIVED', 'Provider')).toBe(true);
        // ARRIVED -> IN_PROGRESS (Provider)
        expect(isValidTransition('ARRIVED', 'IN_PROGRESS', 'Provider')).toBe(true);
        // IN_PROGRESS -> COMPLETE_PENDING (Provider)
        expect(isValidTransition('IN_PROGRESS', 'COMPLETE_PENDING', 'Provider')).toBe(true);
        // COMPLETE_PENDING -> CLOSED (System)
        expect(isValidTransition('COMPLETE_PENDING', 'CLOSED', 'System')).toBe(true);
    });

    describe('Illegal Transitions', () => {
        test('PENDING_PAYMENT -> CLOSED (Skipping steps)', () => {
            expect(isValidTransition('PENDING_PAYMENT', 'CLOSED', 'User')).toBe(false);
        });
        test('ACCEPTED -> PAID_SEARCHING (Going backward)', () => {
            expect(isValidTransition('ACCEPTED', 'PAID_SEARCHING', 'Admin')).toBe(false);
        });
        test('CLOSED -> ARRIVED (From terminal state)', () => {
            expect(isValidTransition('CLOSED', 'ARRIVED', 'System')).toBe(false);
        });
        test('CANCELLED -> EN_ROUTE (From terminal state)', () => {
            expect(isValidTransition('CANCELLED', 'EN_ROUTE', 'System')).toBe(false);
        });
    });

    describe('Unauthorized Transitions', () => {
        test('PAID_SEARCHING -> ACCEPTED (User instead of Provider)', () => {
            expect(isValidTransition('PAID_SEARCHING', 'ACCEPTED', 'User')).toBe(false);
        });
        test('COMPLETE_PENDING -> CLOSED (Admin instead of System)', () => {
            expect(isValidTransition('COMPLETE_PENDING', 'CLOSED', 'Admin')).toBe(false);
        });
    });

    describe('Payment Invariants', () => {
        test('Payout only after CLOSED', () => {
            expect(isEligibleForPayout('IN_PROGRESS')).toBe(false);
            expect(isEligibleForPayout('CLOSED')).toBe(true);
        });
        test('Refund in PAID_SEARCHING state', () => {
            expect(isEligibleForRefund('PENDING_PAYMENT')).toBe(false);
            expect(isEligibleForRefund('PAID_SEARCHING')).toBe(true);
            expect(isEligibleForRefund('CLOSED')).toBe(false);
        });
    });
});
