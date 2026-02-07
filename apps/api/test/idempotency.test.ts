import { describe, test, expect, beforeEach } from 'vitest';
import { isNewEvent, clearEvents } from '../src/logic/idempotency.js';

describe('Logic: Webhook Idempotency', () => {
    beforeEach(() => {
        clearEvents();
    });

    test('should process a new event the first time', () => {
        expect(isNewEvent('evt_123')).toBe(true);
    });

    test('should reject the same event ID a second time', () => {
        isNewEvent('evt_456');
        expect(isNewEvent('evt_456')).toBe(false);
    });

    test('should allow different event IDs', () => {
        expect(isNewEvent('evt_789')).toBe(true);
        expect(isNewEvent('evt_abc')).toBe(true);
    });
});
