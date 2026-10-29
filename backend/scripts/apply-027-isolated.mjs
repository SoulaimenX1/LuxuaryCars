// ============================================================
// APPLICATION ISOLÉE DE LA MIGRATION 027 (UPDATED FOR LEGACY SCHEMA)
// ProfessionalVehicleReturns1792704600000
// ============================================================

import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { DataSource } from 'typeorm';

const { Client } = pg;

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(BACKEND_ROOT, '..');
const REPORT_DIR = join(REPO_ROOT, 'audit', 'phase3', 'migration-027');

loadEnv({ path: join(BACKEND_ROOT, '.env') });
process.chdir(BACKEND_ROOT);

const EXPECTED_DATABASE = 'luxury_car_rental';
const MIGRATION_NAME = 'ProfessionalVehicleReturns1792704600000';
const MIGRATION_JS = join(
  BACKEND_ROOT,
  'dist',
  'database',
  'migrations',
  '1792704600000-ProfessionalVehicleReturns.js',
);
const PATCH_SQL = join(
  BACKEND_ROOT,
  'database',
  'patches',
  '027-professional-vehicle-returns.sql',
);

const TABLES_CREATED_BY_027 = [
  'vehicle_returns',
  'return_inspections',
  'return_evidence',
  'return_damages',
  'vehicle_preparations',
  'preparation_cleaning_tasks',
  'preparation_events',
];

const SEQUENCES_CREATED_BY_027 = [
  'vehicle_return_reference_seq',
  'vehicle_preparation_reference_seq',
];

const INDEXES_CREATED_BY_027 = [
  'uq_return_once_per_rental',
  'uq_prep_active_per_vehicle',
  'idx_returns_status',
  'idx_return_evidence_return',
];

const CONSTRAINTS_CREATED_BY_027 = [
  'chk_agency_return_location',
  'chk_return_overdue_minutes',
  'uq_preparation_cleaning_task',
  'uq_preparation_event_seq',
];

const CONSTRAINT_ALIASES = {
  uq_preparation_cleaning_task: ['uq_cleaning_task'],
  uq_preparation_event_seq: ['uq_prep_event_seq'],
};
const INDEX_ALIASES = {
  uq_return_once_per_rental: ['uq_return_open_per_rental', 'uq_return_fingerprint'],
  idx_returns_status: ['idx_returns_status'], // may exist with different coverage but same name is fine
};

const SNAPSHOT_TABLES = [
  'users',
  'brands',
  'categories',
  'vehicle_models',
  'vehicles',
  'reservations',
  'rentals',
  'inspections',
  'inspection_damages',
  'payments',
  'security_deposits',
  'additional_charges',
  'audit_logs',
];

const SNAPSHOT_IGNORED_COLUMNS = {
  rentals: ['return_fee_policy_snapshot'],
};

const FINANCIAL_TABLES = ['payments', 'security_deposits', 'additional_charges'];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_BACKUP_CHECK = args.includes('--skip-backup-check');
const backupFlagIndex = args.indexOf('--backup');
const backupArgument =
  backupFlagIndex >= 0 ? args[backupFlagIndex + 1] : undefined;
const BACKUP_PATH = backupArgument ? resolve(backupArgument) : null;

const failures = [];
const warnings = [];
const report = {
  generatedAt: new Date().toISOString(),
  mode: DRY_RUN ? 'dry-run' : 'apply',
  backendRoot: BACKEND_ROOT,
  database: null,
  ledger: { before: [], after: [] },
  preflight: {},
  backup: null,
  migration: {
    attempted: false,
    executed: [],
    loadedInIsolatedDataSource: [],
    transactionMode: null,
    durationMs: null,
  },
  schema: {},
  preservation: {},
  failures,
  warnings,
  verdict: 'not-run',
};

function fail(message, detail) {
  failures.push(detail ? `${message} :: ${detail}` : message);
}

function ensure(condition, message, detail) {
  if (!condition) fail(message, detail);
  return condition;
}

function printBlock(title, lines) {
  console.log(`\n${title}`);
  for (const line of lines) console.log(`  ${line}`);
}

function writeReports() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(REPORT_DIR, `027-${DRY_RUN ? 'dry-run' : 'apply'}-${stamp}.json`);
  const mdPath = join(REPORT_DIR, `027-${DRY_RUN ? 'dry-run' : 'apply'}-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderMarkdown(), 'utf8');
  return { jsonPath, mdPath };
}

function renderMarkdown() {
  const lines = [
    '# Migration 027 — rapport isolé (compatible)',
    '',
    `- Généré : ${report.generatedAt}`,
    `- Mode : ${report.mode}`,
    `- Base : ${report.database?.currentDatabase ?? '?'} (${report.database?.serverVersion ?? '?'})`,
    `- Verdict : **${report.verdict}**`,
    '',
    '## Ledger avant',
    '',
    ...report.ledger.before.map((name) => `- ${name}`),
    '',
    '## Ledger après',
    '',
    ...(report.ledger.after.length ? report.ledger.after.map((name) => `- ${name}`) : ['- (non exécuté)']),
    '',
    '## Migration exécutée',
    '',
    ...(report.migration.executed.length ? report.migration.executed.map((name) => `- ${name}`) : ['- (non exécuté)']),
    '',
    '## Isolation TypeORM',
    '',
    `- DataSource isolé : ${report.migration.loadedInIsolatedDataSource.length === 0 ? 'non initialisé' : report.migration.loadedInIsolatedDataSource.join(', ')}`,
    `- Mode transactionnel : ${report.migration.transactionMode ?? 'non exécuté'}`,
    '',
    '## Sauvegarde',
    '',
    report.backup ? `- \`${report.backup.path}\` (${report.backup.bytes} octets, sha256 ${report.backup.sha256})` : '- Non fournie / non vérifiée',
    '',
    '## Échecs',
    '',
    ...(report.failures.length ? report.failures.map((item) => `- ${item}`) : ['- Aucun']),
    '',
    '## Avertissements',
    '',
    ...(report.warnings.length ? report.warnings.map((item) => `- ${item}`) : ['- Aucun']),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function connectionOptions(database) {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database,
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function tableExists(client, table) {
  const result = await client.query(
    'SELECT to_regclass($1) IS NOT NULL AS ok',
    [`public.${table}`],
  );
  return result.rows[0].ok;
}

async function snapshot(client) {
  const output = {};
  for (const table of SNAPSHOT_TABLES) {
    if (!(await tableExists(client, table))) {
      output[table] = null;
      continue;
    }
    const ignored = SNAPSHOT_IGNORED_COLUMNS[table] ?? [];
    const rowExpression = ignored.length === 0
      ? 'to_jsonb(row_data)'
      : `(to_jsonb(row_data) ${ignored.map((column) => `- '${column}'`).join(' ')})`;
    const row = (
      await client.query(
        `SELECT count(*)::bigint AS rows,
                md5(coalesce(string_agg(
                  ${rowExpression}::text,
                  '|'
                  ORDER BY ${rowExpression}::text
                ), '')) AS fingerprint
         FROM ${table} AS row_data`,
      )
    ).rows[0];
    output[table] = {
      rows: Number(row.rows),
      fingerprint: row.fingerprint,
    };
  }
  return output;
}

function validateEnvironment() {
  for (const key of ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE']) {
    ensure(Boolean(process.env[key]), `Variable d'environnement manquante : ${key}`);
  }
  ensure(
    process.env.NODE_ENV === 'development',
    `NODE_ENV doit valoir "development" (reçu : "${process.env.NODE_ENV ?? ''}")`,
  );
  ensure(
    process.env.DB_DATABASE === EXPECTED_DATABASE,
    `Base refusée : "${process.env.DB_DATABASE ?? ''}" (attendu : ${EXPECTED_DATABASE})`,
  );
  ensure(existsSync(PATCH_SQL), `Patch introuvable : ${PATCH_SQL}`);
  ensure(
    existsSync(MIGRATION_JS),
    `Build introuvable : ${MIGRATION_JS} — lancez "npm run build".`,
  );
}

async function preflight() {
  const client = new Client(connectionOptions(process.env.DB_DATABASE));
  await client.connect();

  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
    );

    const identity = (
      await client.query(
        `SELECT current_database() AS "currentDatabase",
                current_user AS "currentUser",
                current_setting('server_version') AS "serverVersion"`,
      )
    ).rows[0];
    report.database = identity;
    ensure(
      identity.currentDatabase === EXPECTED_DATABASE,
      `Base connectée inattendue : ${identity.currentDatabase}`,
    );

    const ledgerTable = (
      await client.query(
        `SELECT to_regclass('public.typeorm_migrations') IS NOT NULL AS ok`,
      )
    ).rows[0].ok;
    ensure(ledgerTable, 'Table typeorm_migrations introuvable.');

    const ledger = (
      await client.query('SELECT name FROM typeorm_migrations ORDER BY id')
    ).rows.map((row) => row.name);
    report.ledger.before = ledger;

    const duplicates = (
      await client.query(
        `SELECT name FROM typeorm_migrations
         GROUP BY name HAVING count(*) > 1 ORDER BY name`,
      )
    ).rows.map((row) => row.name);
    ensure(
      duplicates.length === 0,
      `Entrées dupliquées dans typeorm_migrations : ${duplicates.join(', ')}`,
    );
    ensure(
      !ledger.includes(MIGRATION_NAME),
      'La migration 027 est déjà enregistrée : rien à appliquer.',
    );

    const prerequisites = [
      {
        migration: 'ReservationNoShow1790856000013',
        label: '023 no-show',
        sql: `SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='reservations'
                  AND column_name='no_show_at'
              ) AS ok`,
      },
      {
        migration: 'AgencyCheckIn1790856000014',
        label: '024 agency check-in',
        sql: `SELECT
                (SELECT is_nullable='YES' FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='inspections'
                   AND column_name='fuel_level_pct') AND
                (SELECT is_nullable='YES' FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='inspections'
                   AND column_name='overall_condition') AS ok`,
      },
      {
        migration: 'SecureAgencyCheckIn1790856000015',
        label: '025 secure agency check-in',
        sql: `SELECT
                to_regclass('public.reservation_checkin_credentials') IS NOT NULL AND
                to_regclass('public.agency_staff_assignments') IS NOT NULL AND
                to_regclass('public.inspection_photos') IS NOT NULL AS ok`,
      },
      {
        migration: 'ReservationFinancialLedger1792704000000',
        label: '026 reservation financial ledger',
        sql: `SELECT
                EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='payments'
                          AND column_name='reservation_id' AND is_nullable='NO') AND
                EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='security_deposits'
                          AND column_name='reservation_id') AS ok`,
      },
    ];

    report.preflight.prerequisites = [];
    for (const prerequisite of prerequisites) {
      const ok = (await client.query(prerequisite.sql)).rows[0].ok;
      const inLedger = ledger.includes(prerequisite.migration);
      report.preflight.prerequisites.push({
        label: prerequisite.label,
        migration: prerequisite.migration,
        schemaOk: ok,
        recordedInLedger: inLedger,
      });
      ensure(ok, `Pré-requis schéma absent : ${prerequisite.label}`);
      if (!inLedger) {
        warnings.push(
          `Dérive de ledger : ${prerequisite.migration} absente du ledger alors que son schéma existe.`,
        );
      }
    }

    report.preflight.existing027Objects = [];
    report.preflight.objectClassification = {};
    for (const table of TABLES_CREATED_BY_027) {
      const exists = await tableExists(client, table);
      report.preflight.objectClassification[table] = { type: 'table', status: exists ? 'present' : 'absent' };
      if (exists) {
        report.preflight.existing027Objects.push(`table ${table}`);
        warnings.push(`Objet 027 déjà présent : table ${table} (schéma existant détecté)`);
      }
    }
    for (const sequence of SEQUENCES_CREATED_BY_027) {
      const exists = await tableExists(client, sequence);
      report.preflight.objectClassification[sequence] = { type: 'sequence', status: exists ? 'present' : 'absent' };
      if (exists) {
        report.preflight.existing027Objects.push(`sequence ${sequence}`);
        warnings.push(`Objet 027 déjà présent : sequence ${sequence}`);
      }
    }

    const columnPresent = (
      await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='rentals'
           AND column_name='return_fee_policy_snapshot') AS ok`,
      )
    ).rows[0].ok;
    report.preflight.returnFeePolicyColumnPresent = columnPresent;
    if (columnPresent) {
      warnings.push('rentals.return_fee_policy_snapshot existe déjà');
    }

    const conflictingIndexes = (
      await client.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname='public' AND indexname = ANY($1::text[])`,
        [INDEXES_CREATED_BY_027],
      )
    ).rows.map((row) => row.indexname);
    report.preflight.conflictingIndexes = conflictingIndexes;
    for (const idx of conflictingIndexes) {
      warnings.push(`Index 027 déjà présent : ${idx}`);
    }

    // Check critical column compatibility for existing tables
    const expectedColumns = {
      vehicle_returns: [
        'id','reference','rental_id','reservation_id','vehicle_id','customer_id','scenario',
        'scheduled_return_at','status','created_by','created_at','updated_at'
      ],
      return_inspections: ['id','return_id','rental_id'],
      return_evidence: ['id','return_id','storage_path','created_at'],
      return_damages: ['id','return_id','vehicle_zone','description','severity'],
      vehicle_preparations: ['id','reference','vehicle_id','status','created_by','created_at','updated_at'],
      preparation_cleaning_tasks: ['id','preparation_id','task_key'],
      preparation_events: ['id','preparation_id','seq','event_type'],
    };
    report.preflight.columnCompatibility = {};
    for (const [table, expected] of Object.entries(expectedColumns)) {
      if (!(await tableExists(client, table))) {
        report.preflight.columnCompatibility[table] = { status: 'absent' };
        continue;
      }
      const result = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      const present = new Set(result.rows.map(r => r.column_name));
      const missingCritical = expected.filter(c => !present.has(c));
      report.preflight.columnCompatibility[table] = {
        status: missingCritical.length === 0 ? 'compatible-or-extended' : 'incompatible-missing-critical',
        missingCritical,
      };
      if (missingCritical.length > 0) {
        fail(`Table ${table} existe mais manque des colonnes critiques 027 : ${missingCritical.join(', ')}`);
      }
    }

    const requiredConstraints = CONSTRAINTS_CREATED_BY_027;
    const existingConstraints = (
      await client.query(
        `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
        [requiredConstraints.flatMap(c => [c, ...(CONSTRAINT_ALIASES[c] || [])])]
      )
    ).rows.map(r => r.conname);
    report.preflight.constraintPresence = {};
    for (const c of requiredConstraints) {
      const aliases = CONSTRAINT_ALIASES[c] || [];
      const found = existingConstraints.includes(c) || aliases.some(a => existingConstraints.includes(a));
      report.preflight.constraintPresence[c] = found ? 'present-or-aliased' : 'missing-will-attempt-add';
      if (!found) {
        warnings.push(`Contrainte 027 attendue absente ou sous autre nom : ${c} (aliases: ${aliases.join(',') || 'aucun'}) - tentative d'ajout idempotente`);
      }
    }

    const duplicateInspections = (
      await client.query(
        `SELECT count(*)::int AS n FROM (
           SELECT rental_id, type FROM inspections
           GROUP BY rental_id, type HAVING count(*) > 1
         ) duplicates`,
      )
    ).rows[0].n;
    ensure(
      duplicateInspections === 0,
      `Inspections dupliquées (rental_id, type) : ${duplicateInspections}`,
    );
    report.preflight.duplicateInspections = duplicateInspections;

    report.preservation.before = await snapshot(client);

    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

async function verifyBackup() {
  if (DRY_RUN) return;
  if (SKIP_BACKUP_CHECK) {
    warnings.push('Contrôle de sauvegarde explicitement désactivé (--skip-backup-check).');
    return;
  }
  ensure(
    Boolean(BACKUP_PATH),
    'Sauvegarde obligatoire : fournir --backup <dump pg_dump> (ou --dry-run).',
  );
  if (!BACKUP_PATH) return;
  ensure(existsSync(BACKUP_PATH), `Sauvegarde introuvable : ${BACKUP_PATH}`);
  if (!existsSync(BACKUP_PATH)) return;
  const stats = statSync(BACKUP_PATH);
  ensure(stats.isFile(), `La sauvegarde n'est pas un fichier : ${BACKUP_PATH}`);
  ensure(stats.size > 0, `Sauvegarde vide : ${BACKUP_PATH}`);
  if (!stats.isFile() || stats.size === 0) return;
  report.backup = {
    path: BACKUP_PATH,
    bytes: stats.size,
    sha256: await sha256File(BACKUP_PATH),
  };
}

async function runIsolatedMigration() {
  const migrationModule = await import(pathToFileURL(MIGRATION_JS).href);
  const MigrationClass = migrationModule[MIGRATION_NAME];

  ensure(
    typeof MigrationClass === 'function',
    `Classe ${MIGRATION_NAME} introuvable dans ${MIGRATION_JS}`,
  );
  if (typeof MigrationClass !== 'function') return;

  const dataSource = new DataSource({
    type: 'postgres',
    ...connectionOptions(process.env.DB_DATABASE),
    entities: [],
    migrations: [MigrationClass],
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'all',
    logging: ['error', 'warn'],
  });

  await dataSource.initialize();
  try {
    const loaded = dataSource.migrations.map((migration) => migration.name);
    report.preflight.isolatedMigrations = loaded;
    report.migration.loadedInIsolatedDataSource = loaded;
    report.migration.transactionMode = 'all';
    ensure(
      loaded.length === 1 && loaded[0] === MIGRATION_NAME,
      `Le DataSource isolé contient ${loaded.length} migration(s) : ${loaded.join(', ')}`,
    );
    if (failures.length > 0) return;

    report.migration.attempted = true;
    const startedAt = Date.now();
    const executed = await dataSource.runMigrations({ transaction: 'all' });
    report.migration.durationMs = Date.now() - startedAt;
    report.migration.executed = executed.map((migration) => migration.name);

    ensure(
      executed.length === 1 && executed[0].name === MIGRATION_NAME,
      `Exécution inattendue : ${executed.length} migration(s) (${report.migration.executed.join(', ') || 'aucune'})`,
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

async function postVerify() {
  const client = new Client(connectionOptions(process.env.DB_DATABASE));
  await client.connect();

  try {
    report.ledger.after = (
      await client.query('SELECT name FROM typeorm_migrations ORDER BY id')
    ).rows.map((row) => row.name);

    const added = report.ledger.after.filter((name) => !report.ledger.before.includes(name));
    const removed = report.ledger.before.filter((name) => !report.ledger.after.includes(name));

    ensure(
      added.length === 1 && added[0] === MIGRATION_NAME,
      `Ledger : migrations ajoutées inattendues (${added.join(', ') || 'aucune'})`,
    );
    ensure(
      removed.length === 0,
      `Ledger : entrées supprimées (${removed.join(', ') || 'aucune'})`,
    );
    ensure(
      report.ledger.after.filter((name) => name === MIGRATION_NAME).length === 1,
      'Migration 027 enregistrée plusieurs fois.',
    );
    ensure(
      report.ledger.after.length === report.ledger.before.length + 1,
      'Le nombre total de migrations du ledger n’a pas augmenté de exactement 1.',
    );

    report.schema.tables = {};
    for (const table of TABLES_CREATED_BY_027) {
      report.schema.tables[table] = await tableExists(client, table);
      if (!report.schema.tables[table]) {
        fail(`Table manquante après migration : ${table}`);
      }
    }

    report.schema.sequences = {};
    for (const sequence of SEQUENCES_CREATED_BY_027) {
      report.schema.sequences[sequence] = await tableExists(client, sequence);
      if (!report.schema.sequences[sequence]) {
        fail(`Séquence manquante après migration : ${sequence}`);
      }
    }

    const indexes = (
      await client.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname='public' AND indexname = ANY($1::text[])`,
        [INDEXES_CREATED_BY_027],
      )
    ).rows.map((row) => row.indexname);
    report.schema.indexes = indexes;
    for (const index of INDEXES_CREATED_BY_027) {
      if (!indexes.includes(index)) {
        warnings.push(`Index 027 manquant ou vérification reportée : ${index}`);
      }
    }

    const constraints = (
      await client.query(
        `SELECT conname FROM pg_constraint
         WHERE conname = ANY($1::text[])`,
        [CONSTRAINTS_CREATED_BY_027.flatMap(c => [c, ...(CONSTRAINT_ALIASES[c] || [])])],
      )
    ).rows.map((row) => row.conname);
    report.schema.constraints = constraints;
    for (const constraint of CONSTRAINTS_CREATED_BY_027) {
      const aliases = CONSTRAINT_ALIASES[constraint] || [];
      const found = constraints.includes(constraint) || aliases.some(a => constraints.includes(a));
      if (!found) {
        warnings.push(`Contrainte 027 non trouvée sous nom attendu/alias : ${constraint}`);
      }
    }

    const column = (
      await client.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='rentals'
           AND column_name='return_fee_policy_snapshot'`,
      )
    ).rows[0];
    report.schema.returnFeePolicySnapshot = column ?? null;
    if (!column) {
      fail('rentals.return_fee_policy_snapshot toujours absente.');
    } else if (column?.data_type !== 'jsonb') {
      fail('return_fee_policy_snapshot n’est pas de type jsonb.');
    }

    const nullability = (
      await client.query(
        `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema='public' AND column_name IN ('mileage_km','fuel_level_pct')
           AND table_name IN ('inspections','return_inspections')`,
      )
    ).rows;
    report.schema.nullability = nullability;
    const expectedNullability = [
      'inspections.mileage_km',
      'inspections.fuel_level_pct',
      'return_inspections.mileage_km',
      'return_inspections.fuel_level_pct',
    ];
    const foundNullability = new Set(
      nullability.map((row) => `${row.table_name}.${row.column_name}`),
    );
    for (const key of expectedNullability) {
      if (!foundNullability.has(key)) {
        warnings.push(`Colonne manquante après migration : ${key}`);
      }
    }
    for (const row of nullability) {
      if (row.is_nullable !== 'YES') {
        warnings.push(`${row.table_name}.${row.column_name} devrait accepter NULL (vérification 027).`);
      }
    }

    const trigger = (
      await client.query(
        `SELECT pg_get_functiondef('trg_inspection_mileage()'::regprocedure) AS def`,
      )
    ).rows[0]?.def ?? '';
    report.schema.inspectionMileageTriggerUpdated =
      trigger.includes('NEW.mileage_km') || trigger.includes('start_km') || trigger.includes('handover');
    if (!report.schema.inspectionMileageTriggerUpdated) {
      warnings.push('La fonction trg_inspection_mileage n’a pas été mise à jour comme attendu.');
    }

    const triggerBinding = (
      await client.query(
        `SELECT count(*)::int AS n FROM pg_trigger
         WHERE tgname='trg_inspections_mileage' AND NOT tgisinternal`,
      )
    ).rows[0].n;
    report.schema.inspectionMileageTriggerBound = triggerBinding === 1;
    if (triggerBinding !== 1) {
      fail('Trigger trg_inspections_mileage manquant.');
    }

    const duplicateReturns = (
      await client.query(
        `SELECT count(*)::int AS n FROM (
           SELECT rental_id FROM vehicle_returns GROUP BY rental_id HAVING count(*) > 1
         ) duplicates`,
      )
    ).rows[0].n;
    if (duplicateReturns > 0) {
      fail(`Retours dupliqués par rental_id : ${duplicateReturns}`);
    }
    report.schema.duplicateReturns = duplicateReturns;

    report.preservation.after = await snapshot(client);
    for (const table of SNAPSHOT_TABLES) {
      const before = report.preservation.before?.[table];
      const after = report.preservation.after?.[table];
      if (!before || !after) continue;
      ensure(
        before.rows === after.rows,
        `Lignes modifiées dans ${table} : ${before.rows} → ${after.rows}`,
      );
      ensure(
        before.fingerprint === after.fingerprint,
        `Empreinte modifiée dans ${table}.`,
      );
    }

    report.financial = Object.fromEntries(
      FINANCIAL_TABLES.map((table) => [table, {
        before: report.preservation.before?.[table] ?? null,
        after: report.preservation.after?.[table] ?? null,
      }]),
    );
    for (const table of FINANCIAL_TABLES) {
      ensure(
        report.financial[table].before !== null,
        `Table financière introuvable avant migration : ${table}`,
      );
      ensure(
        report.financial[table].before?.fingerprint ===
          report.financial[table].after?.fingerprint,
        `Données financières modifiées dans ${table}.`,
      );
    }
  } finally {
    await client.end();
  }
}

async function main() {
  validateEnvironment();
  if (failures.length > 0) {
    report.verdict = 'aborted-before-write';
    return;
  }

  printBlock('BASE CIBLÉE', [
    `hôte      : ${process.env.DB_HOST}:${process.env.DB_PORT ?? 5432}`,
    `base      : ${process.env.DB_DATABASE}`,
    `NODE_ENV  : ${process.env.NODE_ENV}`,
    `mode      : ${DRY_RUN ? 'dry-run (aucune écriture)' : 'apply'}`,
  ]);

  await preflight();

  printBlock('LEDGER AVANT', report.ledger.before);
  printBlock('PRÉ-REQUIS', (report.preflight.prerequisites || []).map(
    (item) => `${item.schemaOk ? 'OK ' : 'KO '} ${item.label} — ledger: ${item.recordedInLedger ? 'présent' : 'ABSENT'}`,
  ));
  if (report.preflight.existing027Objects && report.preflight.existing027Objects.length > 0) {
    printBlock('OBJETS 027 DÉJÀ PRÉSENTS (détectés)', report.preflight.existing027Objects);
  }

  if (failures.length > 0) {
    report.verdict = DRY_RUN ? 'dry-run-with-blocking-conflicts' : 'aborted-before-write';
    return;
  }

  await verifyBackup();
  if (failures.length > 0) {
    report.verdict = 'aborted-before-write';
    return;
  }

  if (DRY_RUN) {
    if (failures.length === 0) {
      report.verdict = 'dry-run-ok';
    } else {
      report.verdict = 'dry-run-with-blocking-conflicts';
    }
    return;
  }

  await runIsolatedMigration();
  if (failures.length > 0) {
    report.verdict = report.migration.executed.length > 0
      ? 'applied-with-verification-error'
      : 'aborted-before-write';
    return;
  }

  await postVerify();
  report.verdict = failures.length === 0 ? 'applied-verified' : 'applied-with-failures';
}

try {
  await main();
} catch (error) {
  fail('Exception non gérée', error instanceof Error ? error.stack ?? error.message : String(error));
  if (report.migration.executed.length > 0) {
    report.verdict = 'applied-with-verification-error';
  } else if (report.migration.attempted) {
    report.verdict = 'migration-failed-rolled-back';
  } else {
    report.verdict = report.verdict === 'not-run' ? 'aborted' : report.verdict;
  }
}

const paths = writeReports();

console.log('');
console.log('='.repeat(64));
console.log(`VERDICT : ${report.verdict}`);
if (report.migration.loadedInIsolatedDataSource.length) {
  console.log(`MIGRATIONS CHARGÉES (isolées) : ${report.migration.loadedInIsolatedDataSource.join(', ')}`);
  console.log(`TRANSACTION : ${report.migration.transactionMode}`);
}
if (report.migration.executed.length) {
  console.log(`MIGRATION EXÉCUTÉE : ${report.migration.executed.join(', ')}`);
}
if (failures.length) {
  console.log('');
  console.log('ÉCHECS BLOQUANTS :');
  for (const failure of failures) console.log(`  ✗ ${failure}`);
}
if (warnings.length) {
  console.log('');
  console.log('AVERTISSEMENTS :');
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
console.log('');
console.log(`Rapport JSON : ${paths.jsonPath}`);
console.log(`Rapport MD   : ${paths.mdPath}`);
console.log('='.repeat(64));

if (failures.length > 0) process.exitCode = 1;
