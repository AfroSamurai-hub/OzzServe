import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('Payments v1 & Webhook Idempotency', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildServer();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await query('TRUNCATE providers, provider_services, bookings, booking_events, payment_intents, webhook_events RESTART IDENTITY CASCADE');
    });

    const SERVICE_ID = '550e8400-e29b-41d4-a716-446655440001';
    const SLOT_ID = '550e8400-e29b-41d4-a716-446655440002';
    const CUSTOMER_UID = '550e8400-e29b-41d4-a716-446655440003';

    test('Webhook flow: Success event transitions booking to PAID', async () => {
        // 1. Create booking
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_UID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_UID },
        });
        const bookingId = createRes.json().id;

        // 2. Create Payment Intent
        const payRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/pay`,
            headers: { 'x-user-id': CUSTOMER_UID, 'x-role': 'user' },
        });
        const { payment_intent_id } = payRes.json();

        // Find provider_ref for the mock webhook
        const dbRes = await query('SELECT provider_ref FROM payment_intents WHERE id = $1', [payment_intent_id]);
        const providerRef = dbRes.rows[0].provider_ref;

        // 3. Send Webhook
        const webhookRes = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload: {
                id: 'evt_123',
                type: 'payment_intent.succeeded',
                data: { object: { id: providerRef } }
            }
        });
        expect(webhookRes.statusCode).toBe(200);
        expect(webhookRes.json().status).toBe('PROCESSED');

        // 4. Verify booking is now PAID
        const checkRes = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
        expect(checkRes.rows[0].status).toBe('PAID');
    });

    test('Webhook Idempotency: Duplicate events run handler only once', async () => {
        const eventId = 'evt_dup_456';
        const payload = { id: eventId, type: 'ping' };

        // 1. First call
        const res1 = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload
        });
        expect(res1.json().status).toBe('PROCESSED');

        // 2. Second call (Duplicate)
        const res2 = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload
        });
        expect(res2.json().status).toBe('DUPLICATE');

        // 3. Verify ledger count
        const ledgerRes = await query('SELECT count(*) FROM webhook_events WHERE event_id = $1', [eventId]);
        expect(ledgerRes.rows[0].count).toBe('1');
    });

    test('Invalid signature returns 401 in production mode', async () => {
        // Mock production environment
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'wrong' },
            payload: { id: 'evt_sig', type: 'ping' }
        });
        expect(res.statusCode).toBe(401);

        process.env.NODE_ENV = originalEnv;
    });
});
