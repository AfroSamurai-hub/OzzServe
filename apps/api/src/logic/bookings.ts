import { BookingState, isValidTransition, UserRole } from './state-machine.js';
import { query, withTx } from '../db.js';

export interface Booking {
    id: string;
    status: BookingState;
    customer_id: string;
    provider_id: string | null;
    service_id: string;
    slot_id: string;
    candidate_list: string[]; // UIDs
    expires_at: string;
    created_at: string;
    updated_at: string;
}

/**
 * Creates a new booking and generates the initial candidate list.
 */
export async function createBooking(data: { service_id: string; slot_id: string; user_id: string }): Promise<Booking> {
    return withTx(async (client) => {
        // 1. Generate candidate list (deterministic: top 5 online providers for this service)
        const candidateRes = await client.query<{ user_uid: string }>(
            `SELECT p.user_uid FROM providers p
             JOIN provider_services ps ON p.id = ps.provider_id
             WHERE ps.service_id = $1 AND p.is_online = TRUE
             ORDER BY p.created_at ASC
             LIMIT 5`,
            [data.service_id]
        );
        const candidates = candidateRes.rows.map(r => r.user_uid);

        // 2. Insert booking
        const res = await client.query(
            `INSERT INTO bookings (status, customer_id, service_id, slot_id, expires_at, candidate_list)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, status, customer_id, provider_id, service_id, slot_id, expires_at, created_at, updated_at, candidate_list`,
            ['PENDING', data.user_id, data.service_id, data.slot_id, new Date(Date.now() + 15 * 60000).toISOString(), JSON.stringify(candidates)]
        );
        const row = res.rows[0];
        const booking: Booking = {
            ...row,
            candidate_list: typeof row.candidate_list === 'string' ? JSON.parse(row.candidate_list) : row.candidate_list
        };

        // 3. Log event
        await client.query(
            `INSERT INTO booking_events (booking_id, type, actor_role, actor_id, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [booking.id, 'create_booking', 'User', data.user_id, JSON.stringify({ ...data, candidates })]
        );

        return booking;
    });
}

/**
 * Fetches a booking by ID.
 */
export async function getBooking(id: string): Promise<Booking | undefined> {
    const res = await query<Booking>('SELECT * FROM bookings WHERE id = $1', [id]);
    return res.rows[0];
}

/**
 * Updates booking status with policy enforcement, atomic guards, and candidate checks.
 */
export async function updateBookingStatus(
    id: string,
    nextStatus: BookingState,
    role: UserRole,
    actorId?: string
): Promise<{ ok: boolean; error?: string }> {
    return withTx(async (client) => {
        // 1. Fetch current status and candidate list with lock
        const res = await client.query(
            'SELECT status, customer_id, provider_id, candidate_list FROM bookings WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (res.rowCount === 0) {
            return { ok: false, error: 'Booking not found' };
        }
        const booking = res.rows[0];
        const currentStatus = booking.status as BookingState;
        const candidates = (booking.candidate_list || []) as string[];

        // 2. Validate transition
        if (!isValidTransition(currentStatus, nextStatus, role)) {
            return { ok: false, error: `Invalid transition from ${currentStatus} to ${nextStatus} for role ${role}` };
        }

        // 3. Role-specific enforcement (Ownership & Candidates)
        if (role === 'Provider') {
            if (!actorId) return { ok: false, error: 'Provider ID required' };

            // If already claimed, only the assigned provider can move it
            if (booking.provider_id && booking.provider_id !== actorId) {
                return { ok: false, error: 'Booking claimed by another provider' };
            }

            // If not yet claimed, check candidate list
            if (!booking.provider_id && !candidates.includes(actorId)) {
                return { ok: false, error: 'Provider is not in the candidate list for this booking' };
            }
        }

        // 4. Atomic Update
        const updateRes = await client.query(
            `UPDATE bookings 
             SET status = $1, 
                 updated_at = CURRENT_TIMESTAMP,
                 provider_id = COALESCE(provider_id, $2)
             WHERE id = $3 AND status = $4
             RETURNING *`,
            [nextStatus, role === 'Provider' ? actorId : null, id, currentStatus]
        );

        if (updateRes.rowCount === 0) {
            return { ok: false, error: 'Atomic update failed (status drift)' };
        }

        // 5. Log event
        await client.query(
            `INSERT INTO booking_events (booking_id, type, actor_role, actor_id, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, `transition_${nextStatus.toLowerCase()}`, role, actorId || null, JSON.stringify({ from: currentStatus, to: nextStatus })]
        );

        return { ok: true };
    });
}
/**
 * Fetches bookings for a customer with optional status filter and pagination.
 */
export async function getUserBookings(
    customerId: string,
    filters: { status?: string, limit?: number, offset?: number }
): Promise<Booking[]> {
    let sql = 'SELECT * FROM bookings WHERE customer_id = $1';
    const params: any[] = [customerId];

    if (filters.status) {
        params.push(filters.status);
        sql += ` AND status = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
        params.push(filters.limit);
        sql += ` LIMIT $${params.length}`;
    }
    if (filters.offset) {
        params.push(filters.offset);
        sql += ` OFFSET $${params.length}`;
    }

    const res = await query<Booking>(sql, params);
    return res.rows.map(row => ({
        ...row,
        candidate_list: typeof row.candidate_list === 'string' ? JSON.parse(row.candidate_list) : row.candidate_list
    }));
}

/**
 * Fetches claimed bookings for a provider with optional status filter and pagination.
 */
export async function getProviderBookings(
    providerId: string,
    filters: { status?: string, limit?: number, offset?: number }
): Promise<Booking[]> {
    let sql = 'SELECT * FROM bookings WHERE provider_id = $1';
    const params: any[] = [providerId];

    if (filters.status) {
        params.push(filters.status);
        sql += ` AND status = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
        params.push(filters.limit);
        sql += ` LIMIT $${params.length}`;
    }
    if (filters.offset) {
        params.push(filters.offset);
        sql += ` OFFSET $${params.length}`;
    }

    const res = await query<Booking>(sql, params);
    return res.rows.map(row => ({
        ...row,
        candidate_list: typeof row.candidate_list === 'string' ? JSON.parse(row.candidate_list) : row.candidate_list
    }));
}
