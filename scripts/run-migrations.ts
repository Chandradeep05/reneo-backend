import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Load .env manually (no dotenv dependency needed)
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  ssl: { rejectUnauthorized: false },
});

async function runMigrations() {
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 001_ before 002_ etc.

  const client = await pool.connect();
  console.log(`\n🗄️  Running ${files.length} migration(s) against Supabase...\n`);

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`  ▶  ${file}`);
      try {
        await client.query(sql);
        console.log(`  ✅ ${file} — OK`);
      } catch (err: unknown) {
        const e = err as { message?: string };
        // Idempotent migrations (IF NOT EXISTS, OR REPLACE) are safe to re-run
        // Some errors are acceptable on re-run (e.g., column already exists)
        if (
          e.message?.includes('already exists') ||
          e.message?.includes('does not exist')
        ) {
          console.log(`  ⚠️  ${file} — already applied or dependency issue: ${e.message}`);
        } else {
          throw err;
        }
      }
    }
    console.log('\n✅ All migrations complete.\n');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
