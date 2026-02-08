import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';
import crypto from 'crypto';

describe('Hardening & History Verification', () => {
    let app: FastifyInstance;

    const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440001';
    const PROVIDER_ID = '550e8400-e29b-41d4-a716-446655440002';
    const SERVICE_ID = '550e8400-e29b-41d4-a716-446655440004';
    const SLOT_ID = '550e8400-e29b-41d4-a716-446655440005';

    beforeAll(async () => {
        app = await buildServer();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await query('TRUNCATE providers, provider_services, bookings, booking_events, payment_intents, webhook_events RESTART IDENTITY CASCADE');
        // Reset NODE_ENV and secrets for isolation
        delete process.env.NODE_ENV;
        delete process.env.STRIPE_WEBHOOK_SECRET;
        vi.unstubAllEnvs();
    });

    describe('Production Guards', () => {
        test('Dev headers fail when NODE_ENV=production', async () => {
            vi.stubEnv('NODE_ENV', 'production');
            const res = await app.inject({
                method: 'GET',
                url: '/v1/bookings',
                headers: { 'x-user-id': 'any', 'x-role': 'user' }
            });
            expect(res.statusCode).toBe(401);
            expect(res.json().code).toBe('AUTH_DEV_DISABLED');
        });

        test('Webhook stub fails when NODE_ENV=production and secret is missing', async () => {
            vi.stubEnv('NODE_ENV', 'production');
            const res = await app.inject({
                method: 'POST',
                url: '/v1/webhooks/stripe',
                headers: { 'x-signature': 'valid_secret' },
                payload: { id: 'evt_1', type: 'test' }
            });
            expect(res.statusCode).toBe(401);
            expect(res.json().code).toBe('WEBHOOK_INVALID_SIG');
        });

        test('Real signature works when secret is configured', async () => {
            const secret = 'mysupersecret';
            const payload = { id: 'evt_1', type: 'test' };
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
    });

    describe('Booking History', () => {
        beforeEach(async () => {
            // Setup a provider and some bookings
            await app.inject({
                method: 'POST',
                url: '/v1/providers/me',
                headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
                payload: { display_name: 'Pro', is_online: true, services: [SERVICE_ID] }
            });

            // Create 3 bookings for our customer
            for (let i = 0; i < 3; i++) {
                const res = await app.inject({
                    method: 'POST',
                    url: '/v1/bookings',
                    headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
                    payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
                });
                if (i === 1) { // Claim one
                    const id = res.json().id;
                    // Mock pay to make it claimable (if required by lifecycle, though getProviderBookings just checks provider_id)
                    // Let's just manually set provider_id for testing the query
                    await query('UPDATE bookings SET provider_id = $1 WHERE id = $2', [PROVIDER_ID, id]);
                }
            }
        });

        test('Customer can see their own bookings', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/bookings',
                headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().length).toBe(3);
            expect(res.json()[0].customer_id).toBe(CUSTOMER_ID);
        });

        test('Provider can see their claimed bookings', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/bookings/claimed',
                headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().length).toBe(1);
            expect(res.json()[0].provider_id).toBe(PROVIDER_ID);
        });

        test('Pagination works', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/bookings?limit=1&offset=1',
                headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
            });
            expect(res.json().length).toBe(1);
        });
    });
});
