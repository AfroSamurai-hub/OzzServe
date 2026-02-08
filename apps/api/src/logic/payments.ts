import { query, withTx } from '../db.js';
import { updateBookingStatus } from './bookings.js';

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
 * MVP: Static pricing (10000 cents = R100).
 */
export async function createIntent(bookingId: string): Promise<PaymentIntent> {
    const amount_cents = 10000;
    const currency = 'ZAR';
    const provider = 'STRIPE'; // Default for MVP
    const provider_ref = `pi_mock_${Math.random().toString(36).substring(7)}`;

    const res = await query<PaymentIntent>(
        `INSERT INTO payment_intents (booking_id, amount_cents, currency, status, provider, provider_ref)
         VALUES ($1, $2, $3, 'CREATED', $4, $5)
         RETURNING *`,
        [bookingId, amount_cents, currency, provider, provider_ref]
    );

    return res.rows[0];
}

/**
 * Handles intent success. Usually triggered by webhook.
 * Transitions booking to 'PAID' if intent is found.
 */
export async function handleIntentSuccess(provider: string, providerRef: string): Promise<void> {
    await withTx(async (client) => {
        const res = await client.query(
            'UPDATE payment_intents SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE provider = $2 AND provider_ref = $3 RETURNING booking_id',
            ['SUCCEEDED', provider, providerRef]
        );

        if (res.rowCount === 0) {
            throw new Error(`Payment intent not found for ref ${providerRef}`);
        }

        const bookingId = res.rows[0].booking_id;

        // Transition booking: PENDING -> AWAITING_PAYMENT -> PAID
        // System automated role
        await updateBookingStatus(bookingId, 'AWAITING_PAYMENT', 'User');
        const result = await updateBookingStatus(bookingId, 'PAID', 'System');

        if (!result.ok) {
            throw new Error(`Failed to transition booking ${bookingId} to PAID: ${result.error}`);
        }
    });
}
