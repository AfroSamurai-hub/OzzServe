import { describe, test, expect } from 'vitest';
import { isValidTransition } from '../src/logic/state-machine.js';

describe('Logic: State Machine Guards', () => {
    test('should allow NULL -> PENDING', () => {
        expect(isValidTransition('NULL', 'PENDING')).toBe(true);
    });

    test('should allow PENDING -> AWAITING_PAYMENT', () => {
        expect(isValidTransition('PENDING', 'AWAITING_PAYMENT')).toBe(true);
    });

    test('should block illegal transition (PENDING -> CLOSED)', () => {
        expect(isValidTransition('PENDING', 'CLOSED')).toBe(false);
    });

    test('should block illegal transition (PAID -> PENDING)', () => {
        expect(isValidTransition('PAID', 'PENDING')).toBe(false);
    });
});
