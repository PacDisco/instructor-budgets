// Neon over HTTP. No connection pooling to manage, which is what makes it
// workable in a Lambda that may cold-start on every request.
import { neon } from '@neondatabase/serverless';

let _sql;
export function db() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

export function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export async function assignedBudgetIds(email) {
  const sql = db();
  const rows = await sql`select budget_id from assignments where email = ${email}`;
  return rows.map((r) => r.budget_id);
}

// Postgres returns bigint as a string to avoid precision loss. Everything
// downstream expects numbers, so normalise at the boundary rather than
// scattering Number() through the app.
export function coerceMoney(row, fields) {
  const out = { ...row };
  for (const f of fields) if (out[f] !== null && out[f] !== undefined) out[f] = Number(out[f]);
  return out;
}
