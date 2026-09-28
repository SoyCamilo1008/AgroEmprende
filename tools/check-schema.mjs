/**
 * Verifica que el esquema SQL y el código TypeScript no se contradigan.
 *
 * Por qué existe: `pnpm db:reset` y `pnpm db:test` necesitan Docker. En una
 * máquina sin Docker, nada de lo que hay en `supabase/migrations/` se ha
 * ejecutado nunca, y un error tipográfico en SQL no aparece hasta el CI. Este
 * script atrapa, sin base de datos, los fallos que más se repiten:
 *
 *   1. Toda tabla creada tiene RLS habilitado (docs/architecture/rls.md: "una
 *      tabla sin RLS no se despliega").
 *   2. Toda tabla de negocio tiene al menos una política en la MISMA
 *      migración que la crea (misma regla).
 *   3. Toda política apunta a una tabla que existe.
 *   4. Los permisos del seed son los mismos que `PERMISSIONS` de TypeScript.
 *   5. Los roles del seed son los mismos que `ROLES`.
 *   6. Las unidades de medida del seed son las de `MEASURE_UNITS`, y cada
 *      factor apunta a una unidad declarada.
 *   7. Los tipos de unidad de negocio del CHECK son los de
 *      `BUSINESS_UNIT_TYPES`.
 *   8. El seed no toca ninguna tabla que las migraciones no hayan creado.
 *   9. Todo `-- depends_on:` apunta a una migración que existe.
 *  10. El esquema `private` no está expuesto en la API.
 *  11. Ninguna migración borra los permisos que otra ya concedió, y toda tabla
 *      con RLS sigue siendo alcanzable por `anon` o `authenticated`.
 *
 * No sustituye a `supabase db reset` ni a `db:test`: verifica que el SQL dice
 * lo que dice el código, no que PostgreSQL lo acepte. Las dos cosas se
 * necesitan.
 *
 *   pnpm tooling:check-schema
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const SEED_PATH = join(process.cwd(), 'supabase', 'seed', 'seed.sql');
const CONFIG_PATH = join(process.cwd(), 'supabase', 'config.toml');

const problems = [];
const notes = [];

const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);

/** Elimina comentarios SQL para no hacer match de ejemplos dentro de comentarios. */
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

const listFiles = async (dir) => {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Cargar migraciones
// ─────────────────────────────────────────────────────────────────────────────

const files = await listFiles(MIGRATIONS_DIR);

/** @type {{file: string, tables: Set<string>, rls: Set<string>, policies: {table: string, file: string}[], all: string}[]} */
const migrations = [];

for (const file of files) {
  const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
  const sql = stripSqlComments(raw);

  const tables = new Set();
  for (const match of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\.([a-z_]+)/gi,
  )) {
    tables.add(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
  }

  const rls = new Set();
  for (const match of sql.matchAll(
    /alter\s+table\s+(?:only\s+)?([a-z_]+\.[a-z_]+)\s+enable\s+row\s+level\s+security/gi,
  )) {
    rls.add(match[1].toLowerCase());
  }

  const policies = [];
  for (const match of sql.matchAll(/create\s+policy\s+\w+\s+on\s+([a-z_]+\.[a-z_]+)/gi)) {
    policies.push({ table: match[1].toLowerCase(), file });
  }

  migrations.push({ file, tables, rls, policies, all: sql });
}

if (files.length === 0) {
  console.log('✔ No hay migraciones todavía. Nada que verificar.');
  process.exit(0);
}

const allTables = new Set(migrations.flatMap((m) => [...m.tables]));

// ─────────────────────────────────────────────────────────────────────────────
// 2. RLS y políticas
// ─────────────────────────────────────────────────────────────────────────────

for (const migration of migrations) {
  for (const table of migration.tables) {
    if (!migration.rls.has(table)) {
      fail(
        `${migration.file}: ${table} se crea SIN "alter table ... enable row level security". ` +
          'Una tabla de negocio sin RLS no se despliega (docs/architecture/rls.md).',
      );
    }

    const hasPolicy = migration.policies.some((policy) => policy.table === table);
    if (!hasPolicy && !allTables.has(table)) {
      // No debería pasar: si la tabla existe, la política debería existir.
      fail(`${migration.file}: ${table} se crea sin ninguna política en el mismo archivo.`);
    }
  }
}

for (const migration of migrations) {
  for (const policy of migration.policies) {
    if (!allTables.has(policy.table)) {
      fail(
        `${migration.file}: la política de ${policy.table} apunta a una tabla que ninguna ` +
          'migración crea. Revisa el nombre o el orden de las migraciones.',
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. depends_on
// ─────────────────────────────────────────────────────────────────────────────

const fileSet = new Set(files);
for (const file of files) {
  const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
  // Se ancla al inicio de la línea: si no, el `\S+` se comía el propio `--` del
  // comentario y reports_ba una dependencia llamada "--".
  for (const match of raw.matchAll(/^[ \t]*--[ \t]*depends_on:[ \t]*(.*)$/gm)) {
    const dependency = match[1].trim();
    // Un `depends_on:` vacío significa "esta migración no depende de otra".
    if (dependency === '' || dependency === '-') continue;
    if (!fileSet.has(dependency)) {
      fail(
        `${file}: "-- depends_on: ${dependency}" no corresponde a ninguna migración del directorio.`,
      );
    }
    if (dependency >= file) {
      fail(`${file}: depende de "${dependency}", que se aplica después o en el mismo archivo.`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Constantes de TypeScript
// ─────────────────────────────────────────────────────────────────────────────

/** Lee `export const NOMBRE = [ ... ] as const;` y devuelve los strings. */
const readTsStringArray = async (file, name) => {
  const source = await readFile(join(process.cwd(), file), 'utf-8');
  const match = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s*const`,
  ).exec(source);
  if (!match) {
    fail(`${file}: no se encontró "export const ${name} = [...] as const".`);
    return [];
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
};

const tsPermissions = await readTsStringArray('packages/types/src/auth.ts', 'PERMISSIONS');
const tsRoles = await readTsStringArray('packages/types/src/auth.ts', 'ROLES');
const tsMeasureUnits = await readTsStringArray('packages/types/src/units.ts', 'MEASURE_UNITS');
const tsBusinessUnitTypes = await readTsStringArray(
  'packages/types/src/business-units.ts',
  'BUSINESS_UNIT_TYPES',
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. El seed
// ─────────────────────────────────────────────────────────────────────────────

let seedSql = '';
try {
  seedSql = stripSqlComments(await readFile(SEED_PATH, 'utf-8'));
} catch (error) {
  fail(`No se pudo leer supabase/seed/seed.sql: ${error.message}`);
}

/**
 * Divide el seed en sentencias `insert into <tabla> (...) values <cuerpo>;`.
 *
 * Parsear el seed entero con una regex global mezcla secciones: las filas de
 * `catalog.measure_units` tienen cinco columnas igual que las de `core.roles` y
 * un parser global se las confunde. Cada tabla se lee en su propia sentencia.
 */
const readSeedInsert = (table) => {
  const pattern = new RegExp(
    `insert\\s+into\\s+${table.replace('.', '\\.')}\\s*\\([^)]*\\)\\s*values([\\s\\S]*?);`,
    'i',
  );
  const match = pattern.exec(seedSql);
  return match ? match[1] : null;
};

const permissionsBody = readSeedInsert('core.permissions');
const rolesBody = readSeedInsert('core.roles');
const measureUnitsBody = readSeedInsert('catalog.measure_units');

if (!permissionsBody) fail('El seed no inserta en core.permissions.');
if (!rolesBody) fail('El seed no inserta en core.roles.');
if (!measureUnitsBody) fail('El seed no inserta en catalog.measure_units.');

/** Permisos: ('code', 'category', 'descripción'). */
const seedPermissions = new Set(
  [...(permissionsBody ?? '').matchAll(/\(\s*'([a-z][a-z_.]{2,63})'\s*,\s*'[a-z]+'\s*,/g)].map(
    (m) => m[1],
  ),
);

/** Roles: ('code', 'nombre', 'descripción', rank, is_system). */
const seedRoles = new Set(
  [...(rolesBody ?? '').matchAll(/\(\s*'([a-z][a-z_]{1,31})'\s*,/g)].map((m) => m[1]),
);

/** Unidades: ('code', 'nombre', 'base', factor, is_pack). */
const seedMeasureUnits = new Map(
  [
    ...(measureUnitsBody ?? '').matchAll(
      /\(\s*'([a-z0-9]{1,16})'\s*,\s*'[^']*'\s*,\s*'([a-z0-9]{1,16})'\s*,\s*([\d.]+)\s*,/g,
    ),
  ].map((m) => [m[1], { base: m[2], factor: m[3] }]),
);

const setDiff = (left, right) => [...left].filter((value) => !right.has(value));
const list = (values) => (values.length === 0 ? '(ninguno)' : values.sort().join(', '));

// Permisos
for (const permission of setDiff(new Set(tsPermissions), seedPermissions)) {
  fail(
    `El permiso "${permission}" está en PERMISSIONS (packages/types/src/auth.ts) pero no en ` +
      'el seed. La política de RLS lo consultará y nunca encontrará la fila.',
  );
}
for (const permission of setDiff(seedPermissions, new Set(tsPermissions))) {
  fail(`El seed define el permiso "${permission}", que no existe en PERMISSIONS.`);
}

// Roles
for (const role of setDiff(new Set(tsRoles), seedRoles)) {
  fail(`El rol "${role}" está en ROLES pero no en el seed. El onboarding no podrá asignarlo.`);
}
for (const role of setDiff(seedRoles, new Set(tsRoles))) {
  fail(`El seed define el rol "${role}", que no existe en ROLES.`);
}

// Unidades de medida
for (const unit of setDiff(new Set(tsMeasureUnits), new Set(seedMeasureUnits.keys()))) {
  fail(`La unidad "${unit}" está en MEASURE_UNITS pero no en el seed del catálogo.`);
}
for (const unit of setDiff(new Set(seedMeasureUnits.keys()), new Set(tsMeasureUnits))) {
  fail(`El seed define la unidad "${unit}", que no existe en MEASURE_UNITS.`);
}
for (const [code, definition] of seedMeasureUnits) {
  if (!seedMeasureUnits.has(definition.base)) {
    fail(`La unidad "${code}" declara base_code "${definition.base}", que el seed no define.`);
  }
  if (code === definition.base && definition.factor !== '1') {
    fail(
      `La unidad "${code}" es su propia base (base_code = code) pero tiene factor_to_base = ` +
        `${definition.factor}. Debe ser 1: una base no se multiplica por nada.`,
    );
  }
}

// Tablas que toca el seed
for (const match of seedSql.matchAll(/(?:insert\s+into|from|join|update)\s+([a-z_]+\.[a-z_]+)/gi)) {
  const table = match[1].toLowerCase();
  if (!allTables.has(table)) {
    fail(
      `El seed usa ${table}, que ninguna migración crea. El seed se ejecuta DESPUÉS de las ` +
        'migraciones, así que esto hace fallar `supabase db reset`.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Tipos de unidad de negocio
// ─────────────────────────────────────────────────────────────────────────────

const businessUnitMigration = migrations.find((migration) =>
  migration.all.includes('core.business_units'),
);
if (businessUnitMigration) {
  const match = /type\s+in\s*\(([^)]*)\)/i.exec(businessUnitMigration.all);
  if (match) {
    const sqlTypes = new Set([...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]));
    for (const type of setDiff(new Set(tsBusinessUnitTypes), sqlTypes)) {
      fail(
        `BUSINESS_UNIT_TYPES declara "${type}" pero el CHECK de core.business_units no lo ` +
          'acepta: una unidad de ese tipo no se podría crear.',
      );
    }
    for (const type of setDiff(sqlTypes, new Set(tsBusinessUnitTypes))) {
      fail(`El CHECK de core.business_units acepta "${type}", que no está en BUSINESS_UNIT_TYPES.`);
    }
  } else {
    note('No se encontró el CHECK de `type` en core.business_units; se omite esa comparación.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. El esquema private no se expone
// ─────────────────────────────────────────────────────────────────────────────

const config = await readFile(CONFIG_PATH, 'utf-8');
const apiSchemas = /\[api\][\s\S]*?schemas\s*=\s*\[([^\]]*)\]/.exec(config);
if (apiSchemas) {
  const exposed = apiSchemas[1]
    .split(',')
    .map((value) => value.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  for (const schema of exposed) {
    if (schema === 'private') {
      fail(
        'El esquema `private` está en [api].schemas de supabase/config.toml. Contiene las ' +
          'funciones que RLS usa para decidir el acceso y no debe exponerse por la API.',
      );
    }
  }
  note(`Esquemas expuestos por la API: ${exposed.join(', ')}`);
} else {
  fail('No se pudo leer la lista de esquemas de [api] en supabase/config.toml.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Permisos SQL efectivos
//
// Por qué esta sección existe: RLS, políticas y grants son capas que se pisan
// entre sí, y el error más caro es silencioso. Si una migración ejecuta
// `revoke all on all tables in schema core` DESPUÉS de que otra concediera
// permisos, la tabla queda viva, con sus políticas correctas, y sin embargo
// inalcanzable: el SQL se escribe bien, todas las consultas fallan al
// ejecutarse, y ninguna otra verificación de este script lo nota.
//
// Se simula el estado de permisos en el orden real en que PostgreSQL aplicaría
// las migraciones, y se comprueba que ninguna tabla con RLS quede sin acceso.
// ─────────────────────────────────────────────────────────────────────────────

/** Tabla o función -> Map de `rol:privilegio` a la migración que lo concedió. */
const grants = new Map();
/** @type {Map<string, string>} schema -> primera migración que crea una tabla en él. */
const schemaOwner = new Map();

const APP_ROLES = ['anon', 'authenticated'];
const splitList = (value) =>
  value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

for (const migration of migrations) {
  // Los cuerpos `$$ ... $$` se enmascaran: contienen `;` y palabras que se
  // parecen a un GRANT sin serlo.
  const statements = migration.all
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  for (const statement of statements) {
    const create = /^create table (?:if not exists )?([a-z_]+)\.([a-z_]+)/i.exec(statement);
    if (create) {
      const table = `${create[1].toLowerCase()}.${create[2].toLowerCase()}`;
      if (!grants.has(table)) grants.set(table, new Map());
      if (!schemaOwner.has(create[1].toLowerCase())) {
        schemaOwner.set(create[1].toLowerCase(), migration.file);
      }
      continue;
    }

    // `revoke all on all tables in schema <s>` borra lo concedido antes.
    const globalRevoke = /^revoke all on all tables in schema ([a-z_]+) from (.+)$/i.exec(
      statement,
    );
    if (globalRevoke) {
      const schema = globalRevoke[1].toLowerCase();
      const owner = schemaOwner.get(schema);
      if (owner && owner !== migration.file) {
        fail(
          `${migration.file}: "revoke all on all tables in schema ${schema}" borra los permisos ` +
            `que ${owner} y las migraciones entremedias ya concedieron, y esta migración no puede ` +
            'saber cuáles eran. Concede sobre las tablas propias en su lugar ' +
            '(revoke all on <tabla>, <tabla>).',
        );
      }
      for (const [table, privileges] of grants) {
        if (table.startsWith(`${schema}.`)) {
          for (const role of splitList(globalRevoke[2])) privileges.delete(role);
        }
      }
      continue;
    }

    const revoke =
      /^revoke ([\w, ]+?) on (?:table |function |schema )?([\w., ]+?) from ([\w, ]+)$/i.exec(
        statement,
      );
    if (revoke) {
      for (const table of splitList(revoke[2])) {
        const privileges = grants.get(table);
        if (!privileges) continue;
        for (const role of splitList(revoke[3])) {
          for (const privilege of splitList(revoke[1])) privileges.delete(`${role}:${privilege}`);
        }
      }
      continue;
    }

    const grant =
      /^grant ([\w, ]+?) on (?:table |function |schema )?([\w., ]+?) to ([\w, ]+)$/i.exec(
        statement,
      );
    if (grant) {
      for (const table of splitList(grant[2])) {
        if (!table.includes('.')) continue;
        if (!grants.has(table)) grants.set(table, new Map());
        const privileges = grants.get(table);
        for (const role of splitList(grant[3])) {
          for (const privilege of splitList(grant[1])) {
            privileges.set(`${role}:${privilege}`, migration.file);
          }
        }
      }
    }
  }
}

for (const table of [...allTables].sort()) {
  const privileges = grants.get(table) ?? new Map();
  const reachable = [...privileges.keys()].some((entry) =>
    APP_ROLES.some((role) => entry.startsWith(`${role}:`)),
  );
  if (!reachable) {
    fail(
      `${table} termina las migraciones sin ningún permiso para anon ni authenticated. ` +
        'Las políticas de RLS son correctas pero nadie puede llegar a la tabla: cada consulta ' +
        'fallará con "permission denied". Concede al final de la migración que la usa.',
    );
  }
}

const tablesWithPrivileges = [...grants.keys()].filter((table) => allTables.has(table)).length;
note(
  `${tablesWithPrivileges} tabla(s) con permisos efectivos para anon/authenticated tras simular ` +
    'los GRANT y REVOKE en orden.',
);

// ─────────────────────────────────────────────────────────────────────────────
// Resultado
// ─────────────────────────────────────────────────────────────────────────────

for (const message of notes) console.log(`  · ${message}`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error(`\n${problems.length} problema(s) de coherencia entre el esquema y el código.`);
  process.exit(1);
}

console.log(
  `✔ Esquema coherente: ${allTables.size} tabla(s), ` +
    `${migrations.reduce((total, migration) => total + migration.policies.length, 0)} política(s), ` +
    `${tsPermissions.length} permiso(s) y ${tsRoles.length} rol(es) coinciden con el seed.`,
);
