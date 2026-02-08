import Fastify, { FastifyInstance } from 'fastify';
import { createBooking, getBooking, updateBookingStatus, getUserBookings, getProviderBookings } from './logic/bookings.js';
import { closePool } from './db.js';
import { UserRole } from './logic/state-machine.js';
import { upsertProvider, updateLocation, getOffers } from './logic/providers.js';
import { createIntent, handleIntentSuccess } from './logic/payments.js';
import { processEvent } from './logic/idempotency.js';
import { verifyToken, requireRole } from './auth.js';
import crypto from 'crypto';

/**
 * Centrally managed Fastify instance builder.
 * Used for both production server and test injection.
 */
export async function buildServer(): Promise<FastifyInstance> {
    const server = Fastify({
        logger: true,
    });

    // Graceful shutdown
    server.addHook('onClose', async () => {
        await closePool();
    });

    // Health check endpoint
    server.get('/v1/health', async () => {
        return { ok: true };
    });

    // Role mapping helper
    const mapRole = (role: 'user' | 'provider' | 'admin'): UserRole => {
        if (role === 'user') return 'User';
        if (role === 'provider') return 'Provider';
        return 'Admin';
    };

    // Global Auth Hook (except health and webhooks)
    server.addHook('preValidation', async (request, reply) => {
        // Fastify request.url includes query params, but routerPath is the route pattern.
        // If routerPath is not in types, we check the start of url.
        if (request.url.includes('/v1/health') || request.url.includes('/v1/webhooks')) {
            return;
        }
        await verifyToken(request, reply);
    });

    // Register fastify-raw-body early
    await server.register(import('fastify-raw-body'), {
        field: 'rawBody',
        global: false, // We only want it for webhooks
        encoding: false, // Keep as Buffer
        runFirst: true,
    });

    // --- Provider Endpoints ---

    // POST /v1/providers/me - Onboard/Update
    server.post('/v1/providers/me', {
        preHandler: [requireRole(['provider'])],
        schema: {
            body: {
                type: 'object',
                required: ['display_name', 'is_online', 'services'],
                properties: {
                    display_name: { type: 'string' },
                    is_online: { type: 'boolean' },
                    services: { type: 'array', items: { type: 'string', format: 'uuid' } },
                },
            },
        },
    }, async (request, reply) => {
        const { uid, role } = request.user!;
        if (role !== 'provider') {
            return reply.code(403).send({ error: 'Only providers can manage profiles' });
        }
        await upsertProvider(uid, request.body as any);
        return { ok: true };
    });

    // POST /v1/providers/me/location - Update location
    server.post('/v1/providers/me/location', {
        preHandler: [requireRole(['provider'])],
        schema: {
            body: {
                type: 'object',
                required: ['lat', 'lng'],
                properties: {
                    lat: { type: 'number' },
                    lng: { type: 'number' },
                },
            },
        },
    }, async (request, reply) => {
        const { uid, role } = request.user!;
        if (role !== 'provider') {
            return reply.code(403).send({ error: 'Only providers can update location' });
        }
        const { lat, lng } = request.body as { lat: number; lng: number };
        await updateLocation(uid, lat, lng);
        return { ok: true };
    });

    // GET /v1/providers/me/offers - List suitable jobs
    server.get('/v1/providers/me/offers', {
        preHandler: [requireRole(['provider'])],
    }, async (request, reply) => {
        const { uid, role } = request.user!;
        if (role !== 'provider') {
            return reply.code(403).send({ error: 'Only providers can view offers' });
        }
        const offers = await getOffers(uid);
        return offers;
    });

    // --- Booking Endpoints ---

    // POST /v1/bookings - Align with API_CONTRACTS.md
    server.post('/v1/bookings', {
        preHandler: [requireRole(['user'])],
        schema: {
            body: {
                type: 'object',
                required: ['service_id', 'slot_id', 'user_id'],
                properties: {
                    service_id: { type: 'string', format: 'uuid' },
                    slot_id: { type: 'string', format: 'uuid' },
                    user_id: { type: 'string', format: 'uuid' },
                },
            },
        },
    }, async (request, reply) => {
        const body = request.body as { service_id: string; slot_id: string; user_id: string };
        const { uid, role } = request.user!;

        // Rule: Only customers can create bookings for themselves
        if (role !== 'user' || body.user_id !== uid) {
            return reply.code(403).send({ error: 'Unauthorized to create booking for this user' });
        }

        const booking = await createBooking(body);
        return reply.code(201).send(booking);
    });

    // --- Booking Lifecycle Endpoints ---

    // POST /v1/bookings/:id/accept - Provider claims the paid job
    server.post('/v1/bookings/:id/accept', {
        preHandler: [requireRole(['provider'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;
        const result = await updateBookingStatus(id, 'IN_PROGRESS', mapRole(role), uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'IN_PROGRESS' };
    });

    // POST /v1/bookings/:id/start - Provider begins service
    server.post('/v1/bookings/:id/start', {
        preHandler: [requireRole(['provider'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;
        const result = await updateBookingStatus(id, 'IN_PROGRESS', mapRole(role), uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'IN_PROGRESS' };
    });

    // POST /v1/bookings/:id/complete - Provider finishes service
    server.post('/v1/bookings/:id/complete', {
        preHandler: [requireRole(['provider'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;
        const result = await updateBookingStatus(id, 'CLOSED', mapRole(role), uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'CLOSED' };
    });

    // POST /v1/bookings/:id/close - Alias for complete or admin closure
    server.post('/v1/bookings/:id/close', {
        preHandler: [requireRole(['provider', 'admin'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;
        const result = await updateBookingStatus(id, 'CLOSED', mapRole(role), uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'CLOSED' };
    });

    // --- Payment Endpoints ---

    // GET /v1/bookings - Customer history
    server.get('/v1/bookings', {
        preHandler: [requireRole(['user'])],
    }, async (request, reply) => {
        const { uid } = request.user!;
        const { status, limit, offset } = request.query as { status?: string, limit?: string, offset?: string };
        const bookings = await getUserBookings(uid, {
            status,
            limit: limit ? parseInt(limit) : 20,
            offset: offset ? parseInt(offset) : 0
        });
        return bookings;
    });

    // GET /v1/bookings/claimed - Provider history
    server.get('/v1/bookings/claimed', {
        preHandler: [requireRole(['provider'])],
    }, async (request, reply) => {
        const { uid } = request.user!;
        const { status, limit, offset } = request.query as { status?: string, limit?: string, offset?: string };
        const bookings = await getProviderBookings(uid, {
            status,
            limit: limit ? parseInt(limit) : 20,
            offset: offset ? parseInt(offset) : 0
        });
        return bookings;
    });

    // --- Payment Endpoints ---

    // POST /v1/bookings/:id/pay - Create intention to pay
    server.post('/v1/bookings/:id/pay', {
        preHandler: [requireRole(['user', 'admin'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;

        const booking = await getBooking(id);
        if (!booking) return reply.code(404).send({ error: 'Booking not found' });

        // Ownership check
        if (booking.customer_id !== uid && role !== 'admin') {
            return reply.code(403).send({ error: 'Unauthorized' });
        }

        const intent = await createIntent(id);
        return {
            payment_intent_id: intent.id,
            status: intent.status,
            amount: intent.amount_cents,
            currency: intent.currency
        };
    });

    // POST /v1/webhooks/:provider - Idempotent webhook handler
    server.post('/v1/webhooks/:provider', {
        config: {
            rawBody: true
        }
    }, async (request, reply) => {
        const { provider } = request.params as { provider: string };
        const signature = request.headers['x-signature'] as string;
        const body = request.body as any;
        const isProd = process.env.NODE_ENV === 'production';

        // MVP Signature Verification
        const verifySignature = (sig: string, payload: any, rawPayload?: Buffer): boolean => {
            const secret = process.env.STRIPE_WEBHOOK_SECRET;
            if (!secret) {
                if (isProd) {
                    server.log.error('STRIPE_WEBHOOK_SECRET not set in production');
                    return false;
                }
                return sig === 'valid_secret'; // Mock for dev
            }

            if (!rawPayload) {
                server.log.error('Raw payload missing for signature verification');
                return false;
            }

            // Minimal HMAC verification (Simplified for MVP/Example)
            // In a real app we'd use stripe.webhooks.constructEvent
            try {
                const expected = crypto.createHmac('sha256', secret)
                    .update(rawPayload)
                    .digest('hex');
                return sig === expected;
            } catch (e) {
                return false;
            }
        };

        if (!verifySignature(signature, body, request.rawBody as Buffer)) {
            return reply.code(401).send({ error: 'Invalid signature', code: 'WEBHOOK_INVALID_SIG' });
        }

        const eventId = body.id; // Generic 'id' for MVP

        if (!eventId) {
            return reply.code(400).send({ error: 'Missing event ID' });
        }

        try {
            const status = await processEvent(provider, eventId, async () => {
                // Side-effect: Handle different event types
                if (body.type === 'payment_intent.succeeded') {
                    const providerRef = body.data?.object?.id || body.reference;
                    await handleIntentSuccess(provider.toUpperCase(), providerRef);
                }
            });

            return { status };
        } catch (error) {
            server.log.error(error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    return server;
}
