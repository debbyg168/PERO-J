import { Pool, PoolClient } from 'pg';

const MIGRATION_LOCK_ID = 836;

export class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      locked = true;

      await client.query('BEGIN');
      try {
        await this.runMigrations(client);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
        } catch (unlockErr) {
          console.error('Failed to release migration advisory lock:', unlockErr);
        }
      }
      client.release();
    }
  }

  private async runMigrations(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS contracts (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dlq_events (
        id SERIAL PRIMARY KEY,
        ledger_sequence BIGINT NOT NULL,
        tx_hash VARCHAR(64) NOT NULL,
        topic VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        error_message TEXT NOT NULL,
        retry_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dlq_events_retry_created
        ON dlq_events (retry_count, created_at);
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}