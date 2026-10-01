/**
 * Mapeo de filas de Postgres a entidades de dominio.
 *
 * Aquí se prueba la frontera más importante del paquete: que un `NULL` de la
 * base llegue como `null` al dominio y no como `undefined`, `''` ni `0`. La
 * diferencia entre `creditDays: null` ("no hay plazo acordado") y
 * `creditDays: 0` ("se cobra hoy") es una decisión comercial, y un mapeo que la
 * aplaste cambia la cartera de todos los clientes de la granja.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors';
import {
  mapCustomerContactRowToDomain,
  mapCustomerRowToDomain,
  readContactCount,
} from '../src/rows';
import { contactRow, customerRow } from './helpers/fakeSupabase';

describe('mapeo de clientes', () => {
  it('convierte las columnas a los nombres del dominio', () => {
    const customer = mapCustomerRowToDomain(customerRow());

    expect(customer.name).toBe('Clientes del Sur S.A.S.');
    expect(customer.taxId).toBe('900123456');
    expect(customer.creditDays).toBe(30);
    expect(customer.isActive).toBe(true);
    expect(customer.organizationId).toBe(customerRow().organization_id);
  });

  it('trae los NULL de la base como null, no como cadena vacía', () => {
    const customer = mapCustomerRowToDomain(
      customerRow({
        code: null,
        tax_id: null,
        email: null,
        phone: null,
        address: null,
        notes: null,
      }),
    );

    expect(customer.code).toBeNull();
    expect(customer.taxId).toBeNull();
    expect(customer.email).toBeNull();
    expect(customer.phone).toBeNull();
    expect(customer.address).toBeNull();
    expect(customer.notes).toBeNull();
  });

  it('distingue "no hay plazo acordado" (null) de "se paga hoy" (0)', () => {
    // Si estos dos colapsaran, un cliente que paga de contado empezaría a generar
    // crédito a 0 días o, peor, se le asignarían 30 días que nadie acordó.
    expect(mapCustomerRowToDomain(customerRow({ credit_days: null })).creditDays).toBeNull();
    expect(mapCustomerRowToDomain(customerRow({ credit_days: 0 })).creditDays).toBe(0);
  });

  it('no rellena los días de crédito con un valor por defecto', () => {
    // El comentario de la tabla dice que 30 días no se rellenan porque es una
    // decisión comercial. El mapeo no puede contradecirlo.
    expect(mapCustomerRowToDomain(customerRow({ credit_days: null })).creditDays).not.toBe(30);
  });

  it('acepta credit_days igual al máximo de la tabla', () => {
    expect(mapCustomerRowToDomain(customerRow({ credit_days: 365 })).creditDays).toBe(365);
  });

  it('un cliente inactivo se mapea como inactivo, no se esconde', () => {
    expect(mapCustomerRowToDomain(customerRow({ is_active: false })).isActive).toBe(false);
  });

  it('falla si la fila no tiene la forma esperada, en vez de devolver undefined', () => {
    // Un `undefined` silencioso aquí significaría un formulario con campos en
    // blanco y ningún error. Se prefiere un fallo visible.
    expect(() => mapCustomerRowToDomain({ ...customerRow(), name: undefined })).toThrow(
      DomainError,
    );
    expect(() => mapCustomerRowToDomain({ ...customerRow(), credit_days: 'treinta' })).toThrow(
      DomainError,
    );
    expect(() => mapCustomerRowToDomain({ ...customerRow(), is_active: 'sí' })).toThrow(
      DomainError,
    );
    expect(() => mapCustomerRowToDomain(null)).toThrow(DomainError);
    expect(() => mapCustomerRowToDomain([customerRow()])).toThrow(DomainError);
  });

  it('el error de forma apunta a la tabla y la columna', () => {
    // Sin el nombre de la columna, arreglar un drift de esquema es adivinar.
    expect(() => mapCustomerRowToDomain({ ...customerRow(), tax_id: 12345 })).toThrow(
      /core\.customers/,
    );
    expect(() => mapCustomerRowToDomain({ ...customerRow(), tax_id: 12345 })).toThrow(/tax_id/);
  });

  it('rechaza un id que no es un uuid', () => {
    expect(() => mapCustomerRowToDomain(customerRow({ id: 'no-soy-un-uuid' }))).toThrow(
      DomainError,
    );
  });

  it('rechaza una fecha que no se puede interpretar', () => {
    expect(() => mapCustomerRowToDomain(customerRow({ created_at: 'ayer' }))).toThrow(DomainError);
  });
});

describe('mapeo de contactos', () => {
  it('convierte las columnas a los nombres del dominio', () => {
    const contact = mapCustomerContactRowToDomain(contactRow());

    expect(contact.name).toBe('María López');
    expect(contact.role).toBe('Dueño de compra');
    expect(contact.isPrimary).toBe(true);
    expect(contact.customerId).toBe(contactRow().customer_id);
  });

  it('trae los NULL de la base como null', () => {
    const contact = mapCustomerContactRowToDomain(
      contactRow({ role: null, email: null, phone: null, notes: null }),
    );

    expect(contact.role).toBeNull();
    expect(contact.email).toBeNull();
    expect(contact.phone).toBeNull();
    expect(contact.notes).toBeNull();
  });

  it('un contacto no principal se marca como tal', () => {
    expect(mapCustomerContactRowToDomain(contactRow({ is_primary: false })).isPrimary).toBe(false);
  });

  it('falla si la fila no tiene la forma esperada', () => {
    expect(() => mapCustomerContactRowToDomain({ ...contactRow(), name: null })).toThrow(
      DomainError,
    );
    expect(() =>
      mapCustomerContactRowToDomain({ ...contactRow(), customer_id: undefined }),
    ).toThrow(DomainError);
  });
});

describe('conteo de contactos del resumen', () => {
  it('lee el agregado embebido que devuelve PostgREST', () => {
    expect(readContactCount([{ count: 3 }])).toBe(3);
    expect(readContactCount([{ count: 0 }])).toBe(0);
  });

  it('sin embed cuenta cero en vez de inventar un número', () => {
    expect(readContactCount(undefined)).toBe(0);
    expect(readContactCount(null)).toBe(0);
    expect(readContactCount([])).toBe(0);
  });

  it('un conteo incoherente se trata como cero, no como NaN', () => {
    // Un NaN en la interfaz se ve como "NaN contactos" y es peor que un cero.
    expect(readContactCount([{ count: 'muchos' }])).toBe(0);
    expect(readContactCount([{ count: -2 }])).toBe(0);
    expect(readContactCount([{}])).toBe(0);
    expect(readContactCount(['x'])).toBe(0);
  });
});
