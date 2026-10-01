/**
 * Errores de dominio de la capa de datos.
 *
 * Por qué una taxonomía propia
 * ---------------------------
 * supabase-js devuelve errores con la forma de PostgREST: `{ code, message,
 * details, hint }`, donde `code` es un código SQL de cinco caracteres. Si ese
 * código llega a las pantallas, cada uno tiene que saber qué significa
 * `23505`, y tarde o temprano alguien lo compara a mano y se equivoca.
 *
 * Aquí se traduce una vez a clases que el resto del código puede preguntar:
 * ¿le puedo mostrar un formulario con errores? ¿debo pedir login? ¿debo
 * recargar la lista? El código original se conserva en `code`, así que el
 * diagnóstico técnico no se pierde.
 *
 * Lo que NO se hace aquí: decidir permisos. `authorization` significa que
 * PostgreSQL dijo que no, y por qué lo dijo es cosa de las políticas RLS, no
 * del repositorio.
 */

/** Familia del fallo, Independent del proveedor. */
export type DomainErrorKind =
  'validation' | 'authorization' | 'not_found' | 'conflict' | 'database' | 'unexpected';

export interface DomainErrorOptions {
  /** Código original de PostgREST/PostgreSQL, si lo hubo. */
  readonly code?: string | undefined;
  readonly details?: unknown;
  readonly hint?: string | undefined;
  readonly constraint?: string | undefined;
  readonly cause?: unknown;
}

const DEFAULT_MESSAGES: Readonly<Record<DomainErrorKind, string>> = {
  validation: 'Los datos no son válidos',
  authorization: 'No tienes permiso para hacer eso',
  not_found: 'No se encontró',
  conflict: 'Ya existe algo con esos datos',
  database: 'Error de base de datos',
  unexpected: 'Error inesperado',
};

/**
 * Error de dominio: algo falló y la app sabe QUÉ clase de fallo es.
 *
 * `instanceof` funciona entre Web y Mobile porque ambos consumen este mismo
 * módulo; la única regla es no duplicar la clase en otro archivo.
 */
export class DomainError extends Error {
  readonly kind: DomainErrorKind;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly hint: string | undefined;
  readonly constraint: string | undefined;

  constructor(kind: DomainErrorKind, message?: string, options: DomainErrorOptions = {}) {
    super(message ?? DEFAULT_MESSAGES[kind], { cause: options.cause });
    this.name = 'DomainError';
    this.kind = kind;
    this.code = options.code;
    this.details = options.details;
    this.hint = options.hint;
    this.constraint = options.constraint;
  }
}

export const isDomainError = (value: unknown): value is DomainError => value instanceof DomainError;

/** Atajo para no repetir `new DomainError('...')` en el repositorio. */
export const domainError = (
  kind: DomainErrorKind,
  message?: string,
  options?: DomainErrorOptions,
) => new DomainError(kind, message, options);

/** Forma del error que devuelve PostgREST. Deliberadamente la mínima. */
export interface PostgrestErrorLike {
  readonly message: string | null;
  readonly details?: string | null;
  readonly hint?: string | null;
  readonly code?: string | null;
}

export const isPostgrestErrorLike = (value: unknown): value is PostgrestErrorLike => {
  if (typeof value !== 'object' || value === null) return false;
  if (value instanceof Error) return false;
  const candidate = value as Record<string, unknown>;
  // Un `Error` de JavaScript tiene `message` pero ningún `code` de SQL. Aceptar
  // solo el que trae `code` evita clasificar un fallo de red ("Failed to fetch")
  // como si fuera un error de base de datos.
  return typeof candidate['code'] === 'string' && candidate['code'].length > 0;
};

/**
 * Traduce un error de PostgreSQL a la familia de dominio.
 *
 * La tabla es explícita a propósito: si mañana se cae un `23503` en una
 * pantalla y se traduce a `database`, se añade aquí su entrada y no se
 * reescribe el manejo de errores en toda la app.
 *
 * `23503` (foreign key) es `validation` y no `conflict` a propósito: el cliente
 * no puede corregir la fila ajena desde el formulario, pero sí puede entender
 * "ese cliente no existe en tu organización" y corregirse.
 */
const codeToKind = (code: string | null | undefined): DomainErrorKind => {
  switch (code) {
    // Sin fila. `PGRST116` es lo que devuelve `.single()` cuando no hay nada;
    // en lecturas con RLS también llega como cero filas, no como error.
    case 'PGRST116':
      return 'not_found';
    // Permiso insuficiente: RLS denegó o falta el permiso del rol.
    case '42501':
      return 'authorization';
    // Violaciones de integridad y de tipo.
    case '23505':
      return 'conflict';
    case '23503':
    case '23502':
    case '23514':
    case '22P02':
      return 'validation';
    // `invalid_parameter_value`. La usa `derive_partner_organization` para decir
    // "no hay organización activa". Para la app no es una consulta mal escrita:
    // es que el usuario no puede escribir hasta que elija organización.
    case '22023':
      return 'authorization';
    default:
      return 'database';
  }
};

/**
 * Convierte cualquier fallo de la consulta en `DomainError`.
 *
 * `null` se convierte en `not_found` porque es lo que significa cuando RLS
 * filtra la fila: la política no lanza error, simplemente no la devuelve, y el
 * repositorio no puede distinguir "no existe" de "no es tuya". Decir `not_found`
 * en ambos casos además evita confirmar la existencia de datos ajenos.
 */
export const translatePostgrestError = (error: unknown): DomainError => {
  if (isDomainError(error)) return error;

  if (error === null || error === undefined) {
    return domainError('not_found');
  }

  if (isPostgrestErrorLike(error)) {
    const code = error.code ?? null;
    const kind = codeToKind(code);
    return new DomainError(kind, error.message ?? undefined, {
      code: code ?? undefined,
      details: error.details ?? undefined,
      hint: error.hint ?? undefined,
    });
  }

  if (error instanceof Error) {
    // Fallos de red o de transporte: no son de la base de datos aunque vengan
    // de una consulta. Sin código SQL no se puede afirmar más.
    return domainError('unexpected', error.message, { cause: error });
  }

  // Un objeto suelto con `message` y sin `code`: se conserva el mensaje para que
  // el diagnóstico no se pierda, pero no se le atribuye un origen.
  if (typeof error === 'object' && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === 'string' && message !== '') {
      return domainError('unexpected', message);
    }
  }

  if (typeof error === 'string' && error !== '') {
    return domainError('unexpected', error);
  }

  return domainError('unexpected');
};

/**
 * Envuelve un `DomainError` que ya es nuestro para conservar el `cause` cuando
 * se relanza desde un `catch`.
 */
export const rethrowAsDomainError = (error: unknown): never => {
  throw translatePostgrestError(error);
};
