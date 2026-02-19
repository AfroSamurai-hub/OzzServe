import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('PR 6 Lifecycle Finality: EXPIRED & CANCELLED', () => {
    let app: FastifyInstance;

    const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440001';
    const PROVIDER_ID = '550e8400-e29b-41d4-a716-446655440002';
    const ADMIN_ID = '550e8400-e29b-41d4-a716-446655448888';
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

    test('TTL Sweep: stale PENDING_PAYMENT becomes EXPIRED', async () => {
        // 1. Create booking
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = res.json().id;

        // 2. Backdate it manually
        await query("UPDATE bookings SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [id]);

        // 3. Trigger sweep
        const sweepRes = await app.inject({
            method: 'POST',
            url: '/v1/admin/sweep',
            headers: { 'x-user-id': ADMIN_ID, 'x-role': 'admin' }
        });
        expect(sweepRes.json().swept).toBe(1);

        // 4. Verify status
        const bookingRes = await query('SELECT status FROM bookings WHERE id = $1', [id]);
        expect(bookingRes.rows[0].status).toBe('EXPIRED');
    });

    test('Cancel before EN_ROUTE: No fee charged', async () => {
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = createRes.json().id;

        // Move to PAID_SEARCHING (Mock webhook)
        await query("UPDATE bookings SET status = 'PAID_SEARCHING' WHERE id = $1", [id]);
        await query("INSERT INTO payment_intents (booking_id, amount_cents, status, provider, provider_ref) VALUES ($1, 10000, 'AUTHORIZED', 'STRIPE', 'pi_123')", [id]);

        // Cancel
        const cancelRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/cancel`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(cancelRes.statusCode).toBe(200);

        // Verify: Status is CANCELLED, Authorization is CANCELLED, No fee record
        const b = await query('SELECT status FROM bookings WHERE id = $1', [id]);
        expect(b.rows[0].status).toBe('CANCELLED');

        const p = await query('SELECT status, amount_cents FROM payment_intents WHERE booking_id = $1', [id]);
        expect(p.rows).toHaveLength(1);
        expect(p.rows[0].status).toBe('CANCELLED');
        expect(p.rows[0].amount_cents).toBe(10000);
    });

    test('Cancel after EN_ROUTE: R10 fee charged', async () => {
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = createRes.json().id;

        // Move to EN_ROUTE
        await query("UPDATE bookings SET status = 'EN_ROUTE', provider_id = $1 WHERE id = $2", [PROVIDER_ID, id]);
        await query("INSERT INTO payment_intents (booking_id, amount_cents, status, provider, provider_ref) VALUES ($1, 10000, 'AUTHORIZED', 'STRIPE', 'pi_123')", [id]);

        // Cancel
        const cancelRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/cancel`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(cancelRes.statusCode).toBe(200);

        // Verify: Status is CANCELLED, Original Auth is CANCELLED, Fee record exists and is SUCCEEDED
        const b = await query('SELECT status FROM bookings WHERE id = $1', [id]);
        expect(b.rows[0].status).toBe('CANCELLED');

        const p = await query('SELECT status, amount_cents, provider_ref FROM payment_intents WHERE booking_id = $1 ORDER BY created_at ASC', [id]);
        expect(p.rows).toHaveLength(2);

        // Original Auth
        expect(p.rows[0].status).toBe('CANCELLED');
        expect(p.rows[0].amount_cents).toBe(10000);

        // Fee
        expect(p.rows[1].status).toBe('SUCCEEDED');
        expect(p.rows[1].amount_cents).toBe(1000); // R10
        expect(p.rows[1].provider_ref).toContain('pi_fee_');
    });
});
