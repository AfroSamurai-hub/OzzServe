import { query, withTx } from '../db.js';
import { Booking } from './bookings.js';

export interface Provider {
    id: string;
    user_uid: string;
    display_name: string;
    is_online: boolean;
    created_at: string;
    updated_at: string;
}

/**
 * Upserts a provider profile and their offered services.
 */
export async function upsertProvider(
    uid: string,
    data: { display_name: string; is_online: boolean; services: string[] }
): Promise<void> {
    await withTx(async (client) => {
        const res = await client.query(
            `INSERT INTO providers (user_uid, display_name, is_online, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (user_uid) DO UPDATE 
             SET display_name = EXCLUDED.display_name, 
                 is_online = EXCLUDED.is_online,
                 updated_at = EXCLUDED.updated_at
             RETURNING id`,
            [uid, data.display_name, data.is_online]
        );
        const providerId = res.rows[0].id;

        // Update services
        await client.query('DELETE FROM provider_services WHERE provider_id = $1', [providerId]);
        for (const serviceId of data.services) {
            await client.query(
                'INSERT INTO provider_services (provider_id, service_id) VALUES ($1, $2)',
                [providerId, serviceId]
            );
        }
    });
}

/**
 * Updates a provider's last known location.
 */
export async function updateLocation(uid: string, lat: number, lng: number): Promise<void> {
    await query(
        `INSERT INTO provider_locations (provider_id, lat, lng, updated_at)
         SELECT id, $2, $3, CURRENT_TIMESTAMP FROM providers WHERE user_uid = $1
         ON CONFLICT (provider_id) DO UPDATE 
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = EXCLUDED.updated_at`,
        [uid, lat, lng]
    );
}

/**
 * Fetches booking offers for a candidate provider.
 * Defined as bookings in 'PAID' state where the provider is in the candidate list.
 */
export async function getOffers(uid: string): Promise<Booking[]> {
    const res = await query<Booking>(
        `SELECT * FROM bookings 
         WHERE status = 'PAID_SEARCHING' 
         AND candidate_list @> $1::jsonb`,
        [JSON.stringify([uid])]
    );
    return res.rows;
}
