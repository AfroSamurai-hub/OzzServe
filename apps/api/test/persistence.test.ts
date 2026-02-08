import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { query } from '../src/db.js';

describe('Persistence Verification', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
        await query('TRUNCATE bookings, booking_events RESTART IDENTITY CASCADE');
    });

    test('should survive service restart', async () => {
        const uid = '550e8400-e29b-41d4-a716-446655443333';
        // 1. Start app and create booking
        app = await buildServer();
        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': uid, 'x-role': 'user' },
            payload: {
                service_id: '550e8400-e29b-41d4-a716-446655441111',
                slot_id: '550e8400-e29b-41d4-a716-446655442222',
                user_id: uid,
            },
        });
        const { id } = createRes.json();

        // 2. Shut down app (closes pool)
        await app.close();

        // 3. Start fresh app instance (new pool)
        const app2 = await buildServer();
        const getRes = await app2.inject({
            method: 'GET',
            url: `/v1/health`, // Just to wake it up
        });

        const dbRes = await query('SELECT * FROM bookings WHERE id = $1', [id]);
        expect(dbRes.rowCount).toBe(1);
        expect(dbRes.rows[0].id).toBe(id);

        await app2.close();
    });
});
