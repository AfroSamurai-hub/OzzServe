import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('Vertical Slice: Booking Lifecycle (Postgres)', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildServer();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        // Clean up database before each test
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

    test('Full Happy Path (Create -> Formal Pay -> Accept -> Travel -> Arrived -> Start -> Complete)', async () => {
        const customer_uid = '550e8400-e29b-41d4-a716-446655440003';
        const provider_uid = '550e8400-e29b-41d4-a716-446655440004';
        const service_id = '550e8400-e29b-41d4-a716-446655440001';

        // 0. Onboard Provider
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': provider_uid, 'x-role': 'provider' },
            payload: { display_name: 'P1', is_online: true, services: [service_id] },
        });

        // 1. Create Booking (NULL -> PENDING_PAYMENT)
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
        expect(createRes.statusCode).toBe(201);
        const { id } = createRes.json();

        // 2. Try Accept (Should fail, status is PENDING_PAYMENT)
        const failAcceptRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': provider_uid, 'x-role': 'provider' },
        });
        expect(failAcceptRes.statusCode).toBe(400);

        // 3. Formal Payment via Webhook (PENDING_PAYMENT -> PAID_SEARCHING)
        await mockPay(id);

        // 4. Accept (PAID_SEARCHING -> ACCEPTED)
        const acceptRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': provider_uid, 'x-role': 'provider' },
        });
        expect(acceptRes.statusCode).toBe(200);
        expect(acceptRes.json().status).toBe('ACCEPTED');

        // 5. Travel (ACCEPTED -> EN_ROUTE)
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/travel`,
            headers: { 'x-user-id': provider_uid, 'x-role': 'provider' },
        });

        // 6. Arrived (EN_ROUTE -> ARRIVED)
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/arrived`,
            headers: { 'x-user-id': provider_uid, 'x-role': 'provider' },
        });

        // 7. Start (ARRIVED -> IN_PROGRESS) - Must fetch OTP first
        const bookingRes = await app.inject({
            method: 'GET',
            url: `/v1/bookings/${id}`,
            headers: { 'x-user-id': customer_uid, 'x-role': 'user' }
        });
        const otp = bookingRes.json().otp;

        const startRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/start`,
            headers: { 'x-user-id': provider_uid, 'x-role': 'provider' },
            payload: { otp }
        });
        expect(startRes.statusCode).toBe(200);
        expect(startRes.json().status).toBe('IN_PROGRESS');

        // 8. Complete (IN_PROGRESS -> COMPLETE_PENDING)
        const completeRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/complete`,
            headers: { 'x-user-id': provider_uid, 'x-role': 'provider' },
        });
        expect(completeRes.statusCode).toBe(200);
        expect(completeRes.json().status).toBe('COMPLETE_PENDING');
    });
});
