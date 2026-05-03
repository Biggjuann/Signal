import pg from 'pg';

const { Pool } = pg;

let pool = null;
let initPromise = null;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  return pool;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    business_name TEXT NOT NULL,
    website TEXT,
    query TEXT,
    audit_score INTEGER,
    audit_results JSONB,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS leads_email_idx ON leads(email);
  CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at DESC);
`;

export async function initDb() {
  const p = getPool();
  if (!p) {
    console.warn('DATABASE_URL not set — lead capture disabled.');
    return false;
  }
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await p.query(SCHEMA);
        console.log('Postgres connected. Schema ready.');
        return true;
      } catch (err) {
        console.error('Postgres init failed:', err.message);
        initPromise = null;
        throw err;
      }
    })();
  }
  return initPromise;
}

export function isDbReady() {
  return Boolean(getPool());
}

export async function insertLead({
  email,
  businessName,
  website,
  query,
  auditScore,
  auditResults,
  ipAddress,
  userAgent,
}) {
  const p = getPool();
  if (!p) throw new Error('Database not configured');
  const { rows } = await p.query(
    `INSERT INTO leads
       (email, business_name, website, query, audit_score, audit_results, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      email,
      businessName,
      website || null,
      query || null,
      typeof auditScore === 'number' ? auditScore : null,
      auditResults ? JSON.stringify(auditResults) : null,
      ipAddress || null,
      userAgent || null,
    ]
  );
  return rows[0];
}
