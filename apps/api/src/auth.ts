import { FastifyRequest, FastifyReply } from 'fastify';
import admin from 'firebase-admin';

// Initialize Firebase Admin (assuming credentials are in environment or default location)
if (!admin.apps.length) {
    admin.initializeApp();
}

export type UserRole = 'user' | 'provider' | 'admin';

declare module 'fastify' {
    interface FastifyRequest {
        user?: {
            uid: string;
            role: UserRole;
        };
    }
}

/**
 * Fastify Middleware for authentication.
 * Production: Strictly requires Firebase JWT in Authorization header.
 * Non-Prod: Allows Firebase JWT OR dev headers (x-user-id, x-role).
 */
export async function verifyToken(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;
    const isProd = process.env.NODE_ENV === 'production';

    // 1. Try Firebase JWT first (Standard for Prod and Dev)
    if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            // In a real app, role might be in custom claims or a separate DB profile
            // For MVP, we'll try to extract from claims or fallback to 'user'
            request.user = {
                uid: decodedToken.uid,
                role: (decodedToken.role as UserRole) || 'user',
            };
            return;
        } catch (error) {
            return reply.code(401).send({ error: 'Invalid Firebase token', code: 'AUTH_INVALID_TOKEN' });
        }
    }

    // 2. Fallback to Dev Headers (Strictly DISABLED in production)
    const uid = request.headers['x-user-id'] as string;
    const role = request.headers['x-role'] as string;

    if (uid && role) {
        if (isProd) {
            return reply.code(401).send({
                error: 'Dev headers are disabled in production. Use Firebase Auth.',
                code: 'AUTH_DEV_DISABLED'
            });
        }

        if (!['user', 'provider', 'admin'].includes(role)) {
            return reply.code(401).send({ error: 'Invalid role provided' });
        }

        request.user = {
            uid,
            role: role as UserRole,
        };
        return;
    }

    return reply.code(401).send({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
}

/**
 * Role-based authorization helper.
 * Returns a Fastify preHandler hook.
 */
export function requireRole(allowedRoles: UserRole[]) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        if (!request.user) {
            return reply.code(401).send({ error: 'Unauthorized: No user session' });
        }

        if (!allowedRoles.includes(request.user.role)) {
            return reply.code(403).send({ error: 'Forbidden: Insufficient permissions' });
        }
    };
}
