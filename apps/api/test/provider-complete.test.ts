import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('Provider-Complete + Capture-on-Confirm Flow', () => {
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

        // Setup provider
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Provider 1', is_online: true, services: [SERVICE_ID] }
        });
    });

    /**
     * Helper: advance booking to IN_PROGRESS (ready for provider-complete)
     */
    async function advanceToInProgress(): Promise<string> {
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = createRes.json().id;

        // Pay + webhook
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

        // Accept → Travel → Arrive → Start (OTP)
        await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/accept`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });
        await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/travel`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });
        await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/arrived`, headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' } });

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

        return bookingId;
    }

    test('provider-complete: IN_PROGRESS → COMPLETE_PENDING with NO capture', async () => {
        const bookingId = await advanceToInProgress();

        // Provider marks complete via new endpoint
        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/provider-complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe('COMPLETE_PENDING');

        // Verify booking is COMPLETE_PENDING
        const bookingCheck = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
        expect(bookingCheck.rows[0].status).toBe('COMPLETE_PENDING');

        // CRITICAL: Verify payment intent is still AUTHORIZED (NOT captured)
        const piCheck = await query('SELECT status FROM payment_intents WHERE booking_id = $1', [bookingId]);
        expect(piCheck.rows[0].status).toBe('AUTHORIZED');
    });

    test('confirm-complete: captures payment then transitions to CLOSED', async () => {
        const bookingId = await advanceToInProgress();

        // Provider completes (no capture)
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/provider-complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });

        // Customer confirms → should capture + close
        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/confirm-complete`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe('CLOSED');

        // Verify booking is CLOSED
        const bookingCheck = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
        expect(bookingCheck.rows[0].status).toBe('CLOSED');

        // Verify payment intent is now SUCCEEDED (captured)
        const piCheck = await query('SELECT status FROM payment_intents WHERE booking_id = $1', [bookingId]);
        expect(piCheck.rows[0].status).toBe('SUCCEEDED');
    });

    test('confirm-complete idempotent: second call returns 200 without second capture', async () => {
        const bookingId = await advanceToInProgress();

        // Provider completes → Customer confirms
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/provider-complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/confirm-complete`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });

        // Second call — idempotent
        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/confirm-complete`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().already_closed).toBe(true);
        expect(res.json().status).toBe('CLOSED');
    });

    test('provider-complete guard: wrong state returns 400', async () => {
        // Create booking but leave in PENDING_PAYMENT
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = createRes.json().id;

        // Assign provider manually so auth passes
        await query('UPDATE bookings SET provider_id = $1 WHERE id = $2', [PROVIDER_ID, bookingId]);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/provider-complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('IN_PROGRESS');
    });
});
