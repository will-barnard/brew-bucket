const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({ ...config.db, max: 10, idleTimeoutMillis: 30000 });

pool.on('error', (err) => console.error('[db] idle client error', err.message));

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};
