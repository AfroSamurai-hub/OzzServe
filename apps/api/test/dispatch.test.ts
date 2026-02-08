import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('Provider Dispatch & Matching', () => {
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
    const PROVIDER_UID = '550e8400-e29b-41d4-a716-446655440004';

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

    test('Happy Path: Online provider is dispatched as candidate', async () => {
        // 1. Onboard provider and go online
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_UID, 'x-role': 'provider' },
            payload: {
                display_name: 'Fast Plumber',
                is_online: true,
                services: [SERVICE_ID],
            },
        });

        // 2. Create booking
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_UID, 'x-role': 'user' },
            payload: {
                service_id: SERVICE_ID,
                slot_id: SLOT_ID,
                user_id: CUSTOMER_UID,
            },
        });
        expect(createRes.statusCode).toBe(201);
        const booking = createRes.json();
        expect(booking.candidate_list).toContain(PROVIDER_UID);

        // 3. Provider can see offer (paid only)
        await mockPay(booking.id);

        const offersRes = await app.inject({
            method: 'GET',
            url: '/v1/providers/me/offers',
            headers: { 'x-user-id': PROVIDER_UID, 'x-role': 'provider' },
        });
        expect(offersRes.statusCode).toBe(200);
        expect(offersRes.json().length).toBe(1);

        // 4. Provider accepts
        const acceptRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${booking.id}/accept`,
            headers: { 'x-user-id': PROVIDER_UID, 'x-role': 'provider' },
        });
        expect(acceptRes.statusCode).toBe(200);
    });

    test('Provider who is not a candidate cannot accept', async () => {
        const PROVIDER_UID_2 = '550e8400-e29b-41d4-a716-446655440005';

        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_UID, 'x-role': 'provider' },
            payload: { display_name: 'P1', is_online: true, services: [SERVICE_ID] },
        });

        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_UID_2, 'x-role': 'provider' },
            payload: { display_name: 'P2', is_online: true, services: [] },
        });

        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_UID, 'x-role': 'user' },
            payload: {
                service_id: SERVICE_ID,
                slot_id: SLOT_ID,
                user_id: CUSTOMER_UID,
            },
        });
        const { id } = createRes.json();
        await mockPay(id);

        const acceptRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/accept`,
            headers: { 'x-user-id': PROVIDER_UID_2, 'x-role': 'provider' },
        });
        expect(acceptRes.statusCode).toBe(400);
        expect(acceptRes.json().error).toContain('not in the candidate list');
    });

    test('Offline provider is not dispatched', async () => {
        const PROVIDER_OFFLINE = '550e8400-e29b-41d4-a716-446655440006';

        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_OFFLINE, 'x-role': 'provider' },
            payload: { display_name: 'Offline', is_online: false, services: [SERVICE_ID] },
        });

        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_UID, 'x-role': 'user' },
            payload: {
                service_id: SERVICE_ID,
                slot_id: SLOT_ID,
                user_id: CUSTOMER_UID,
            },
        });
        expect(createRes.statusCode).toBe(201);
        const body = createRes.json();
        expect(body.candidate_list).not.toContain(PROVIDER_OFFLINE);
    });
});
