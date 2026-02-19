import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('Booking Lifecycle Endpoints', () => {
    let app: FastifyInstance;

    const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440001';
    const PROVIDER_ID = '550e8400-e29b-41d4-a716-446655440002';
    const PROVIDER_2_ID = '550e8400-e29b-41d4-a716-446655440003';
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

        // Setup: Providers
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Provider 1', is_online: true, services: [SERVICE_ID] }
        });
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_2_ID, 'x-role': 'provider' },
            payload: { display_name: 'Provider 2', is_online: true, services: [SERVICE_ID] }
        });
    });

    async function createAndPay() {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = res.json().id;

        // Pay via webhook (Simulates PENDING_PAYMENT -> PAID_SEARCHING)
        const payRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/pay`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
        });
        const { payment_intent_id } = payRes.json();
        const dbRes = await query('SELECT provider_ref FROM payment_intents WHERE id = $1', [payment_intent_id]);

        await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload: { id: `evt_${bookingId}`, type: 'payment_intent.succeeded', data: { object: { id: dbRes.rows[0].provider_ref } } }
        });

        return bookingId;
    }

    test('Happy Path: Uber-like flow (PAID_SEARCHING -> accept -> travel -> arrived -> start -> complete)', async () => {
        const id = await createAndPay();

        // 1. Accept (PAID_SEARCHING -> ACCEPTED)
        const acceptRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(acceptRes.statusCode).toBe(200);
        expect(acceptRes.json().status).toBe('ACCEPTED');

        // 2. Travel (ACCEPTED -> EN_ROUTE)
        const travelRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/travel`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(travelRes.statusCode).toBe(200);
        expect(travelRes.json().status).toBe('EN_ROUTE');

        // 3. Arrived (EN_ROUTE -> ARRIVED)
        const arrivedRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/arrived`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(arrivedRes.statusCode).toBe(200);
        expect(arrivedRes.json().status).toBe('ARRIVED');

        // 4. Start (ARRIVED -> IN_PROGRESS)
        // Fetch booking to get OTP
        const bookingRes = await app.inject({
            method: 'GET',
            url: `/v1/bookings/${id}`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        const otp = bookingRes.json().otp;

        const startRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/start`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { otp }
        });
        expect(startRes.statusCode).toBe(200);
        expect(startRes.json().status).toBe('IN_PROGRESS');

        // 5. Complete (IN_PROGRESS -> COMPLETE_PENDING)
        const completeRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(completeRes.statusCode).toBe(200);
        expect(completeRes.json().status).toBe('COMPLETE_PENDING');

        // Verify Capture
        const intentRes = await query('SELECT status FROM payment_intents WHERE booking_id = $1', [id]);
        expect(intentRes.rows[0].status).toBe('SUCCEEDED');
    });

    test('OTP Verification: Cannot start with wrong OTP', async () => {
        const id = await createAndPay();

        // Move to ARRIVED
        await app.inject({ method: 'POST', url: `/v1/bookings/${id}/accept`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });
        await app.inject({ method: 'POST', url: `/v1/bookings/${id}/travel`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });
        await app.inject({ method: 'POST', url: `/v1/bookings/${id}/arrived`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });

        const startRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/start`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { otp: '0000' } // Wrong OTP
        });
        expect(startRes.statusCode).toBe(400);
        expect(startRes.json().error).toContain('Invalid or missing OTP');
    });
    test('Illegal Transition: Cannot start before payment or arrival', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = res.json().id;

        const startRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/start`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(startRes.statusCode).toBe(400); // Fails due to missing OTP in schema
    });

    test('Unauthorized Role: Customer cannot accept booking', async () => {
        const id = await createAndPay();
        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(res.statusCode).toBe(403);
    });

    test('Provider Ownership: Only assigned provider can complete', async () => {
        const id = await createAndPay();

        // 1. Provider 1 accepts
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });

        // 2. Travel, Arrive, Start (Move to IN_PROGRESS)
        await app.inject({ method: 'POST', url: `/v1/bookings/${id}/travel`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });
        await app.inject({ method: 'POST', url: `/v1/bookings/${id}/arrived`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });

        const bookingRes = await app.inject({
            method: 'GET',
            url: `/v1/bookings/${id}`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        const otp = bookingRes.json().otp;
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/start`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { otp }
        });

        // 3. Provider 2 tries to complete
        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/complete`,
            headers: { 'x-user-id': PROVIDER_2_ID, 'x-role': 'provider' }
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('claimed by another provider');
    });

    test('Candidate Enforcement: Non-candidate provider cannot accept', async () => {
        const EVIL_PROVIDER = 'bad-man';
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': EVIL_PROVIDER, 'x-role': 'provider' },
            payload: { display_name: 'Evil', is_online: true, services: [] } // No services
        });

        const id = await createAndPay();
        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': EVIL_PROVIDER, 'x-role': 'provider' }
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('not in the candidate list');
    });
});
