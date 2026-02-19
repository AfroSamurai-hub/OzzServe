import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('PR 5.1 Hygiene: OTP Exposure & Migrations', () => {
    let app: FastifyInstance;

    const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440001';
    const PROVIDER_ID = '550e8400-e29b-41d4-a716-446655440002';
    const OTHER_USER_ID = '550e8400-e29b-41d4-a716-446655449999';
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

        // Setup: One provider
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Pro', is_online: true, services: [SERVICE_ID] }
        });
    });

    test('Customer owner can see their own OTP', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = res.json().id;

        const getRes = await app.inject({
            method: 'GET',
            url: `/v1/bookings/${bookingId}`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(getRes.statusCode).toBe(200);
        expect(getRes.json()).toHaveProperty('otp');
        expect(getRes.json().otp).toMatch(/^\d{4}$/);
    });

    test('Assigned provider CANNOT see customer OTP', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = res.json().id;

        // Manually assign provider (to bypass full pay/accept cycle for hygiene test speed)
        await query('UPDATE bookings SET provider_id = $1 WHERE id = $2', [PROVIDER_ID, bookingId]);

        const getRes = await app.inject({
            method: 'GET',
            url: `/v1/bookings/${bookingId}`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(getRes.statusCode).toBe(200);
        expect(getRes.json().id).toBe(bookingId);
        expect(getRes.json()).not.toHaveProperty('otp');
    });

    test('Unauthorized user gets 403 trying to view booking', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = res.json().id;

        const getRes = await app.inject({
            method: 'GET',
            url: `/v1/bookings/${bookingId}`,
            headers: { 'x-user-id': OTHER_USER_ID, 'x-role': 'user' }
        });
        expect(getRes.statusCode).toBe(403);
    });
});
