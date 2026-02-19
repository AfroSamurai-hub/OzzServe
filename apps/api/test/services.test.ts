import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('Services Catalogue + Price Snapshot', () => {
    let app: FastifyInstance;

    const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440001';
    const PROVIDER_ID = '550e8400-e29b-41d4-a716-446655440002';
    // Use a known seeded service ID from migration 003
    const SEEDED_SERVICE_ID = 'a0000000-0000-0000-0000-000000000002'; // Blocked Drain, R450
    const UNKNOWN_SERVICE_ID = '550e8400-e29b-41d4-a716-446655440099';
    const SLOT_ID = '550e8400-e29b-41d4-a716-446655440005';

    beforeAll(async () => {
        app = await buildServer();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await query('TRUNCATE providers, provider_services, bookings, booking_events, payment_intents, webhook_events RESTART IDENTITY CASCADE');
    });

    // --- GET /v1/services ---

    test('GET /v1/services returns 200 with array of active services', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/services',
        });
        expect(res.statusCode).toBe(200);
        const services = res.json();
        expect(Array.isArray(services)).toBe(true);
        expect(services.length).toBe(15); // 15 seeded services
    });

    test('GET /v1/services excludes inactive services', async () => {
        // Deactivate one service
        await query('UPDATE services SET is_active = FALSE WHERE id = $1', [SEEDED_SERVICE_ID]);

        const res = await app.inject({
            method: 'GET',
            url: '/v1/services',
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().length).toBe(14);

        // Restore
        await query('UPDATE services SET is_active = TRUE WHERE id = $1', [SEEDED_SERVICE_ID]);
    });

    test('GET /v1/services does not require authentication', async () => {
        // No auth headers at all
        const res = await app.inject({
            method: 'GET',
            url: '/v1/services',
        });
        expect(res.statusCode).toBe(200);
    });

    test('Each service has expected fields', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/services',
        });
        const service = res.json()[0];
        expect(service).toHaveProperty('id');
        expect(service).toHaveProperty('category');
        expect(service).toHaveProperty('name');
        expect(service).toHaveProperty('price_cents');
        expect(service).toHaveProperty('is_active', true);
    });

    // --- Price Snapshot on Booking ---

    test('Booking creation snapshots service name and price when service exists', async () => {
        // Setup provider for the seeded service
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Pro', is_online: true, services: [SEEDED_SERVICE_ID] }
        });

        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SEEDED_SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        expect(res.statusCode).toBe(201);

        const booking = res.json();
        expect(booking.service_name_snapshot).toBe('Blocked Drain');
        expect(booking.price_snapshot_cents).toBe(45000);
    });

    test('Booking creation with unknown service_id still works (null snapshot)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: UNKNOWN_SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        expect(res.statusCode).toBe(201);

        const booking = res.json();
        expect(booking.service_name_snapshot).toBeNull();
        expect(booking.price_snapshot_cents).toBeNull();
    });

    test('Pay endpoint uses snapshot price for intent amount', async () => {
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Pro', is_online: true, services: [SEEDED_SERVICE_ID] }
        });

        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SEEDED_SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = createRes.json().id;

        const payRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${bookingId}/pay`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
        });
        expect(payRes.statusCode).toBe(200);
        expect(payRes.json().amount).toBe(45000); // R450, not the default R100
    });
});
