/**
 * Repositorio de clientes: qué consulta construye y qué devuelve.
 *
 * Lo que se prueba es la traducción, no la seguridad. Que un cliente de otra
 * organización no se vea es una propiedad de RLS y se mide en
 * `supabase/tests/11_customers_data_access.test.sql`, contra PostgreSQL real.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/errors';
import {
  CustomerRepository,
  DEFAULT_CUSTOMER_PAGE_SIZE,
  MAX_CUSTOMER_PAGE_SIZE,
  buildSearchPattern,
} from '../src/repositories/customers';
import type { CustomerSortColumn } from '../src/repositories/customers';
import {
  contactRow,
  createFakeSupabase,
  customerDomain,
  customerRow,
  type FakeSupabase,
} from './helpers/fakeSupabase';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';

let fake: FakeSupabase;
let repo: CustomerRepository;

beforeEach(() => {
  fake = createFakeSupabase();
  repo = new CustomerRepository(fake.client);
});

describe('repositorio de clientes: listar', () => {
  it('consulta el esquema core, no public', async () => {
    // Las tablas de clientes viven en `core`. Consultar `public` daría un 404 que
    // no dice nada sobre el nombre del esquema.
    fake.enqueue({ data: [customerRow()] });
    await repo.list();

    expect(fake.lastCall().schema).toBe('core');
    expect(fake.lastCall().table).toBe('customers');
  });

  it('devuelve los clientes mapeados al dominio', async () => {
    fake.enqueue({ data: [customerRow()], count: 1 });
    const page = await repo.list();

    expect(page.items).toEqual([customerDomain()]);
    expect(page.total).toBe(1);
  });

  it('pide el total de filas, para que la paginación no tenga que adivinar', async () => {
    fake.enqueue({ data: [], count: 340 });
    const page = await repo.list();

    expect(fake.lastCall().withCount).toBe(true);
    expect(page.total).toBe(340);
    expect(page.items).toEqual([]);
  });

  it('si el total no viene, usa el número de filas en vez de dejarlo undefined', async () => {
    // Un `total: undefined` se pintaría como "de  a " en la paginación.
    fake.enqueue({
      data: [customerRow(), customerRow({ id: '44444444-4444-4444-8444-444444444444' })],
    });
    const page = await repo.list();

    expect(page.total).toBe(2);
  });

  it('ordena por nombre ascendente, que es como se lee un listado', async () => {
    fake.enqueue({ data: [] });
    await repo.list();

    expect(fake.lastCall().orders).toEqual([['name', true]]);
  });

  it('acepta ordenar por las columnas de la lista cerrada', async () => {
    fake.enqueue({ data: [] });
    await repo.list({ sortBy: 'credit_days', sortDir: 'desc' });

    expect(fake.lastCall().orders).toEqual([['credit_days', false]]);
  });

  it('una columna de orden que no está en la lista no se cuela en la consulta', async () => {
    // El tipo se borra al compilar: un valor de una query string llega sin
    // comprobar y acabaría dentro del `order=` de PostgREST.
    fake.enqueue({ data: [] });
    await repo.list({
      sortBy: 'name.desc,id' as unknown as CustomerSortColumn,
    });

    expect(fake.lastCall().orders).toEqual([['name', true]]);
  });

  it('traduce las opciones de paginación al rango de PostgREST', async () => {
    fake.enqueue({ data: [] });
    const page = await repo.list({ limit: 25, offset: 50 });

    // `range` es inclusivo en ambos extremos: para 25 filas desde la 50, la
    // última es la 74.
    expect(fake.lastCall().range).toEqual([50, 74]);
    expect(page.limit).toBe(25);
    expect(page.offset).toBe(50);
  });

  it('usa el tamaño de página por defecto cuando no le dicen otro', async () => {
    fake.enqueue({ data: [] });
    const page = await repo.list();

    expect(page.limit).toBe(DEFAULT_CUSTOMER_PAGE_SIZE);
    expect(fake.lastCall().range).toEqual([0, DEFAULT_CUSTOMER_PAGE_SIZE - 1]);
  });

  it('no pide más de lo que max_rows permite devolver', async () => {
    // `supabase/config.toml` fija max_rows = 1000. Pedir 5000 no da más datos:
    // hace la consulta más lenta para mostrar lo mismo.
    fake.enqueue({ data: [] });
    const page = await repo.list({ limit: 5000 });

    expect(page.limit).toBe(MAX_CUSTOMER_PAGE_SIZE);
  });

  it('corrige un límite o desplazamiento absurdo en vez de propagarlo', async () => {
    fake.enqueue({ data: [] }, { data: [] });
    await repo.list({ limit: 0 });
    await repo.list({ offset: -10 });

    expect(fake.calls[0]?.range).toEqual([0, 0]);
    expect(fake.calls[1]?.range).toEqual([0, DEFAULT_CUSTOMER_PAGE_SIZE - 1]);
  });

  it('ignora un tamaño de página que no es un número', async () => {
    fake.enqueue({ data: [] });
    const page = await repo.list({ limit: Number.NaN });

    expect(page.limit).toBe(DEFAULT_CUSTOMER_PAGE_SIZE);
  });

  it('no filtra por organización: esa decisión es de RLS', async () => {
    // Si el repositorio añadiera `.eq('organization_id', algo)`, la cabecera
    // `x-organization-id` equivocada rompería el acceso legítimo y el filtro
    // parecería ser la defensa cuando no lo es.
    fake.enqueue({ data: [] });
    await repo.list();

    const columns = fake.lastCall().filters.map(([column]) => column);
    expect(columns).not.toContain('organization_id');
  });

  it('filtra por estado solo cuando se le pide', async () => {
    fake.enqueue({ data: [] }, { data: [] });
    await repo.list();
    await repo.list({ isActive: false });

    expect(fake.calls[0]?.filters).toEqual([]);
    expect(fake.calls[1]?.filters).toEqual([['is_active', false]]);
  });

  it('traduce los errores de la consulta', async () => {
    fake.enqueue({ error: { code: '42501', message: 'permission denied' } });
    await expect(repo.list()).rejects.toMatchObject({ kind: 'authorization' });
  });
});

describe('repositorio de clientes: búsqueda', () => {
  it('busca en nombre, código, teléfono y NIT', async () => {
    fake.enqueue({ data: [] });
    await repo.list({ search: 'sur' });

    expect(fake.lastCall().orFilters).toEqual([
      'name.ilike.%sur%,code.ilike.%sur%,phone.ilike.%sur%,tax_id.ilike.%sur%',
    ]);
  });

  it('no busca cuando el texto está vacío', async () => {
    // Una búsqueda vacía debe listar, no filtrar por un patrón que coincide con
    // todos los clientes de la organización.
    fake.enqueue({ data: [] }, { data: [] }, { data: [] });
    await repo.list();
    await repo.list({ search: '' });
    await repo.list({ search: '   ' });

    for (const call of fake.calls) {
      expect(call.orFilters).toEqual([]);
    }
  });

  it('quita los espacios antes de buscar', async () => {
    fake.enqueue({ data: [] });
    await repo.list({ search: '  sur  ' });

    expect(fake.lastCall().orFilters[0]).toBe(
      'name.ilike.%sur%,code.ilike.%sur%,phone.ilike.%sur%,tax_id.ilike.%sur%',
    );
  });

  it('quita los comodines de LIKE para que la búsqueda sea literal', () => {
    // "100%" debe buscar el texto "100%", no cualquier cosa que empiece por
    // "100". Como el comodín se quita y no se escapa, el resultado busca el
    // término sin el símbolo, que es lo único posible: el propio símbolo es un
    // comodín y no tiene forma de buscarse literalmente aquí.
    expect(buildSearchPattern('100%')).toBe('%100%');
    expect(buildSearchPattern('%')).toBe('');
    expect(buildSearchPattern('_')).toBe('');
  });

  it('un término que solo era comodines deja de ser una búsqueda', () => {
    // Si no, se mandaría `or=(name.ilike.%%)`, que no casa con nada y además
    // hace un escaneo completo en lugar de un listado.
    expect(buildSearchPattern('%%%')).toBe('');
    expect(buildSearchPattern(',,,')).toBe('');
  });

  it('no deja pasar un término vacío por el filtro', async () => {
    fake.enqueue({ data: [] });
    await repo.list({ search: '%' });

    expect(fake.lastCall().orFilters).toEqual([]);
  });

  it('una búsqueda con acentos no los descompone', () => {
    // La tabla usa `ILIKE` y el índice `customers_name_search` sobre `lower(name)`.
    // Descomponer "María" en "Ma ria" herejaría la búsqueda con ese índice.
    expect(buildSearchPattern('María')).toBe('%María%');
  });

  it('quita los separadores de la sintaxis de filtros de PostgREST', () => {
    // La coma separa condiciones en un `or=` y el punto separa columna de
    // operador. Si llegan sin quitar, el texto del usuario se convierte en
    // filtros que nadie escribió.
    expect(buildSearchPattern('a,b')).toBe('%ab%');
    expect(buildSearchPattern('a.b')).toBe('%ab%');
    expect(buildSearchPattern('a(b)c')).toBe('%abc%');
    expect(buildSearchPattern('a"b')).toBe('%ab%');
    expect(buildSearchPattern('a\\b')).toBe('%ab%');
  });

  it('un nombre con acentos se busca tal cual, sin descomponerlo', () => {
    expect(buildSearchPattern('María')).toBe('%María%');
  });

  it('deja intacto un texto que no tiene nada escapable', () => {
    expect(buildSearchPattern('Clientes del Sur')).toBe('%Clientes del Sur%');
  });

  it('combina búsqueda con estado y paginación', async () => {
    fake.enqueue({ data: [], count: 0 });
    await repo.list({ search: 'sur', isActive: true, limit: 10, offset: 20 });

    const call = fake.lastCall();
    expect(call.orFilters).toHaveLength(1);
    expect(call.filters).toEqual([['is_active', true]]);
    expect(call.range).toEqual([20, 29]);
  });
});

describe('repositorio de clientes: obtener uno', () => {
  it('devuelve el cliente mapeado', async () => {
    fake.enqueue({ data: customerRow() });
    await expect(repo.getById(CUSTOMER_ID)).resolves.toEqual(customerDomain());
  });

  it('devuelve null cuando RLS no deja ver la fila', async () => {
    // `maybeSingle` y no `single`: con `single`, PostgREST lanzaría PGRST116 y el
    // repositorio no podría diferenciar "no existe" de "no es tuya". RLS filtra
    // en silencio, y el cliente no debe confirmar que la fila existe.
    fake.enqueue({ data: null });
    await expect(repo.getById(CUSTOMER_ID)).resolves.toBeNull();
  });

  it('filtra por id, no por nombre', async () => {
    fake.enqueue({ data: customerRow() });
    await repo.getById(CUSTOMER_ID);

    expect(fake.lastCall().filters).toEqual([['id', CUSTOMER_ID]]);
    expect(fake.lastCall().single).toBe('maybeSingle');
  });
});

describe('repositorio de clientes: crear', () => {
  it('manda las columnas en snake_case', async () => {
    fake.enqueue({ data: customerRow() });
    await repo.create({
      name: 'Clientes del Sur S.A.S.',
      taxId: '900123456',
      creditDays: 30,
      phone: '3101234567',
    });

    expect(fake.lastCall().op).toBe('insert');
    expect(fake.lastCall().columns).toEqual({
      name: 'Clientes del Sur S.A.S.',
      tax_id: '900123456',
      phone: '3101234567',
      credit_days: 30,
    });
  });

  it('nunca manda organization_id, ni aunque se le pase', async () => {
    // El formulario no decide la organización. Si el id llegara a la consulta,
    // un cliente podría intentar crear en la organización de otro.
    fake.enqueue({ data: customerRow() }, { data: customerRow() });
    await repo.create({
      name: 'Clientes del Sur S.A.S.',
      organizationId: '33333333-3333-4333-8333-333333333333',
    });
    await repo.create({ name: 'Clientes del Sur S.A.S.' });

    for (const call of fake.calls) {
      expect(Object.keys(call.columns ?? {})).not.toContain('organization_id');
    }
  });

  it('rechaza datos que el schema compartido no acepta, sin tocar la base', async () => {
    // La validación es la de @agroemprende/validation, no una copia. Un nombre de
    // un carácter, un NIT con guiones o 400 días de crédito se paran aquí.
    await expect(repo.create({ name: 'J' })).rejects.toMatchObject({ kind: 'validation' });
    await expect(repo.create({ name: 'Cliente', taxId: '900-123-456' })).rejects.toMatchObject({
      kind: 'validation',
    });
    await expect(repo.create({ name: 'Cliente', creditDays: 400 })).rejects.toMatchObject({
      kind: 'validation',
    });

    expect(fake.calls).toHaveLength(0);
  });

  it('no ofrece un límite de crédito en pesos, porque la tabla no lo tiene', async () => {
    // El schema descarta la clave desconocida. Aceptarla construiría un acuerdo
    // comercial que nadie tomó y que la base no sabe guardar.
    fake.enqueue({ data: customerRow() });
    await repo.create({ name: 'Clientes del Sur S.A.S.', creditLimit: 5_000_000 });

    expect(Object.keys(fake.lastCall().columns ?? {})).not.toContain('credit_limit');
  });

  it('deja los días de crédito en null cuando no hay acuerdo', async () => {
    fake.enqueue({ data: customerRow({ credit_days: null }) });
    await repo.create({ name: 'Clientes del Sur S.A.S.' });

    expect(fake.lastCall().columns).toEqual({ name: 'Clientes del Sur S.A.S.' });
  });

  it('normaliza el código a mayúsculas, como el schema', async () => {
    fake.enqueue({ data: customerRow({ code: 'CLI-01' }) });
    await repo.create({ name: 'Clientes del Sur S.A.S.', code: 'cli-01' });

    expect(fake.lastCall().columns).toMatchObject({ code: 'CLI-01' });
  });

  it('devuelve la fila que la base creó, no la que se pidió', async () => {
    // El id, los timestamps y el código normalizado los pone PostgreSQL.
    fake.enqueue({ data: customerRow({ code: 'CLI-01', credit_days: 30 }) });
    const created = await repo.create({ name: 'Clientes del Sur S.A.S.', code: 'cli-01' });

    expect(created).toEqual(customerDomain({ code: 'CLI-01', creditDays: 30 }));
  });

  it('un código repetido en la misma organización es un conflicto, no un fallo', async () => {
    fake.enqueue({ error: { code: '23505', message: 'duplicate key' } });
    await expect(repo.create({ name: 'Cliente', code: 'CLI-01' })).rejects.toMatchObject({
      kind: 'conflict',
    });
  });
});

describe('repositorio de clientes: actualizar', () => {
  it('solo escribe los campos presentes en el parche', async () => {
    fake.enqueue({ data: customerRow({ credit_days: 45 }) });
    await repo.update(CUSTOMER_ID, { creditDays: 45 });

    expect(fake.lastCall().op).toBe('update');
    expect(fake.lastCall().columns).toEqual({ credit_days: 45 });
  });

  it('un campo ausente no se escribe, y no borra el dato que ya estaba', async () => {
    // El caso real: un formulario de edición manda el cliente entero con los
    // campos opcionales vacíos. Traducirlos a `null` borraría el NIT de un
    // cliente que ya estaba formalizado.
    fake.enqueue({ data: customerRow({ phone: null }) });
    await repo.update(CUSTOMER_ID, { name: 'Nuevo nombre', phone: null });

    expect(fake.lastCall().columns).toEqual({ name: 'Nuevo nombre', phone: null });
  });

  it('null explícito sí borra el campo', async () => {
    // Si el usuario quita el teléfono a propósito, eso es un cambio y se guarda.
    fake.enqueue({ data: customerRow({ phone: null }) });
    await repo.update(CUSTOMER_ID, { phone: null });

    expect(fake.lastCall().columns).toEqual({ phone: null });
  });

  it('un parche vacío no manda un UPDATE que no cambia nada', async () => {
    // Un UPDATE vacío genera una entrada de auditoría con la fecha de "ahora" y
    // ningún cambio detrás: exactamente el ruido que la auditoría evita.
    fake.enqueue({ data: customerRow() });
    const result = await repo.update(CUSTOMER_ID, {});

    expect(fake.calls).toHaveLength(1);
    expect(fake.lastCall().op).toBe('select');
    expect(result).toEqual(customerDomain());
  });

  it('un parche vacío sobre un cliente inexistente falla como no encontrado', async () => {
    fake.enqueue({ data: null });
    await expect(repo.update(CUSTOMER_ID, {})).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('rechaza datos inválidos sin tocar la base', async () => {
    await expect(repo.update(CUSTOMER_ID, { creditDays: 400 })).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('cuando RLS filtra la fila, dice que no existe en vez de devolver un hueco', async () => {
    // La política filtra en USING: el UPDATE no falla, no toca nada y devuelve
    // cero filas. Sin este chequeo, el repositorio devolvería `undefined` como si
    // fuera un cliente.
    fake.enqueue({ data: null });
    await expect(repo.update(CUSTOMER_ID, { name: 'Otro nombre' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});

describe('repositorio de clientes: activar y desactivar', () => {
  it('desactivar pone is_active en false, no borra', async () => {
    fake.enqueue({ data: customerRow({ is_active: false }) });
    const result = await repo.deactivate(CUSTOMER_ID);

    expect(fake.lastCall().columns).toEqual({ is_active: false });
    expect(result.isActive).toBe(false);
  });

  it('activar pone is_active en true', async () => {
    fake.enqueue({ data: customerRow({ is_active: true }) });
    await repo.activate(CUSTOMER_ID);

    expect(fake.lastCall().columns).toEqual({ is_active: true });
  });

  it('desactivar un cliente de otra organización no cambia nada', async () => {
    fake.enqueue({ data: null });
    await expect(repo.deactivate(CUSTOMER_ID)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('no ofrece borrar, porque el modelo no lo tiene', () => {
    // `core.customers` no tiene DELETE a propósito: sus ventas, pagos y contactos
    // lo referencian. Desactivar es la salida, y es la única.
    expect('delete' in repo).toBe(false);
    expect(
      Object.getOwnPropertyNames(CustomerRepository.prototype).filter((n) => /^delete/i.test(n)),
    ).toEqual([]);
  });
});

describe('repositorio de clientes: contactos', () => {
  it('lista los contactos del cliente, el principal primero', async () => {
    fake.enqueue({ data: [contactRow()] });
    const contacts = await repo.listContacts(CUSTOMER_ID);

    expect(fake.lastCall().table).toBe('customer_contacts');
    expect(fake.lastCall().filters).toEqual([['customer_id', CUSTOMER_ID]]);
    expect(fake.lastCall().orders).toEqual([
      ['is_primary', false],
      ['name', true],
    ]);
    expect(contacts[0]?.name).toBe('María López');
  });

  it('devuelve una lista vacía, no un error, cuando el cliente no tiene contactos', async () => {
    fake.enqueue({ data: [] });
    await expect(repo.listContacts(CUSTOMER_ID)).resolves.toEqual([]);
  });

  it('crea un contacto sin pedir organización', async () => {
    fake.enqueue({ data: contactRow() });
    await repo.createContact({
      customerId: CUSTOMER_ID,
      name: 'María López',
      role: 'Dueño de compra',
    });

    // Solo lo que se pidió. `is_primary` no va: la columna es `not null default
    // false`, así que PostgreSQL lo pone. La fila resultante es la misma y el
    // repositorio no mantiene una segunda copia de los defaults.
    expect(fake.lastCall().columns).toEqual({
      customer_id: CUSTOMER_ID,
      name: 'María López',
      role: 'Dueño de compra',
    });
  });

  it('sí manda is_primary cuando se pide explícitamente', async () => {
    // Marcar un contacto como principal es una decisión, no un default.
    fake.enqueue({ data: contactRow({ is_primary: true }) });
    await repo.createContact({ customerId: CUSTOMER_ID, name: 'María López', isPrimary: true });

    expect(fake.lastCall().columns).toMatchObject({ is_primary: true });
  });

  it('nunca manda organization_id al crear un contacto', async () => {
    fake.enqueue({ data: contactRow() });
    await repo.createContact({
      customerId: CUSTOMER_ID,
      name: 'María López',
      organizationId: '44444444-4444-4444-8444-444444444444',
    });

    expect(Object.keys(fake.lastCall().columns ?? {})).not.toContain('organization_id');
  });

  it('exige el cliente al que pertenece el contacto', async () => {
    await expect(repo.createContact({ name: 'María López' })).rejects.toMatchObject({
      kind: 'validation',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('un contacto colgado de un cliente ajeno falla por la política, no aquí', async () => {
    // El repositorio no decide esto: la política de insert exige que el cliente
    // exista en la organización activa. Se traduce el 42501 tal cual.
    fake.enqueue({
      error: { code: '42501', message: 'new row violates row-level security policy' },
    });
    await expect(
      repo.createContact({ customerId: CUSTOMER_ID, name: 'María López' }),
    ).rejects.toMatchObject({
      kind: 'authorization',
    });
  });

  it('actualiza solo los campos presentes', async () => {
    fake.enqueue({ data: contactRow({ phone: '3110000000' }) });
    await repo.updateContact(CONTACT_ID, { phone: '3110000000' });

    expect(fake.lastCall().op).toBe('update');
    expect(fake.lastCall().columns).toEqual({ phone: '3110000000' });
  });

  it('ignora un customerId que venga en la actualización', async () => {
    // Mover un contacto a otro cliente es cambiarle de cliente a otra persona, y
    // eso no lo decide un formulario de edición.
    fake.enqueue({ data: contactRow() });
    await repo.updateContact(CONTACT_ID, {
      name: 'María López',
      customerId: '44444444-4444-4444-8444-444444444444',
    });

    expect(fake.lastCall().columns).toEqual({ name: 'María López' });
  });

  it('una actualización sin cambios se rechaza en vez de escribir en vacío', async () => {
    await expect(repo.updateContact(CONTACT_ID, {})).rejects.toMatchObject({ kind: 'validation' });
    expect(fake.calls).toHaveLength(0);
  });

  it('no ofrece desactivar ni borrar contactos: el modelo no los tiene', async () => {
    // `core.customer_contacts` no tiene `is_active` ni política de DELETE. Añadir
    // esas operaciones aquí sería inventar un modelo que la base no respalda.
    //
    // Se buscan los nombres con sufijo `Contact`: `deactivate` sí existe, pero es
    // el de clientes, que tienen `is_active`. Un filtro `^(delete|deactivate)`
    // markingía ese método legítimo por error.
    const methods = Object.getOwnPropertyNames(CustomerRepository.prototype);
    const contactLifecycle = methods.filter((name) =>
      /(delete|deactivate|activate).*contact/i.test(name),
    );
    expect(contactLifecycle).toEqual([]);
  });
});

describe('repositorio de clientes: resumen', () => {
  it('trae el cliente y el conteo de contactos en la misma consulta', async () => {
    fake.enqueue({ data: { ...customerRow(), customer_contacts: [{ count: 2 }] } });
    const summary = await repo.getSummary(CUSTOMER_ID);

    expect(fake.lastCall().selectColumns).toBe('*, customer_contacts(count)');
    expect(summary?.contactCount).toBe(2);
    expect(summary?.customer.name).toBe('Clientes del Sur S.A.S.');
  });

  it('un cliente sin contactos cuenta cero', async () => {
    fake.enqueue({ data: { ...customerRow(), customer_contacts: [{ count: 0 }] } });
    const summary = await repo.getSummary(CUSTOMER_ID);

    expect(summary?.contactCount).toBe(0);
  });

  it('no inventa un saldo', async () => {
    // El saldo viene de finance.receivables cruzando finance.sales, y cada venta
    // anulada se reconoce por su contra-asiento (ADR-0003). Calcularlo aquí
    // daría una cifra que no cuadra con el motor financiero en cuanto alguien anule
    // una venta. Por eso este bloque no lo incluye.
    fake.enqueue({ data: { ...customerRow(), customer_contacts: [{ count: 1 }] } });
    const summary = await repo.getSummary(CUSTOMER_ID);

    expect(summary).not.toHaveProperty('balance');
    expect(summary?.customer).not.toHaveProperty('balance');
    expect(Object.keys(summary ?? {}).sort()).toEqual(['contactCount', 'customer']);
  });

  it('devuelve null si RLS no deja ver al cliente', async () => {
    fake.enqueue({ data: null });
    await expect(repo.getSummary(CUSTOMER_ID)).resolves.toBeNull();
  });

  it('traduce un error de la consulta', async () => {
    fake.enqueue({ error: { code: 'PGRST116', message: 'no rows' } });
    await expect(repo.getSummary(CUSTOMER_ID)).rejects.toBeInstanceOf(DomainError);
  });
});

describe('repositorio de clientes: la fábrica usa el cliente que le pasan', () => {
  it('no crea su propio cliente, para no perder la sesión ni el contexto', async () => {
    // El cliente de la app ya trae la sesión (cookies en web, almacenamiento
    // seguro en móvil) y es el que manda la cabecera `x-organization-id`, de la
    // que dependen las políticas. Crear otro aquí dejaría al usuario sin
    // organizar la sesión.
    const first = new CustomerRepository(fake.client);
    const second = new CustomerRepository(fake.client);

    // El constructor no fabricó un cliente propio: las dos instancias usan el que
    // le pasaron, y se comprueba por Conducto en vez de por un campo privado que
    // no se puede leer desde fuera.
    fake.enqueue({ data: [customerRow()] });
    await first.list();
    fake.enqueue({ data: [] });
    await second.list({ search: 'otro' });

    expect(fake.calls).toHaveLength(2);
    expect(first).not.toBe(second);
  });
});
