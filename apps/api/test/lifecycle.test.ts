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

        // Pay via webhook
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

    test('Happy Path: PAID -> accept -> complete', async () => {
        const id = await createAndPay();

        // Accept
        const acceptRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(acceptRes.statusCode).toBe(200);
        expect(acceptRes.json().status).toBe('IN_PROGRESS');

        // Complete
        const completeRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(completeRes.statusCode).toBe(200);
        expect(completeRes.json().status).toBe('CLOSED');
    });

    test('Illegal Transition: Cannot start before payment', async () => {
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
        expect(startRes.statusCode).toBe(400);
        expect(startRes.json().error).toContain('Invalid transition');
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

        // Provider 1 accepts
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });

        // Provider 2 tries to complete
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
