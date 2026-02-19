import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';
import crypto from 'crypto';

describe('Webhook Signature Verification & Stripe Integration', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildServer();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await query('TRUNCATE providers, provider_services, bookings, booking_events, payment_intents, webhook_events RESTART IDENTITY CASCADE');
        delete process.env.NODE_ENV;
        delete process.env.STRIPE_WEBHOOK_SECRET;
        delete process.env.STRIPE_SECRET_KEY;
        vi.unstubAllEnvs();
    });

    // --- Dev mode (existing behavior preserved) ---

    test('Dev mode: valid_secret signature works as before', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload: { id: 'evt_dev_1', type: 'ping' }
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe('PROCESSED');
    });

    test('Dev mode: wrong signature is rejected', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'wrong' },
            payload: { id: 'evt_dev_2', type: 'ping' }
        });
        expect(res.statusCode).toBe(401);
    });

    test('Missing event ID returns 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload: { type: 'ping' } // No 'id' field
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('Missing event ID');
    });

    // --- Idempotency ---

    test('Idempotency: duplicate event returns DUPLICATE', async () => {
        const eventId = 'evt_idem_1';
        const payload = { id: eventId, type: 'ping' };

        const res1 = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload
        });
        expect(res1.json().status).toBe('PROCESSED');

        const res2 = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload
        });
        expect(res2.json().status).toBe('DUPLICATE');
    });

    // --- HMAC fallback (webhook secret set, no Stripe secret key) ---

    test('HMAC fallback: valid HMAC signature succeeds when webhook secret set', async () => {
        const secret = 'test_webhook_hmac_secret';
        const payload = { id: 'evt_hmac_1', type: 'test' };
        const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

        vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);

        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': sig },
            payload
        });
        expect(res.statusCode).toBe(200);
    });

    test('HMAC fallback: wrong HMAC signature fails when webhook secret set', async () => {
        vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'real_secret');

        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'totally_wrong' },
            payload: { id: 'evt_hmac_2', type: 'test' }
        });
        expect(res.statusCode).toBe(401);
    });

    // --- Production mode guards ---

    test('Production mode: rejects when webhook secret missing', async () => {
        vi.stubEnv('NODE_ENV', 'production');

        const res = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload: { id: 'evt_prod_1', type: 'test' }
        });
        expect(res.statusCode).toBe(401);
    });

    // --- Stripe ref stored on booking ---

    test('Pay endpoint stores stripe_payment_intent_id on booking', async () => {
        const CUSTOMER_UID = '550e8400-e29b-41d4-a716-446655440003';

        // Create booking
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_UID, 'x-role': 'user' },
            payload: {
                service_id: '550e8400-e29b-41d4-a716-446655440001',
                slot_id: '550e8400-e29b-41d4-a716-446655440002',
                user_id: CUSTOMER_UID
            },
        });
        const bookingId = createRes.json().id;

        // Pay
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/pay`,
            headers: { 'x-user-id': CUSTOMER_UID, 'x-role': 'user' },
        });

        // Verify stripe_payment_intent_id is set on booking
        const dbRes = await query('SELECT stripe_payment_intent_id FROM bookings WHERE id = $1', [bookingId]);
        expect(dbRes.rows[0].stripe_payment_intent_id).toBeTruthy();
        expect(dbRes.rows[0].stripe_payment_intent_id).toMatch(/^pi_mock_/); // Dev mode uses mock refs
    });
});
