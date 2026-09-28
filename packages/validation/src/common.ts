/**
 * Primitivas de validación compartidas.
 *
 * Estas reglas se usan en TRES capas: formulario (Zod), Edge Function (Zod) y
 * función SQL (constraints). La validación del cliente es UX; la del servidor
 * es seguridad. Ninguna de las dos sustituye a la otra.
 */
import { z } from 'zod';

/** Fecha de negocio: `YYYY-MM-DD`, sin zona horaria. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener formato YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Fecha inválida');

/** Instante UTC en ISO-8601. */
export const isoDateTimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Fecha y hora inválidas',
});

/** Identificador UUID generado por la base de datos o por el cliente móvil. */
export const uuidSchema = z.uuid('Identificador inválido');

/** Teléfono colombiano: móvil o fijo, con o sin indicadores. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^(\+?57)?[\s-]?3\d{9}$|^(\+?57)?[\s-]?\d{7}$/, 'Teléfono colombiano inválido');

export const emailSchema = z.email('Correo electrónico inválido').max(255);

/**
 * Importe en pesos (no en centavos).
 *
 * Acepta hasta 4 decimales para capturar precios unitarios exactos
 * (12.000 COP/libra con fracción) y RECHAZA negativos donde no tiene sentido.
 * La conversión a centavos la hace el motor de cálculos, no el formulario.
 */
export const pesoAmountSchema = z
  .number({ error: 'Debe ser un número' })
  .min(0, 'No puede ser negativo')
  .max(999_999_999_999, 'Valor demasiado alto')
  .multipleOf(0.0001, 'Máximo 4 decimales');

/** Cantidad física: litros, kilos, gramos, sacos, huevos. */
export const quantitySchema = z.number({ error: 'Debe ser un número' }).min(0).max(1_000_000);

/** Cantidad que debe ser estrictamente positiva (aves, cerdos, kilos de canal). */
export const positiveQuantitySchema = quantitySchema.refine((value) => value > 0, {
  message: 'Debe ser mayor que cero',
});

/** Código de negocio en mayúsculas sin espacios: PONEDORAS, CERDOS. */
export const businessUnitCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9_]+$/, 'Solo mayúsculas, números y guion bajo');

/** Identificador individual de animal: CERDO-001, G-042. */
export const animalCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9_-]+$/i, 'Solo letras, números, guion y guion bajo');

/**
 * Clave de idempotencia para operaciones que pueden reintentarse.
 * Debe ser un UUID generado por el cliente (móvil) para que repetir la misma
 * operación no cree registros duplicados.
 */
export const idempotencyKeySchema = uuidSchema;

/** Descripción libre con control de longitud para evitar textos inútiles o gigantescos. */
export const notesSchema = z.string().trim().max(2_000, 'Máximo 2000 caracteres').optional();
