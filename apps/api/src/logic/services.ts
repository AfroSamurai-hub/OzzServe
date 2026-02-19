import { query } from '../db.js';

export interface Service {
    id: string;
    category: string;
    name: string;
    description_short: string | null;
    price_cents: number;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

/**
 * Returns all active services from the catalogue.
 */
export async function getActiveServices(): Promise<Service[]> {
    const res = await query<Service>(
        'SELECT * FROM services WHERE is_active = TRUE ORDER BY category, name'
    );
    return res.rows;
}

/**
 * Returns a single service by ID, or undefined if not found.
 */
export async function getServiceById(id: string): Promise<Service | undefined> {
    const res = await query<Service>('SELECT * FROM services WHERE id = $1', [id]);
    return res.rows[0];
}
