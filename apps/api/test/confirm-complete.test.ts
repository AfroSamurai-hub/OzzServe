import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('POST /v1/bookings/:id/confirm-complete', () => {
    let app: FastifyInstance;

    const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440001';
    const PROVIDER_ID = '550e8400-e29b-41d4-a716-446655440002';
    const OTHER_CUSTOMER = '550e8400-e29b-41d4-a716-446655440009';
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

        // Setup provider
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Provider 1', is_online: true, services: [SERVICE_ID] }
        });
    });

    /**
     * Helper: Create booking, pay, accept, travel, arrive, start (OTP), provider-complete → COMPLETE_PENDING
     * Uses /provider-complete (no capture) so confirm-complete can capture.
     */
    async function createCompletePendingBooking(): Promise<string> {
        // Create
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = createRes.json().id;

        // Pay (via webhook)
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

        // Accept → Travel → Arrive
        await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/accept`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });
        await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/travel`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });
        await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/arrived`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });

        // Start (need OTP)
        const bookingRes = await app.inject({
            method: 'GET',
            url: `/v1/bookings/${bookingId}`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        const otp = bookingRes.json().otp;
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/start`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { otp }
        });

        // Provider-complete (IN_PROGRESS → COMPLETE_PENDING, NO capture)
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/provider-complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });

        return bookingId;
    }

    test('Happy path: customer confirms → booking transitions to CLOSED', async () => {
        const bookingId = await createCompletePendingBooking();

        // Verify it's COMPLETE_PENDING first
        const check = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
        expect(check.rows[0].status).toBe('COMPLETE_PENDING');

        // Confirm
        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/confirm-complete`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe('CLOSED');

        // Verify DB
        const dbRes = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
        expect(dbRes.rows[0].status).toBe('CLOSED');
    });

    test('Guard: booking not in COMPLETE_PENDING returns 400', async () => {
        // Create booking but don't advance it past PENDING_PAYMENT
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = createRes.json().id;

        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/confirm-complete`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('COMPLETE_PENDING');
    });

    test('Auth guard: non-owner customer cannot confirm', async () => {
        const bookingId = await createCompletePendingBooking();

        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/confirm-complete`,
            headers: { 'x-user-id': OTHER_CUSTOMER, 'x-role': 'user' }
        });
        expect(res.statusCode).toBe(403);
    });

    test('Auth guard: provider cannot use confirm-complete', async () => {
        const bookingId = await createCompletePendingBooking();

        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/confirm-complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(res.statusCode).toBe(403);
    });
});
