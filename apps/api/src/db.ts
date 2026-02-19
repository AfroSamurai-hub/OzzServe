import pg from 'pg';
import { config } from './config.js';

let pool: pg.Pool | null = null;

function getPool() {
    if (!pool) {
        const isCloudSql = config.db.host.includes('/cloudsql/');

        pool = new pg.Pool({
            user: config.db.user,
            password: config.db.pass,
            host: isCloudSql ? undefined : config.db.host,
            port: config.db.port,
            database: config.db.name,
            // Cloud SQL use unix sockets if host starts with /
            ...(isCloudSql ? { host: config.db.host } : {})
        });
    }
    return pool;
}

/**
 * Executes a parameterized SQL query.
 */
export async function query<T extends pg.QueryResultRow>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
    return getPool().query<T>(text, params);
}

/**
 * Runs a set of operations within a single database transaction.
 */
export async function withTx<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Only use for graceful shutdown.
 */
export async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs versioned migrations from db/migrations.
 */
export async function runMigrations() {
    const migrationsDir = path.join(__dirname, '../db/migrations');
    if (!fs.existsSync(migrationsDir)) return;

    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    // Ensure table exists
    await query(`CREATE TABLE IF NOT EXISTS schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`);

    for (const file of files) {
        const version = parseInt(file.split('_')[0]);
        if (isNaN(version)) continue;

        const { rows } = await query('SELECT 1 FROM schema_versions WHERE version = $1', [version]);
        if (rows.length === 0) {
            console.log(`Applying migration ${file}...`);
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            await withTx(async (client) => {
                await client.query(sql);
                await client.query('INSERT INTO schema_versions (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [version]);
            });
        }
    }
}
