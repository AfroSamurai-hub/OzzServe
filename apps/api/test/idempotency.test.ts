import { describe, test, expect, beforeEach, vi } from 'vitest';
import { processEvent } from '../src/logic/idempotency.js';
import { query } from '../src/db.js';

describe('Logic: Webhook Idempotency (Persistent Ledger)', () => {
    beforeEach(async () => {
        await query('TRUNCATE webhook_events RESTART IDENTITY CASCADE');
    });

    test('should process a new event and call handler', async () => {
        const handler = vi.fn().mockResolvedValue(true);
        const result = await processEvent('stripe', 'evt_1', handler);

        expect(result).toBe('PROCESSED');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('should return DUPLICATE and skip handler for repeat events', async () => {
        const handler = vi.fn().mockResolvedValue(true);

        await processEvent('stripe', 'evt_2', handler);
        const result = await processEvent('stripe', 'evt_2', handler);

        expect(result).toBe('DUPLICATE');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('should NOT mark event as processed if handler fails', async () => {
        const failingHandler = vi.fn().mockRejectedValue(new Error('Process failed'));
        const successHandler = vi.fn().mockResolvedValue(true);

        await expect(processEvent('stripe', 'evt_error', failingHandler)).rejects.toThrow();

        // Second attempt with same ID should succeed if first one failed
        const result = await processEvent('stripe', 'evt_error', successHandler);
        expect(result).toBe('PROCESSED');
        expect(successHandler).toHaveBeenCalledTimes(1);
    });

    test('should distinguish between different events', async () => {
        const handler = vi.fn().mockResolvedValue(true);

        await processEvent('stripe', 'evt_a', handler);
        await processEvent('stripe', 'evt_b', handler);

        expect(handler).toHaveBeenCalledTimes(2);
    });
});
