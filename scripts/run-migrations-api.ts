/**
 * Migration runner via Supabase Management API.
 * Uses the pg REST endpoint to execute SQL when direct pg connection is blocked.
 * Run: npx tsx scripts/run-migrations-api.ts
 */
import fs from 'fs';
import path from 'path';
import https from 'https';

// Load .env
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

const SUPABASE_URL = process.env['SUPABASE_URL']!;
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY']!;
const PROJECT_REF = SUPABASE_URL.replace('https://', '').split('.')[0]!;

function httpsPost(hostname: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function execSql(sql: string): Promise<void> {
  // Use Supabase Management API to run SQL
  const res = await httpsPost(
    'api.supabase.com',
    `/v1/projects/${PROJECT_REF}/database/query`,
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
    JSON.stringify({ query: sql })
  );

  if (res.status >= 400) {
    const parsed = JSON.parse(res.body);
    throw new Error(parsed.message || res.body);
  }
}

async function runMigrations() {
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  console.log(`\n🗄️  Running ${files.length} migration(s) via Supabase API...\n`);
  console.log(`   Project: ${PROJECT_REF}`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    process.stdout.write(`  ▶  ${file} ... `);
    try {
      await execSql(sql);
      console.log('✅');
    } catch (err: unknown) {
      const e = err as { message?: string };
      const msg = e.message ?? '';
      if (
        msg.includes('already exists') ||
        msg.includes('does not exist') ||
        msg.includes('duplicate') ||
        msg.includes('already applied')
      ) {
        console.log(`⚠️  (already applied: ${msg.slice(0, 80)})`);
      } else {
        console.log(`❌ ${msg}`);
        throw err;
      }
    }
  }
  console.log('\n✅ All migrations complete.\n');
}

runMigrations().catch((err) => {
  console.error('\n❌ Migration failed:', (err as Error).message);
  process.exit(1);
});
