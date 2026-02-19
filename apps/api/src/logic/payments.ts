import pg from 'pg';
import Stripe from 'stripe';
import { query, withTx } from '../db.js';
import { updateBookingStatus } from './bookings.js';
import { config } from '../config.js';

// Lazy-init Stripe client (only when secret key is available)
let stripeClient: Stripe | null = null;
function getStripe(): Stripe | null {
    if (stripeClient) return stripeClient;
    const key = config.stripe.secretKey;
    if (!key) return null;
    stripeClient = new Stripe(key);
    return stripeClient;
}

export interface PaymentIntent {
    id: string;
    booking_id: string;
    amount_cents: number;
    currency: string;
    status: string;
    provider: string;
    provider_ref: string;
}

/**
 * Creates a payment intent for a booking.
 * Production: Uses Stripe SDK with capture_method='manual'.
 * Dev/Test: Falls back to mock reference.
 */
export async function createIntent(bookingId: string, amountCents?: number): Promise<PaymentIntent> {
    const amount_cents = amountCents ?? 10000; // Fallback to R100 for backward compatibility
    const currency = 'ZAR';
    const provider = 'STRIPE';
    let provider_ref: string;

    const stripe = getStripe();
    if (stripe) {
        // Production: Real Stripe PaymentIntent with manual capture
        const intent = await stripe.paymentIntents.create({
            amount: amount_cents,
            currency: currency.toLowerCase(),
            capture_method: 'manual',
            metadata: { booking_id: bookingId },
        });
        provider_ref = intent.id;
    } else {
        // Dev/Test: Mock reference
        provider_ref = `pi_mock_${Math.random().toString(36).substring(7)}`;
    }

    const res = await query<PaymentIntent>(
        `INSERT INTO payment_intents (booking_id, amount_cents, currency, status, provider, provider_ref)
         VALUES ($1, $2, $3, 'CREATED', $4, $5)
         RETURNING *`,
        [bookingId, amount_cents, currency, provider, provider_ref]
    );

    return res.rows[0];
}

/**
 * Handles intent success (Authorization). 
 * For 'manual' capture flow, this means funds are locked but not yet taken.
 */
export async function handleIntentSuccess(provider: string, providerRef: string): Promise<void> {
    await withTx(async (client) => {
        const res = await client.query(
            'UPDATE payment_intents SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE provider = $2 AND provider_ref = $3 RETURNING booking_id',
            ['AUTHORIZED', provider, providerRef]
        );

        if (res.rowCount === 0) {
            throw new Error(`Payment intent not found for ref ${providerRef}`);
        }

        const bookingId = res.rows[0].booking_id;

        // Transition booking: PENDING_PAYMENT -> PAID_SEARCHING
        const result = await updateBookingStatus(bookingId, 'PAID_SEARCHING', 'System');

        if (!result.ok) {
            throw new Error(`Failed to transition booking ${bookingId} to PAID_SEARCHING: ${result.error}`);
        }
    });
}

/**
 * Captures an authorized payment intent.
 * Production: Calls Stripe SDK capture().
 * Dev/Test: DB-only status update.
 */
export async function capturePayment(bookingId: string, client?: pg.PoolClient): Promise<void> {
    // 1. Find the authorized intent
    const findSql = `SELECT id, provider_ref FROM payment_intents 
         WHERE booking_id = $1 AND status = 'AUTHORIZED'`;
    const findRes = client ? await client.query(findSql, [bookingId]) : await query(findSql, [bookingId]);

    if (findRes.rowCount === 0) {
        throw new Error(`No AUTHORIZED payment intent found to capture for booking ${bookingId}`);
    }

    const providerRef = findRes.rows[0].provider_ref;

    // 2. Call Stripe capture if available
    const stripe = getStripe();
    if (stripe && providerRef.startsWith('pi_') && !providerRef.startsWith('pi_mock_')) {
        await stripe.paymentIntents.capture(providerRef);
    }

    // 3. Update local status
    const updateSql = `UPDATE payment_intents 
         SET status = 'SUCCEEDED', updated_at = CURRENT_TIMESTAMP 
         WHERE booking_id = $1 AND status = 'AUTHORIZED'
         RETURNING id`;
    const updateRes = client ? await client.query(updateSql, [bookingId]) : await query(updateSql, [bookingId]);

    if (updateRes.rowCount === 0) {
        throw new Error(`Failed to update payment intent status for booking ${bookingId}`);
    }
}

/**
 * Releases an authorized payment intent.
 * Triggered on cancellation.
 */
export async function releaseAuthorization(bookingId: string, client?: pg.PoolClient): Promise<void> {
    const sql = `UPDATE payment_intents 
         SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP 
         WHERE booking_id = $1 AND status = 'AUTHORIZED'`;
    const params = [bookingId];
    if (client) {
        await client.query(sql, params);
    } else {
        await query(sql, params);
    }
}

/**
 * Charges a separate cancellation fee.
 * MVP: Static R10 fee (1000 cents).
 */
export async function chargeCancellationFee(bookingId: string, client?: pg.PoolClient): Promise<void> {
    const amount_cents = 1000;
    const currency = 'ZAR';
    const provider = 'STRIPE';
    const provider_ref = `pi_fee_${Math.random().toString(36).substring(7)}`;

    const sql = `INSERT INTO payment_intents (booking_id, amount_cents, currency, status, provider, provider_ref)
         VALUES ($1, $2, $3, 'SUCCEEDED', $4, $5)`;
    const params = [bookingId, amount_cents, currency, provider, provider_ref];
    if (client) {
        await client.query(sql, params);
    } else {
        await query(sql, params);
    }
}
