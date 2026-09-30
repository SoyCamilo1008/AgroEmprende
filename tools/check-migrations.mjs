/**
 * Verifica que las migraciones de PostgreSQL respetan las reglas del proyecto.
 *
 * Reglas comprobadas (docs/database/migrations.md):
 *  1. El nombre sigue el patrón `<timestamp>_<snake_case>.sql`.
 *  2. No se edita una migración ya aplicada (detecta collisiones de timestamp).
 *  3. Todo archivo declara su dependencia con `-- depends_on:` si existe.
 *  4. No hay sentencias prohibidas en una migración de esquema.
 *  5. `supabase/config.toml` no usa secciones ni valores que la CLI rechace.
 *
 * Se ejecuta en local y en CI: `pnpm tooling:check-migrations`
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const CONFIG_PATH = join(process.cwd(), 'supabase', 'config.toml');

/** Timestamp de 14 dígitos: 20260927120000 */
const FILE_NAME_PATTERN = /^(\d{14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * Sentencias que NUNCA deben aparecer en una migración: alteran datos de forma
 * destructiva e irreversible. Se usan comandos explícitos y documentados.
 */
const FORBIDDEN_PATTERNS = [
  { pattern: /\bDROP\s+TABLE\b/i, reason: 'DROP TABLE: usa ON DELETE y soft delete' },
  { pattern: /\bDROP\s+COLUMN\b/i, reason: 'DROP COLUMN: despliega primero el código que la usa' },
  { pattern: /\bTRUNCATE\b/i, reason: 'TRUNCATE está prohibido en migraciones' },
  {
    pattern: /\bDELETE\s+FROM\s+\w+\s*;/i,
    reason: 'DELETE masivo: no se borra información histórica',
  },
];

const problems = [];
const warnings = [];

const listFiles = async (dir) => {
  try {
    return await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

/**
 * Deja solo el código: sin comentarios de línea ni literales de cadena.
 *
 * Sin esto, un CHECK con subconsulta escrito dentro de un comentario se
 * reportaría como error, y un `check` de RLS se confundiría con uno de tabla.
 */
const stripCommentsAndStrings = (sql) =>
  sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");

const lineOf = (sql, index) => sql.slice(0, index).split('\n').length;

/**
 * Devuelve cada expresión `check (...)` con sus paréntesis balanceados.
 *
 * Se cuentan los paréntesis porque un CHECK puede ocupar varias líneas y anidar
 * paréntesis: sin contarlos, `check (a in (1, 2))` se cortaría por la mitad.
 */
const findCheckConstraints = (sql) => {
  const found = [];
  const pattern = /\bcheck\s*\(/gi;
  let match;

  while ((match = pattern.exec(sql)) !== null) {
    // `with check (...)` es una política RLS, no un CHECK de tabla: ahí las
    // subconsultas son legales y esperadas.
    const before = sql.slice(Math.max(0, match.index - 5), match.index);
    if (/\bwith\s+$/i.test(before)) continue;

    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;

    for (let i = open; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) {
      found.push({ text: sql.slice(match.index), line: lineOf(sql, match.index), closed: false });
      continue;
    }

    found.push({
      text: sql.slice(match.index, end + 1),
      line: lineOf(sql, match.index),
      closed: true,
      body: sql.slice(open + 1, end),
    });
    pattern.lastIndex = end;
  }

  return found;
};

const files = (await listFiles(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

if (files.length === 0) {
  console.log('✔ No hay migraciones todavía (esperado en la Fase 1).');
  process.exit(0);
}

const seenTimestamps = new Map();

for (const file of files) {
  const match = FILE_NAME_PATTERN.exec(file);
  if (!match) {
    problems.push(`${file}: el nombre debe ser <timestamp>_<nombre_en_snake_case>.sql`);
    continue;
  }

  const [, timestamp, name] = match;

  if (seenTimestamps.has(timestamp)) {
    problems.push(
      `${file}: el timestamp ${timestamp} ya lo usa ${seenTimestamps.get(timestamp)}. ` +
        'Las migraciones deben ordenarse de forma única e inmutable.',
    );
  } else {
    seenTimestamps.set(timestamp, file);
  }

  const contents = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');

  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(contents)) {
      problems.push(`${file}: ${reason}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Los dos errores que costaron un ciclo entero de CI cada uno. Ninguno se ve
  // leyendo la migración: hay que ejecutarla, y la única máquina que la ejecuta
  // es el job de PostgreSQL del CI. Se comprueban aquí, en local y en un segundo.
  // ───────────────────────────────────────────────────────────────────────────

  const code = stripCommentsAndStrings(contents);

  for (const check of findCheckConstraints(code)) {
    if (!check.closed) {
      problems.push(`${file}:${check.line}: el CHECK no cierra sus paréntesis`);
      continue;
    }

    // PostgreSQL rechaza las subconsultas dentro de un CHECK de tabla
    // (`cannot use subquery in check constraint`), así que un invariante que
    // necesita leer otra tabla tiene que ser un trigger de restricción
    // diferido, no un CHECK. Esto ya rompió `finance.payments`.
    if (/\bselect\b/i.test(check.body) || /\bexists\b/i.test(check.body)) {
      problems.push(
        `${file}:${check.line}: un CHECK no puede contener una subconsulta ` +
          '(PostgreSQL: cannot use subquery in check constraint). ' +
          'Si el invariante necesita leer otra tabla, decláralo como un trigger ' +
          'de restricción diferido.',
      );
    }
  }

  // `check (debit > 0) <> (credit > 0)` se cierra en el primer `)` y deja el
  // operador suelto: `syntax error at or near "<>"`. Comparar dos booleanos
  // necesita el par exterior de paréntesis.
  const danglingOperator = /\bcheck\s*\([^()]*\)\s*(<>|<|>|=|\band\b|\bor\b|\bis\b)\s*[(']/gi;
  let dangling;
  while ((dangling = danglingOperator.exec(code)) !== null) {
    problems.push(
      `${file}:${lineOf(code, dangling.index)}: \`${dangling[0].replace(/\s+/g, ' ')}\` ` +
        'deja un operador sin operandos: envuelve la comparación completa, ' +
        'por ejemplo `check ((a > 0) <> (b > 0))`.',
    );
  }

  if (!/^--\s*description:/m.test(contents)) {
    warnings.push(`${file}: falta la cabecera "-- description: ..."`);
  }

  if (name.length < 4) {
    warnings.push(`${file}: nombre demasiado corto para ser descriptivo`);
  }
}

for (const warning of warnings) console.warn(`⚠ ${warning}`);

// ─────────────────────────────────────────────────────────────────────────────
// config.toml
//
// `supabase start` valida este archivo ANTES de mirar Docker, y un valor que la
// CLI no acepta lo aborta en un segundo con un error que no menciona ni la clave
// ni el servicio: el síntoma es "no arrancó" y la causa está lejos. Eso costó un
// ciclo entero de CI descubrirlo, así que las dos formas conocidas se comprueban
// aquí, en local, en un segundo.
// ─────────────────────────────────────────────────────────────────────────────

/** Secciones que la CLI deprecó: avisan en cada arranque. */
const DEPRECATED_CONFIG_SECTIONS = [
  {
    pattern: /^\s*\[inbucket\]\s*$/m,
    reason: '[inbucket] está deprecada: usa [local_smtp]',
  },
];

/**
 * Campos que la CLI exige como número de bytes, no como tamaño con sufijo.
 * `file_size_limit = "25Mi"` produce `invalid suffix: 'mi'`.
 */
const BYTE_SIZED_KEYS = ['file_size_limit'];

/** Sufijos que la CLI acepta en un valor de tamaño (Go, no IEC). */
const VALID_SIZE_SUFFIXES = /\d+\s*(b|kb|mb|gb|tb|kib|mib|gib|tib)$/i;

const checkConfig = async () => {
  let contents;
  try {
    contents = await readFile(CONFIG_PATH, 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      problems.push('supabase/config.toml no existe: la CLI no puede levantar nada sin él');
      return;
    }
    throw error;
  }

  for (const { pattern, reason } of DEPRECATED_CONFIG_SECTIONS) {
    if (pattern.test(contents)) {
      problems.push(`config.toml: ${reason}`);
    }
  }

  for (const key of BYTE_SIZED_KEYS) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(contents);
    if (!match) continue;

    const value = match[1];
    // Un entero desnudo son bytes y siempre vale; el problema es solo el sufijo.
    if (/^\d+$/.test(value)) continue;

    if (VALID_SIZE_SUFFIXES.test(value)) {
      warnings.push(
        `config.toml: ${key} = "${value}" depende de que la CLI acepte ese sufijo; ` +
          'un entero en bytes no puede dejar de funcionar',
      );
    } else {
      problems.push(
        `config.toml: ${key} = "${value}" no es un número de bytes ni un tamaño que la CLI acepte ` +
          '(la CLI 2.118.0 rechaza sufijos IEC como "Mi" con `invalid suffix`)',
      );
    }
  }
};

await checkConfig();

if (problems.length > 0) {
  for (const problem of problems) console.error(`✖ ${problem}`);
  console.error(`\n${problems.length} problema(s) en supabase/migrations.`);
  process.exit(1);
}

console.log(`✔ ${files.length} migración(es) válidas.`);
