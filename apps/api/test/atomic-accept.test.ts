import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('Atomic Accept Verification', () => {
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

    async function mockPay(bookingId: string) {
        const payRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/pay`,
            headers: { 'x-user-id': 'admin', 'x-role': 'admin' },
        });
        const { payment_intent_id } = payRes.json();
        const dbRes = await query('SELECT provider_ref FROM payment_intents WHERE id = $1', [payment_intent_id]);
        const providerRef = dbRes.rows[0].provider_ref;

        await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload: {
                id: `evt_${Math.random()}`,
                type: 'payment_intent.succeeded',
                data: { object: { id: providerRef } }
            }
        });
    }

    test('First accept wins, second fails', async () => {
        const customer_uid = '550e8400-e29b-41d4-a716-446655440003';
        const provider_uid_1 = '550e8400-e29b-41d4-a716-446655440004';
        const provider_uid_2 = '550e8400-e29b-41d4-a716-446655440005';
        const service_id = '550e8400-e29b-41d4-a716-446655440001';

        // 0. Onboard Providers
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': provider_uid_1, 'x-role': 'provider' },
            payload: { display_name: 'P1', is_online: true, services: [service_id] },
        });
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': provider_uid_2, 'x-role': 'provider' },
            payload: { display_name: 'P2', is_online: true, services: [service_id] },
        });

        // 1. Create and Pay for booking
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': customer_uid, 'x-role': 'user' },
            payload: {
                service_id,
                slot_id: '550e8400-e29b-41d4-a716-446655440002',
                user_id: customer_uid,
            },
        });
        const { id } = createRes.json();
        await mockPay(id);

        // 2. Concurrent Accept attempts
        const res1 = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': provider_uid_1, 'x-role': 'provider' },
        });

        const res2 = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': provider_uid_2, 'x-role': 'provider' },
        });

        expect(res1.statusCode).toBe(200);
        expect(res1.json().status).toBe('ACCEPTED');
        expect(res2.statusCode).toBe(400);

        // 3. Verify final state
        const dbRes = await query('SELECT provider_id FROM bookings WHERE id = $1', [id]);
        expect(dbRes.rows[0].provider_id).toBe(provider_uid_1);
    });
});
