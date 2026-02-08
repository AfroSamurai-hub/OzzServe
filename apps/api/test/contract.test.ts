import { describe, test, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';

describe('API Contract Enforcement: POST /v1/bookings', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildServer();
    });

    test('valid payload returns 201 (Created) + matches API_CONTRACTS.md shape', async () => {
        const uid = '550e8400-e29b-41d4-a716-446655440003';
        const payload = {
            service_id: '550e8400-e29b-41d4-a716-446655440001',
            slot_id: '550e8400-e29b-41d4-a716-446655440002',
            user_id: uid,
        };

        const response = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': uid, 'x-role': 'user' },
            payload,
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();

        // Exact field match as per API_CONTRACTS.md
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('status', 'PENDING');
        expect(body).toHaveProperty('expires_at');
        expect(typeof body.id).toBe('string');
        expect(typeof body.expires_at).toBe('string');
    });

    test('invalid payload (missing slot_id) returns 400 (Bad Request)', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': 'any', 'x-role': 'user' },
            payload: {
                service_id: '550e8400-e29b-41d4-a716-446655440001',
                user_id: '550e8400-e29b-41d4-a716-446655440003',
            },
        });

        expect(response.statusCode).toBe(400);
    });

    test('invalid payload (bad uuid format) returns 400 (Bad Request)', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': 'any', 'x-role': 'user' },
            payload: {
                service_id: 'not-a-uuid',
                slot_id: '550e8400-e29b-41d4-a716-446655440002',
                user_id: '550e8400-e29b-41d4-a716-446655440003',
            },
        });

        expect(response.statusCode).toBe(400);
    });

    test('extra fields are ignored by default (standard Fastify behavior)', async () => {
        const uid = '550e8400-e29b-41d4-a716-446655440003';
        const response = await app.inject({
            method: 'POST',
            url: '/v1/bookings',
            headers: { 'x-user-id': uid, 'x-role': 'user' },
            payload: {
                service_id: '550e8400-e29b-41d4-a716-446655440001',
                slot_id: '550e8400-e29b-41d4-a716-446655440002',
                user_id: uid,
                unknown_field: 'should-be-fine',
            },
        });

        expect(response.statusCode).toBe(201);
    });
});
