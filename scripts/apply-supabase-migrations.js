import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MIGRATION_DIR = new URL('../supabase/migrations/', import.meta.url);
const PROJECT_REF_PATTERN = /^[a-z]{20}$/;
const MIGRATION_PATTERN = /^(\d{12})_([a-z0-9_]+)\.sql$/;

function rowsFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function applySupabaseMigrations({
  accessToken,
  projectRef,
  dryRun = false,
  fetchImpl = fetch,
  migrationDir = MIGRATION_DIR,
}) {
  if (!accessToken) throw new Error('SUPABASE_ACCESS_TOKEN is required');
  if (!PROJECT_REF_PATTERN.test(projectRef || '')) throw new Error('SUPABASE_PROJECT_REF is invalid');

  const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  const query = async (sql, readOnly) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql, read_only: readOnly }),
    });
    if (!response.ok) throw new Error(`SUPABASE_MANAGEMENT_API_${response.status}`);
    return response.json();
  };

  const files = (await readdir(migrationDir)).filter((file) => MIGRATION_PATTERN.test(file)).sort();
  const appliedPayload = await query(
    'select version from supabase_migrations.schema_migrations order by version',
    true,
  );
  const applied = new Set(rowsFromResponse(appliedPayload).map((row) => String(row.version)));
  const pending = files.filter((file) => !applied.has(file.match(MIGRATION_PATTERN)[1]));

  if (dryRun) return { tracked: applied.size, pending };

  const completed = [];
  for (const file of pending) {
    const [, version, name] = file.match(MIGRATION_PATTERN);
    const migration = await readFile(new URL(file, migrationDir), 'utf8');
    if (/^\s*(?:begin\s*;|start\s+transaction\b|commit\s*;|rollback\s*;)/i.test(migration)) {
      throw new Error(`MIGRATION_TRANSACTION_CONTROL_NOT_ALLOWED:${file}`);
    }
    const statement = `begin;\n${migration}\ninsert into supabase_migrations.schema_migrations(version, statements, name) values (${sqlLiteral(version)}, array[]::text[], ${sqlLiteral(name)}) on conflict (version) do nothing;\ncommit;`;
    await query(statement, false);
    completed.push(file);
  }
  return { tracked: applied.size + completed.length, applied: completed };
}

async function main() {
  const result = await applySupabaseMigrations({
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    projectRef: process.env.SUPABASE_PROJECT_REF,
    dryRun: process.argv.includes('--dry-run'),
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
