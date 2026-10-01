/**
 * Traducción de errores de PostgreSQL a la taxonomía de dominio.
 *
 * Lo que se prueba aquí es una TABLA de equivalencias. Su valor no está en que
 * el mapa sea correcto hoy, sino en que mañana, cuando aparezca un `23503` en una
 * pantalla, se sabe dónde mirarlo.
 */
import { describe, expect, it } from 'vitest';
import { DomainError, isDomainError, translatePostgrestError } from '../src/errors';

describe('errores de dominio: construcción', () => {
  it('es un Error, para que un catch genérico siga funcionando', () => {
    const error = new DomainError('conflict');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainError');
  });

  it('un kind sin mensaje propio recibe uno legible', () => {
    expect(new DomainError('not_found').message).toBe('No se encontró');
    expect(new DomainError('authorization').message).toBe('No tienes permiso para hacer eso');
  });

  it('un mensaje propio gana al de la familia', () => {
    expect(new DomainError('validation', 'El nombre es obligatorio').message).toBe(
      'El nombre es obligatorio',
    );
  });

  it('conserva el código original para el diagnóstico', () => {
    const error = new DomainError('conflict', undefined, {
      code: '23505',
      constraint: 'customers_organization_code',
    });
    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('customers_organization_code');
  });

  it('isDomainError reconoce los suyos y no los ajenos', () => {
    expect(isDomainError(new DomainError('validation'))).toBe(true);
    expect(isDomainError(new Error('otro'))).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });
});

describe('errores de dominio: códigos de PostgreSQL', () => {
  it('PGRST116 es "no existe", no un fallo de la base', () => {
    const error = translatePostgrestError({
      code: 'PGRST116',
      message: 'JSON object requested, multiple rows',
    });
    expect(error.kind).toBe('not_found');
  });

  it('42501 es autorización: RLS denegó o falta el permiso del rol', () => {
    const error = translatePostgrestError({
      code: '42501',
      message: 'new row violates row-level security',
    });
    expect(error.kind).toBe('authorization');
    expect(error.message).toBe('new row violates row-level security');
  });

  it('23505 es conflicto: el código único de la organización ya existe', () => {
    const error = translatePostgrestError({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    });
    expect(error.kind).toBe('conflict');
  });

  it('23503 es validación: el cliente no existe en esta organización', () => {
    // No es `conflict`: el usuario no puede corregir la fila ajena desde el
    // formulario, pero sí puede entender qué pasó y qué escribir.
    const error = translatePostgrestError({ code: '23503', message: 'foreign key violation' });
    expect(error.kind).toBe('validation');
  });

  it('23502 es validación: una columna NOT NULL quedó vacía', () => {
    expect(translatePostgrestError({ code: '23502', message: 'null value in column' }).kind).toBe(
      'validation',
    );
  });

  it('23514 es validación: un CHECK del tabla lo rechazó', () => {
    expect(
      translatePostgrestError({ code: '23514', message: 'credit_days between 0 and 365' }).kind,
    ).toBe('validation');
  });

  it('22P02 es validación: un texto no se pudo convertir al tipo pedido', () => {
    expect(
      translatePostgrestError({ code: '22P02', message: 'invalid input syntax for uuid' }).kind,
    ).toBe('validation');
  });

  it('22023 dice que falta contexto, y se reporta como autorización', () => {
    // La trigger de `derive_partner_organization` lanza 22023 cuando no hay
    // organización activa. Para la app es "no puedo hacer esto por quién eres",
    // no "la consulta estaba mal escrita".
    const error = translatePostgrestError({ code: '22023', message: 'No hay organización activa' });
    expect(error.kind).toBe('authorization');
    expect(error.message).toBe('No hay organización activa');
  });

  it('un código desconocido se reporta como base de datos, nunca como "inesperado"', () => {
    // Se dice "de la base" porque vino de la base. Decir "inesperado" haría que
    // la app ofrezca "reintentar" ante un error que no se arregla reintentando.
    const error = translatePostgrestError({ code: 'XX000', message: 'algo raro del servidor' });
    expect(error.kind).toBe('database');
    expect(error.code).toBe('XX000');
  });

  it('un objeto con mensaje pero sin código no se presume error de base', () => {
    // PostgREST siempre manda `code`. Un objeto con `message` y nada más puede
    // ser un fallo de red envuelto, o cualquier otra cosa: sin código SQL no se
    // puede afirmar de dónde vino, así que se reporta como inesperado y no como
    // un fallo de la base que la app ofrecería reintentar.
    const error = translatePostgrestError({ message: 'Failed to fetch' });
    expect(error.kind).toBe('unexpected');
    expect(error.message).toBe('Failed to fetch');
  });
});

describe('errores de dominio: lo que no es un error de base de datos', () => {
  it('sin filas es "no encontrado", porque RLS filtra en silencio', () => {
    // PostgREST devuelve `{ data: null, error: null }` cuando la política no deja
    // ver la fila. Traducirlo a `unexpected` haría que la app mostrara un fallo
    // donde en realidad la fila existe y no es tuya: eso confirma su existencia.
    expect(translatePostgrestError(null).kind).toBe('not_found');
    expect(translatePostgrestError(undefined).kind).toBe('not_found');
  });

  it('un error de red es inesperado, no un fallo de la base', () => {
    const error = translatePostgrestError(new Error('Failed to fetch'));
    expect(error.kind).toBe('unexpected');
    expect(error.message).toBe('Failed to fetch');
  });

  it('un valor raro cae en inesperado sin lanzar', () => {
    expect(translatePostgrestError('texto suelto').kind).toBe('unexpected');
    expect(translatePostgrestError(42).kind).toBe('unexpected');
  });

  it('un DomainError pasa intacto, sin reenvolverlo', () => {
    const original = new DomainError('conflict', 'El código ya existe');
    const translated = translatePostgrestError(original);
    expect(translated).toBe(original);
    expect(translated.kind).toBe('conflict');
    expect(translated.message).toBe('El código ya existe');
  });
});
