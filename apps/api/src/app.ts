import Fastify, { FastifyInstance } from 'fastify';

/**
 * Centrally managed Fastify instance builder.
 * Used for both production server and test injection.
 */
export async function buildServer(): Promise<FastifyInstance> {
    const server = Fastify({
        logger: true,
    });

    // Health check endpoint
    server.get('/v1/health', async () => {
        return { ok: true };
    });

    // Future route registrations will go here

    return server;
}
