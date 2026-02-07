import { describe, test, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/app.js';
import { FastifyInstance } from 'fastify';

describe('API Integration: Health Check', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildServer();
    });

    test('GET /v1/health should return ok: true', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/v1/health',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
    });
});
