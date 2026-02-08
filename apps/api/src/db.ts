import pg from 'pg';

let pool: pg.Pool | null = null;

function getPool() {
    if (!pool) {
        const isCloudSql = process.env.DB_HOST?.includes('/cloudsql/');

        pool = new pg.Pool({
            user: process.env.DB_USER || 'user',
            password: process.env.DB_PASS || 'password',
            host: isCloudSql ? undefined : (process.env.DB_HOST || 'localhost'),
            port: parseInt(process.env.DB_PORT || '5433'),
            database: process.env.DB_NAME || 'ozzserve',
            // Cloud SQL use unix sockets if host starts with /
            ...(isCloudSql ? { host: process.env.DB_HOST } : {})
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
