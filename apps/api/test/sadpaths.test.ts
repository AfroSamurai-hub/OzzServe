import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('PR 7 Sad Paths', () => {
    let app: FastifyInstance;

    const CUSTOMER_ID = '550e8400-e29b-41d4-a716-446655440001';
    const PROVIDER_ID = '550e8400-e29b-41d4-a716-446655440002';
    const OTHER_PROVIDER_ID = '550e8400-e29b-41d4-a716-446655449999';
    const SERVICE_ID = '550e8400-e29b-41d4-a716-446655440004';
    const SLOT_ID = '550e8400-e29b-41d4-a716-446655440005';

    beforeAll(async () => {
        app = await buildServer();
    });

    afterAll(async () => {
        if (app) await app.close();
    });

    beforeEach(async () => {
        await query('TRUNCATE providers, provider_services, bookings, booking_events, payment_intents, webhook_events, notification_outbox RESTART IDENTITY CASCADE');

        // Setup: Providers
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Pro 1', is_online: true, services: [SERVICE_ID] }
        });
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': OTHER_PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Pro 2', is_online: true, services: [SERVICE_ID] }
        });
    });

    test('Payment Failure: Does not advance state', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const bookingId = res.json().id;

        // Simulate payment failure webhook
        const webhookRes = await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            headers: { 'x-signature': 'valid_secret' },
            payload: {
                id: 'evt_fail_123',
                type: 'payment_intent.payment_failed',
                data: {
                    object: {
                        id: 'pi_fail_123',
                        metadata: { booking_id: bookingId }
                    }
                }
            }
        });
        expect(webhookRes.statusCode).toBe(200);

        // Verify status remains PENDING_PAYMENT
        const getRes = await app.inject({
            method: 'GET',
            url: `/v1/bookings/${bookingId}`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' }
        });
        expect(getRes.json().status).toBe('PENDING_PAYMENT');
    });

    test('Provider Cancel: Re-dispatches to PAID_SEARCHING', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = res.json().id;

        // Move to ACCEPTED
        await query("UPDATE bookings SET status = 'ACCEPTED', provider_id = $1 WHERE id = $2", [PROVIDER_ID, id]);

        // Provider cancels
        const cancelRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/provider_cancel`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(cancelRes.statusCode).toBe(200);

        // Verify: Status is PAID_SEARCHING, provider_id is NULL
        const b = await query('SELECT status, provider_id FROM bookings WHERE id = $1', [id]);
        expect(b.rows[0].status).toBe('PAID_SEARCHING');
        expect(b.rows[0].provider_id).toBeNull();

        // Verify notification
        const n = await query('SELECT * FROM notification_outbox WHERE booking_id = $1', [id]);
        expect(n.rows).toHaveLength(1);
        expect(n.rows[0].type).toBe('PROVIDER_CANCELLED');
    });

    test('Provider Cancel: Rejected if not assigned provider', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = res.json().id;
        await query("UPDATE bookings SET status = 'ACCEPTED', provider_id = $1 WHERE id = $2", [PROVIDER_ID, id]);

        const cancelRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/provider_cancel`,
            headers: { 'x-user-id': OTHER_PROVIDER_ID, 'x-role': 'provider' }
        });
        expect(cancelRes.statusCode).toBe(400); // Because logic returns {ok:false} which app map to 400
    });

    test('Issue Flag: Succeeds within 30m window', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = res.json().id;

        // Move to COMPLETE_PENDING (updated_at will be NOW)
        // Note: we need to use updateBookingStatus to set complete_pending_until
        await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' },
            payload: { display_name: 'Pro', is_online: true, services: [SERVICE_ID] }
        });
        await query("UPDATE bookings SET status = 'ARRIVED', provider_id = $1 WHERE id = $2", [PROVIDER_ID, id]);

        // Mock payment authorization
        await query(`INSERT INTO payment_intents (booking_id, amount_cents, status, provider) VALUES ($1, 100, 'AUTHORIZED', 'STRIPE')`, [id]);

        // Transition to IN_PROGRESS (mock OTP bypass for test speed)
        await query("UPDATE bookings SET status = 'IN_PROGRESS' WHERE id = $1", [id]);

        // Complete service
        await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });

        // Flag issue
        const issueRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/issue`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { reason: 'Service was incomplete' }
        });
        expect(issueRes.statusCode).toBe(200);

        const b = await query('SELECT status FROM bookings WHERE id = $1', [id]);
        expect(b.rows[0].status).toBe('NEEDS_REVIEW');
    });

    test('Issue Flag: Rejects after 30m window', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = res.json().id;

        await query(`UPDATE bookings SET status = 'COMPLETE_PENDING', customer_id = $1, complete_pending_until = NOW() - INTERVAL '1 minute' WHERE id = $2`, [CUSTOMER_ID, id]);

        const issueRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/issue`,
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { reason: 'Too late now' }
        });
        expect(issueRes.statusCode).toBe(400);
        expect(issueRes.json().error).toContain('closed');
    });

    test('Atomic Completion: Fails (409) if capture fails (status remains IN_PROGRESS)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = res.json().id;

        // Move directly to IN_PROGRESS without payment authorized
        await query(`UPDATE bookings SET status = 'IN_PROGRESS', provider_id = $1 WHERE id = $2`, [PROVIDER_ID, id]);

        const compRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });

        expect(compRes.statusCode).toBe(409);
        expect(compRes.json().code).toBe('CAPTURE_FAILED');

        const b = await query('SELECT status FROM bookings WHERE id = $1', [id]);
        expect(b.rows[0].status).toBe('IN_PROGRESS');
    });

    test('Atomic Completion: Succeeds (200) if capture succeeds', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': CUSTOMER_ID, 'x-role': 'user' },
            payload: { service_id: SERVICE_ID, slot_id: SLOT_ID, user_id: CUSTOMER_ID }
        });
        const id = res.json().id;

        // Mock authorized payment intent
        await query(`INSERT INTO payment_intents (booking_id, amount_cents, status, provider) VALUES ($1, 100, 'AUTHORIZED', 'STRIPE')`, [id]);
        await query(`UPDATE bookings SET status = 'IN_PROGRESS', provider_id = $1 WHERE id = $2`, [PROVIDER_ID, id]);

        const compRes = await app.inject({
            method: 'POST',
            url: `/v1/bookings/${id}/complete`,
            headers: { 'x-user-id': PROVIDER_ID, 'x-role': 'provider' }
        });

        expect(compRes.statusCode).toBe(200);
        const b = await query('SELECT status FROM bookings WHERE id = $1', [id]);
        expect(b.rows[0].status).toBe('COMPLETE_PENDING');
    });
});
