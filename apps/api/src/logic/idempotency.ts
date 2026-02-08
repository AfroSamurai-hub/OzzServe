import { query, withTx } from '../db.js';

export enum EventStatus {
    PENDING = 'PENDING',
    PROCESSED = 'PROCESSED',
    FAILED = 'FAILED',
}

/**
 * Persistently processes a webhook event with idempotency.
 * Checks the ledger first. If PROCESSED, returns DUPLICATE status.
 * Otherwise, runs the handler and updates the ledger.
 */
export async function processEvent(
    provider: string,
    eventId: string,
    handlerFn: () => Promise<void>
): Promise<'PROCESSED' | 'DUPLICATE'> {
    return withTx(async (client) => {
        // 1. Check ledger
        const res = await client.query(
            'SELECT status FROM webhook_events WHERE provider = $1 AND event_id = $2 FOR UPDATE',
            [provider, eventId]
        );

        if (res.rows[0]?.status === EventStatus.PROCESSED) {
            return 'DUPLICATE';
        }

        // 2. If not found or failed, upsert to PENDING
        await client.query(
            `INSERT INTO webhook_events (provider, event_id, status, payload_json, last_seen_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (provider, event_id) DO UPDATE 
             SET status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at`,
            [provider, eventId, EventStatus.PENDING, null]
        );

        try {
            // 3. Run side-effect
            await handlerFn();

            // 4. Mark PROCESSED
            await client.query(
                'UPDATE webhook_events SET status = $1, last_seen_at = CURRENT_TIMESTAMP WHERE provider = $2 AND event_id = $3',
                [EventStatus.PROCESSED, provider, eventId]
            );

            return 'PROCESSED';
        } catch (error) {
            // Mark FAILED to allow retries
            await client.query(
                'UPDATE webhook_events SET status = $1, last_seen_at = CURRENT_TIMESTAMP WHERE provider = $2 AND event_id = $3',
                [EventStatus.FAILED, provider, eventId]
            );
            throw error;
        }
    });
}
