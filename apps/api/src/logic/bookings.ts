import pg from 'pg';
import { BookingState, isValidTransition, UserRole } from './state-machine.js';
import { query, withTx } from '../db.js';
import { releaseAuthorization, chargeCancellationFee, capturePayment } from './payments.js';
import { getServiceById } from './services.js';

export interface Booking {
    id: string;
    status: BookingState;
    customer_id: string;
    provider_id: string | null;
    service_id: string;
    slot_id: string;
    candidate_list: string[]; // UIDs
    otp: string;
    expires_at: string;
    complete_pending_until: string | null;
    service_name_snapshot: string | null;
    price_snapshot_cents: number | null;
    stripe_payment_intent_id: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * Creates a new booking and generates the initial candidate list.
 */
export async function createBooking(data: { service_id: string; slot_id: string; user_id: string }): Promise<Booking> {
    return withTx(async (client) => {
        // 0. Look up service for price/name snapshot (backward-compatible: null if not found)
        const service = await getServiceById(data.service_id);
        const serviceNameSnapshot = service?.name ?? null;
        const priceSnapshotCents = service?.price_cents ?? null;

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

        // 2. Insert booking with 4-digit OTP + service snapshot
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        const res = await client.query(
            `INSERT INTO bookings (status, customer_id, service_id, slot_id, expires_at, candidate_list, otp, service_name_snapshot, price_snapshot_cents)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            ['PENDING_PAYMENT', data.user_id, data.service_id, data.slot_id, new Date(Date.now() + 15 * 60000).toISOString(), JSON.stringify(candidates), otp, serviceNameSnapshot, priceSnapshotCents]
        );
        const row = res.rows[0];
        const booking: Booking = {
            ...row,
            candidate_list: typeof row.candidate_list === 'string' ? JSON.parse(row.candidate_list) : row.candidate_list,
            otp: row.otp // Ensure otp is returned in the object
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
    actorId?: string,
    otp?: string,
    client?: pg.PoolClient
): Promise<{ ok: boolean; error?: string }> {
    const logic = async (tx: pg.PoolClient) => {
        // 1. Fetch current status, candidate list, and OTP with lock
        const res = await tx.query(
            'SELECT status, customer_id, provider_id, candidate_list, otp FROM bookings WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (res.rowCount === 0) {
            return { ok: false, error: 'Booking not found' };
        }
        const booking = res.rows[0];
        const currentStatus = booking.status as BookingState;
        const candidates = (booking.candidate_list || []) as string[];
        const correctOtp = booking.otp;

        // 2. Validate transition
        if (!isValidTransition(currentStatus, nextStatus, role)) {
            return { ok: false, error: `Invalid transition from ${currentStatus} to ${nextStatus} for role ${role}` };
        }

        // 2b. OTP verification for IN_PROGRESS
        if (nextStatus === 'IN_PROGRESS' && currentStatus === 'ARRIVED') {
            if (!otp || otp !== correctOtp) {
                return { ok: false, error: 'Invalid or missing OTP' };
            }
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
        const updateRes = await tx.query(
            `UPDATE bookings 
             SET status = $1, 
                 updated_at = CURRENT_TIMESTAMP,
                 provider_id = COALESCE(provider_id, $2),
                 complete_pending_until = CASE WHEN $1 = 'COMPLETE_PENDING' THEN NOW() + INTERVAL '30 minutes' ELSE complete_pending_until END
             WHERE id = $3 AND status = $4
             RETURNING *`,
            [nextStatus, role === 'Provider' ? actorId : null, id, currentStatus]
        );

        if (updateRes.rowCount === 0) {
            return { ok: false, error: 'Atomic update failed (status drift)' };
        }

        // 5. Log event
        await tx.query(
            `INSERT INTO booking_events (booking_id, type, actor_role, actor_id, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, `transition_${nextStatus.toLowerCase()}`, role, actorId || null, JSON.stringify({ from: currentStatus, to: nextStatus })]
        );

        return { ok: true };
    };

    if (client) {
        return logic(client);
    } else {
        return withTx(logic);
    }
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

/**
 * Cancels a booking with fee logic.
 */
export async function cancelBooking(id: string, role: UserRole, actorId: string): Promise<{ ok: boolean; error?: string }> {
    return withTx(async (client) => {
        const res = await client.query('SELECT status, customer_id, provider_id FROM bookings WHERE id = $1 FOR UPDATE', [id]);
        if (res.rowCount === 0) return { ok: false, error: 'Booking not found' };
        const booking = res.rows[0];
        const currentStatus = booking.status as BookingState;

        // Validation: Only customer can cancel for now, and must be owner
        if (role === 'User' && booking.customer_id !== actorId) {
            return { ok: false, error: 'Unauthorized to cancel this booking' };
        }

        if (!isValidTransition(currentStatus, 'CANCELLED', role)) {
            return { ok: false, error: `Cannot cancel booking in state ${currentStatus}` };
        }

        // Fee Logic
        const needsFee = ['EN_ROUTE', 'ARRIVED'].includes(currentStatus);

        // 1. Release original authorization (if any)
        await releaseAuthorization(id, client);

        // 2. Charge fee if applicable
        if (needsFee) {
            await chargeCancellationFee(id, client);
        }

        // 3. Update status
        await client.query('UPDATE bookings SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', ['CANCELLED', id]);

        // 4. Log event
        await client.query(
            `INSERT INTO booking_events (booking_id, type, actor_role, actor_id, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, 'transition_cancelled', role, actorId, JSON.stringify({ from: currentStatus, to: 'CANCELLED', feeCharged: needsFee })]
        );

        return { ok: true };
    });
}

/**
 * Sweeps stale PENDING_PAYMENT bookings to EXPIRED after 24 hours.
 */
export async function sweepExpiredBookings(): Promise<number> {
    const res = await query(
        `UPDATE bookings 
         SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP 
         WHERE status = 'PENDING_PAYMENT' 
         AND created_at < NOW() - INTERVAL '24 hours'
         RETURNING id`
    );
    return res.rowCount || 0;
}
/**
 * Provider cancels a booking (Re-dispatch flow).
 * Only allowed in ACCEPTED or EN_ROUTE.
 */
export async function providerCancelBooking(id: string, providerId: string): Promise<{ ok: boolean; error?: string }> {
    return withTx(async (client) => {
        const res = await client.query('SELECT status, provider_id, customer_id FROM bookings WHERE id = $1 FOR UPDATE', [id]);
        if (res.rowCount === 0) return { ok: false, error: 'Booking not found' };
        const booking = res.rows[0];

        if (booking.provider_id !== providerId) {
            return { ok: false, error: 'Unauthorized: You are not the assigned provider' };
        }

        const currentStatus = booking.status as BookingState;
        if (!isValidTransition(currentStatus, 'PAID_SEARCHING', 'Provider')) {
            return { ok: false, error: `Invalid transition from ${currentStatus} to PAID_SEARCHING for Provider` };
        }

        // 1. Revert status to PAID_SEARCHING and clear provider_id
        await client.query(
            `UPDATE bookings SET status = $1, provider_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            ['PAID_SEARCHING', id]
        );

        // 2. Log event
        await client.query(
            `INSERT INTO booking_events (booking_id, type, actor_role, actor_id, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, 'provider_cancelled', 'Provider', providerId, JSON.stringify({ from: currentStatus, to: 'PAID_SEARCHING' })]
        );

        // 3. Queue notification for customer
        await client.query(
            `INSERT INTO notification_outbox (booking_id, recipient_uid, type, payload)
             VALUES ($1, $2, $3, $4)`,
            [id, booking.customer_id, 'PROVIDER_CANCELLED', JSON.stringify({ message: 'Provider cancelled, searching for a new one.' })]
        );

        return { ok: true };
    });
}

/**
 * Customer flags an issue during the grace window.
 */
export async function flagIssue(id: string, customerId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
    return withTx(async (client) => {
        const res = await client.query(
            'SELECT status, customer_id, complete_pending_until FROM bookings WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (res.rowCount === 0) return { ok: false, error: 'Booking not found' };
        const booking = res.rows[0];

        if (booking.customer_id !== customerId) {
            return { ok: false, error: 'Unauthorized: You are not the owner of this booking' };
        }

        if (booking.status !== 'COMPLETE_PENDING') {
            return { ok: false, error: 'Booking must be in COMPLETE_PENDING state to flag an issue' };
        }

        if (!booking.complete_pending_until || new Date() > new Date(booking.complete_pending_until)) {
            return { ok: false, error: 'Grace window for flagging issues has closed' };
        }

        // 1. Transition to NEEDS_REVIEW
        await client.query(
            `UPDATE bookings SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            ['NEEDS_REVIEW', id]
        );

        // 2. Log event
        await client.query(
            `INSERT INTO booking_events (booking_id, type, actor_role, actor_id, payload)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, 'issue_flagged', 'User', customerId, JSON.stringify({ reason })]
        );

        // 3. Queue notification for admin
        await client.query(
            `INSERT INTO notification_outbox (booking_id, recipient_uid, type, payload)
             VALUES ($1, $2, $3, $4)`,
            [id, 'SYSTEM_ADMIN', 'ISSUE_FLAGGED', JSON.stringify({ reason, customerId })]
        );

        return { ok: true };
    });
}

/**
 * Finishes service and attempts payment capture.
 * If capture fails, the booking remains IN_PROGRESS.
 */
export async function completeBooking(id: string, providerId: string): Promise<{ ok: boolean; error?: string; code?: string }> {
    return withTx(async (client) => {
        // 1. Fetch current status with lock
        const res = await client.query(
            'SELECT status, provider_id, customer_id FROM bookings WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (res.rowCount === 0) return { ok: false, error: 'Booking not found' };
        const booking = res.rows[0];

        // 2. Authorization & State Check
        if (booking.provider_id !== providerId) {
            return { ok: false, error: 'Booking claimed by another provider', code: 'UNAUTHORIZED' };
        }
        if (booking.status !== 'IN_PROGRESS') {
            return { ok: false, error: `Invalid state: ${booking.status}`, code: 'INVALID_STATE' };
        }

        // 3. Attempt Payment Capture
        try {
            await capturePayment(id, client);
        } catch (e: any) {
            // Log Failure Event
            await client.query(
                `INSERT INTO booking_events (booking_id, type, actor_role, actor_id, payload)
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, 'capture_failed', 'Provider', providerId, JSON.stringify({ error: e.message })]
            );

            // Queue Admin Notification
            await client.query(
                `INSERT INTO notification_outbox (booking_id, recipient_uid, type, payload)
                 VALUES ($1, $2, $3, $4)`,
                [id, 'SYSTEM_ADMIN', 'CAPTURE_FAILED', JSON.stringify({ error: e.message, providerId })]
            );

            return { ok: false, error: 'Payment capture failed', code: 'CAPTURE_FAILED' };
        }

        // 4. Advance State (Using our refactored status updater)
        const result = await updateBookingStatus(id, 'COMPLETE_PENDING', 'Provider', providerId, undefined, client);
        if (!result.ok) throw new Error(result.error); // Should not happen if locking works

        return { ok: true };
    });
}
