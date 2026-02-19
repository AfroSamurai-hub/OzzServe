import Fastify, { FastifyInstance } from 'fastify';
import { createBooking, getBooking, updateBookingStatus, getUserBookings, getProviderBookings, cancelBooking, sweepExpiredBookings, providerCancelBooking, flagIssue, completeBooking } from './logic/bookings.js';
import { closePool, runMigrations } from './db.js';
import { UserRole } from './logic/state-machine.js';
import { upsertProvider, updateLocation, getOffers } from './logic/providers.js';
import { createIntent, handleIntentSuccess, capturePayment } from './logic/payments.js';
import { processEvent } from './logic/idempotency.js';
import { verifyToken, requireRole } from './auth.js';
import { getActiveServices } from './logic/services.js';
import { config } from './config.js';
import { query } from './db.js';
import crypto from 'crypto';
import Stripe from 'stripe';

/**
 * Centrally managed Fastify instance builder.
 * Used for both production server and test injection.
 */
export async function buildServer(): Promise<FastifyInstance> {
    await runMigrations();
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
        if (request.url.includes('/v1/health') || request.url.includes('/v1/webhooks') || request.url.includes('/v1/services')) {
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

    // --- Services Catalogue ---

    // GET /v1/services - Public catalogue (no auth required)
    server.get('/v1/services', async () => {
        const services = await getActiveServices();
        return services;
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
        const result = await updateBookingStatus(id, 'ACCEPTED', mapRole(role), uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'ACCEPTED' };
    });

    // POST /v1/bookings/:id/travel - Provider begins travel
    server.post('/v1/bookings/:id/travel', {
        preHandler: [requireRole(['provider'])],
        schema: {
            params: {
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid' } }
            }
        }
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;
        const result = await updateBookingStatus(id, 'EN_ROUTE', mapRole(role), uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'EN_ROUTE' };
    });

    // POST /v1/bookings/:id/arrived - Provider at location
    server.post('/v1/bookings/:id/arrived', {
        preHandler: [requireRole(['provider'])],
        schema: {
            params: {
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid' } }
            }
        }
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;
        const result = await updateBookingStatus(id, 'ARRIVED', mapRole(role), uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'ARRIVED' };
    });

    // POST /v1/bookings/:id/start - Provider begins service (Requires OTP)
    server.post('/v1/bookings/:id/start', {
        preHandler: [requireRole(['provider'])],
        schema: {
            params: {
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid' } }
            },
            body: {
                type: 'object',
                required: ['otp'],
                properties: {
                    otp: { type: 'string', minLength: 4, maxLength: 4 }
                }
            }
        }
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;
        const { otp } = request.body as { otp: string };

        const result = await updateBookingStatus(id, 'IN_PROGRESS', mapRole(role), uid, otp);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'IN_PROGRESS' };
    });

    // POST /v1/bookings/:id/complete - Provider finishes service
    server.post('/v1/bookings/:id/complete', {
        preHandler: [requireRole(['provider'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid } = request.user!;

        const result = await completeBooking(id, uid);

        if (!result.ok) {
            if (result.code === 'CAPTURE_FAILED') {
                return reply.code(409).send({ error: result.error, code: 'CAPTURE_FAILED' });
            }
            return reply.code(400).send({ error: result.error, code: result.code });
        }

        return { ok: true, status: 'COMPLETE_PENDING' };
    });

    // POST /v1/bookings/:id/cancel - Customer or Provider cancels
    server.post('/v1/bookings/:id/cancel', {
        preHandler: [requireRole(['user', 'provider'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;
        const result = await cancelBooking(id, mapRole(role), uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'CANCELLED' };
    });

    // POST /v1/bookings/:id/provider_cancel - Provider cancels (Re-dispatch)
    server.post('/v1/bookings/:id/provider_cancel', {
        preHandler: [requireRole(['provider'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid } = request.user!;
        const result = await providerCancelBooking(id, uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'PAID_SEARCHING' };
    });

    // POST /v1/bookings/:id/issue - Customer flags an issue
    server.post('/v1/bookings/:id/issue', {
        preHandler: [requireRole(['user'])],
        schema: {
            body: {
                type: 'object',
                required: ['reason'],
                properties: {
                    reason: { type: 'string', minLength: 5 }
                }
            }
        }
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid } = request.user!;
        const { reason } = request.body as { reason: string };
        const result = await flagIssue(id, uid, reason);
        if (!result.ok) return reply.code(400).send({ error: result.error });
        return { ok: true, status: 'NEEDS_REVIEW' };
    });

    // POST /v1/admin/sweep - TTL Cleanup (SRE/Admin only)
    server.post('/v1/admin/sweep', {
        preHandler: [requireRole(['admin'])],
    }, async (request, reply) => {
        const count = await sweepExpiredBookings();
        return { ok: true, swept: count };
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

    // GET /v1/bookings/:id - Single booking view
    server.get('/v1/bookings/:id', {
        preHandler: [requireRole(['user', 'provider', 'admin'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid, role } = request.user!;

        const booking = await getBooking(id);
        if (!booking) return reply.code(404).send({ error: 'Booking not found' });

        // Authorization: Customer, Assigned Provider, or Admin
        const isCustomer = booking.customer_id === uid;
        const isAssignedProvider = booking.provider_id === uid;
        const isCandidate = booking.candidate_list.includes(uid);
        const isAdmin = role === 'admin';

        if (!isCustomer && !isAssignedProvider && !isCandidate && !isAdmin) {
            return reply.code(403).send({ error: 'Unauthorized' });
        }

        // Hardening: Strip OTP for everyone except customer owner and admin
        const response: Partial<typeof booking> = { ...booking };
        if (!isCustomer && !isAdmin) {
            delete response.otp;
        }

        return response;
    });

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

        const intent = await createIntent(id, booking.price_snapshot_cents ?? undefined);

        // Store Stripe ref on booking for downstream capture
        await query(
            'UPDATE bookings SET stripe_payment_intent_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [intent.provider_ref, id]
        );

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
        const isProd = config.isProd;

        // Signature Verification (Stripe constructEvent in prod, HMAC/mock fallback)
        const verifySignature = (sig: string, payload: any, rawPayload?: Buffer): boolean => {
            const secret = config.stripe.webhookSecret;
            if (!secret) {
                if (isProd) {
                    server.log.fatal('STRIPE_WEBHOOK_SECRET not set in production');
                    return false;
                }
                return sig === 'valid_secret'; // Mock for dev
            }

            if (!rawPayload) {
                server.log.error('Raw payload missing for signature verification');
                return false;
            }

            // Use Stripe SDK constructEvent when available, HMAC fallback otherwise
            const stripeKey = config.stripe.secretKey;
            if (stripeKey) {
                try {
                    const stripe = new Stripe(stripeKey);
                    stripe.webhooks.constructEvent(rawPayload, sig, secret);
                    return true;
                } catch (e) {
                    server.log.error({ err: e }, 'Stripe constructEvent failed');
                    return false;
                }
            }

            // HMAC fallback for non-Stripe environments
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
            const status = await processEvent(provider, eventId, body, async () => {
                // Side-effect: Handle different event types
                if (body.type === 'payment_intent.succeeded') {
                    const providerRef = body.data?.object?.id || body.reference;
                    await handleIntentSuccess(provider.toUpperCase(), providerRef);
                } else if (body.type === 'payment_intent.payment_failed') {
                    const providerRef = body.data?.object?.id || body.reference;
                    const bookingId = body.data?.object?.metadata?.booking_id;
                    server.log.warn(`Payment failed for ${providerRef} (Booking: ${bookingId})`);
                    // Note: We don't advance the state if it fails.
                    // The customer will see the PENDING_PAYMENT status and can retry.
                }
            });

            return { status };
        } catch (error) {
            server.log.error(error);
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });

    // POST /v1/bookings/:id/provider-complete - Provider marks job done (NO capture)
    server.post('/v1/bookings/:id/provider-complete', {
        preHandler: [requireRole(['provider'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid } = request.user!;

        const booking = await getBooking(id);
        if (!booking) return reply.code(404).send({ error: 'Booking not found' });

        // Authorization: Must be the assigned provider
        if (booking.provider_id !== uid) {
            return reply.code(403).send({ error: 'Unauthorized: You are not the assigned provider' });
        }

        // Precondition: Must be IN_PROGRESS
        if (booking.status !== 'IN_PROGRESS') {
            return reply.code(400).send({ error: `Booking must be IN_PROGRESS, currently: ${booking.status}` });
        }

        // Transition to COMPLETE_PENDING — NO capture here
        const result = await updateBookingStatus(id, 'COMPLETE_PENDING', 'Provider', uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });

        return { ok: true, status: 'COMPLETE_PENDING' };
    });

    // POST /v1/bookings/:id/confirm-complete - Customer confirms completion: capture then CLOSED
    server.post('/v1/bookings/:id/confirm-complete', {
        preHandler: [requireRole(['user'])],
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { uid } = request.user!;

        const booking = await getBooking(id);
        if (!booking) return reply.code(404).send({ error: 'Booking not found' });

        // Authorization: Only the customer who owns the booking
        if (booking.customer_id !== uid) {
            return reply.code(403).send({ error: 'Unauthorized: You are not the owner of this booking' });
        }

        // Idempotency: If already CLOSED, return success without re-capturing
        if (booking.status === 'CLOSED') {
            return { ok: true, status: 'CLOSED', already_closed: true };
        }

        // Precondition: Must be COMPLETE_PENDING
        if (booking.status !== 'COMPLETE_PENDING') {
            return reply.code(400).send({ error: `Booking must be in COMPLETE_PENDING state, currently: ${booking.status}` });
        }

        // Capture payment before closing
        try {
            await capturePayment(id);
        } catch (e: any) {
            server.log.error({ err: e }, 'Payment capture failed during confirm-complete');
            return reply.code(409).send({ error: 'Payment capture failed', detail: e.message });
        }

        // Transition to CLOSED using existing state machine
        const result = await updateBookingStatus(id, 'CLOSED', 'System', uid);
        if (!result.ok) return reply.code(400).send({ error: result.error });

        return { ok: true, status: 'CLOSED' };
    });

    return server;
}
