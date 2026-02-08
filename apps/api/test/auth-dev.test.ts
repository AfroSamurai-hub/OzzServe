import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';

describe('Dev-Only Auth Middleware', () => {
    let app: FastifyInstance;

    const VALID_SERVICE_ID = '550e8400-e29b-41d4-a716-446655440001';
    const VALID_SLOT_ID = '550e8400-e29b-41d4-a716-446655440002';
    const VALID_USER_ID = '550e8400-e29b-41d4-a716-446655440003';

    beforeAll(async () => {
        app = await buildServer();
    });

    afterAll(async () => {
        await app.close();
    });

    test('GET /v1/health should bypass auth', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/health',
        });
        expect(res.statusCode).toBe(200);
    });

    test('POST /v1/bookings without headers should return 401', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            payload: {
                service_id: VALID_SERVICE_ID,
                slot_id: VALID_SLOT_ID,
                user_id: VALID_USER_ID
            }
        });
        expect(res.statusCode).toBe(401);
    });

    test('POST /v1/bookings with correct user role should succeed (201)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: {
                'x-user-id': VALID_USER_ID,
                'x-role': 'user'
            },
            payload: {
                service_id: VALID_SERVICE_ID,
                slot_id: VALID_SLOT_ID,
                user_id: VALID_USER_ID
            }
        });
        expect(res.statusCode).toBe(201);
    });

    test('POST /v1/bookings with wrong role (provider) should return 403', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: {
                'x-user-id': 'test-provider',
                'x-role': 'provider'
            },
            payload: {
                service_id: VALID_SERVICE_ID,
                slot_id: VALID_SLOT_ID,
                user_id: VALID_USER_ID
            }
        });
        expect(res.statusCode).toBe(403);
    });

    test('POST /v1/providers/me with provider role should succeed (auth-wise)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/providers/me',
            headers: {
                'x-user-id': 'test-provider',
                'x-role': 'provider'
            },
            payload: {
                display_name: 'Test Provider',
                is_online: true,
                services: [VALID_SERVICE_ID]
            }
        });
        // 200 OK
        expect(res.statusCode).toBe(200);
    });
});
