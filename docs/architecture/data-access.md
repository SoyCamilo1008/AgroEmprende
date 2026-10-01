# Capa de datos: repositorio de Clientes

`@agroemprende/supabase` expone un repositorio de Clientes para Web y Mobile. No es un contenedor genérico: hace exactamente lo que se necesita para `core.customers` y `core.customer_contacts`, y nada más.

## Por qué no se usa `any`

`@supabase/supabase-js` no genera tipos automáticos en este repositorio: no existe `database.types.ts`. Sin esos tipos sus builders devuelven `any`, y la regla de la casa lo prohíbe. Para romper ese ciclo sin inventar tipos locales, el acceso a las filas pasa por `packages/supabase/src/rows.ts`:

1. Cada lectura convierte un valor sin tipo en una fila validada (`mapCustomerRowToDomain`).
2. Si el esquema cambia, la validación falla con `DomainError('database')` diciendo tabla y columna. Eso es más útil que un `undefined` silencioso en producción.
3. El repositorio no usa `as any`, `!` ni casts para esconder columnas: lo que lee es lo que valida.

No reemplaza a los tipos generados de Supabase. Cuando exista un `database.types.ts` confiable, este archivo puede simplificarse, pero la frontera de validación sigue teniendo sentido.

## RLS es la autoridad, no el repositorio

El repositorio **nunca** filtra por `organization_id` a mano:

1. La política es la única defensa que funciona aunque alguien escriba SQL crudo. Un filtro en TypeScript sugiere que el filtro protege, cuando la protección es RLS.
2. Con la cabecera `x-organization-id` el contexto se resuelve en PostgreSQL y se revalida contra las membresías activas. Un filtro manual con un id equivocado rompería el acceso legítimo en escenarios multi-organización.
3. Si una política deja pasar una fila que no debería, un `.eq('organization_id', ...)` no lo corrige: esconde el defecto en lugar de mostrarlo.

El repositorio nunca "elige" organización. En `create` y `createContact` no se envía `organization_id`: el trigger `BEFORE INSERT` de
`supabase/migrations/20260928171000_derive_partner_organization_on_insert.sql` lo toma de `private.current_organization_id()` cuando viene a `NULL`. Sin contexto, la base lanza `22023` con un mensaje que dice que falta la organización activa, y el repositorio lo traduce a `DomainError` de tipo `authorization`.

## Búsqueda y caracteres reservados de PostgREST

`buildSearchPattern` construye el patrón para el `or=` de PostgREST. Ese filtro no lleva JSON encima: viaja plano en la query string. Por eso:

- Se quitan los caracteres reservados de filtros (`, . " ( ) \`) para que una coma del usuario no divida el `or=` en condiciones que nadie escribió.
- Se quitan los comodines de `LIKE` (`%`, `_`) para que la búsqueda sea literal. Buscar `100%` debe encontrar al cliente que tiene ese texto, no a todos los que empiezan por `100`. El precio es que el símbolo en sí no se puede buscar: es un comodín y no tiene forma de escaparse sin depender de una versión de PostgREST.
- Un término que se queda vacío tras limpiar (`'%%'`, `',,,'`) devuelve `''` y **no** se envía al `.or()`. Mandarlo sería un `or=().ilike.%%` que no casa con nada y obliga a un escaneo completo en lugar de un listado.
- El recorte de espacios va dentro de `buildSearchPattern`, no en el llamador, porque la función se exporta: buscar `"  sur  "` tiene que ser lo mismo que buscar `"sur"` para quien la llame directamente.
- Se envuelve en `%...%` y se usa `ILIKE`. No se usa `unaccent`: requiere la extensión y el comportamiento de ICU varía por plataforma; en v1 un `ILIKE` es suficiente y determinista, que es lo que dice el comentario del índice `customers_name_search`. Por lo mismo no se descompone `María` en `Ma ria`: rompería el índice sobre `lower(name)`.

## Paginación

- `limit` y `offset` se normalizan: negativos y `NaN` se corrigen, `limit = 0` pasa a 1 y `limit > MAX_CUSTOMER_PAGE_SIZE` (1000) se trunca. Es consistente con `max_rows = 1000` en `supabase/config.toml`: pedir más no devuelve más, solo hace la consulta más lenta.
- Se pide `count: 'exact'` para poder pintar "1-50 de 340". Si el conteo no llega, se usa la cantidad de filas devueltas, nunca `undefined`.
- El orden por defecto es `name ASC`. **No** se añade un desempate por `id`: `name` no es único y PostgreSQL puede devolver las páginas en distinto orden entre llamadas. Resolver eso exige un criterio de orden único, que sería un cambio de producto, no una mejora de implementación.
- La columna de orden se comprueba contra `CUSTOMER_SORT_COLUMNS` **en runtime**, no solo con el tipo. `CustomerSortColumn` desaparece al compilar, así que un valor que venga de una query string llegaría igual y acabaría dentro del `order=` de PostgREST, que es donde se inyectan filtros. Ante un valor no permitido se usa `name`.

## Actualizaciones parciales

`update` y `updateContact` solo envían las columnas cuyo campo **vino en el objeto del llamador**. Esto evita dos errores frecuentes:

1. Un formulario que manda el cliente entero con los opcionales vacíos borraría el NIT de un cliente ya formalizado. Lo que no viene, no cambia.
2. Un parche vacío (`{}`) no envía un `UPDATE`: devuelve el registro existente. Evita una entrada de auditoría con la fecha de "ahora" y ningún cambio detrás, que es justo el ruido que la auditoría de `20260928170000` descarta.

`updateContact` ignora un `customerId` que venga: mover un contacto a otro cliente es cambiarle de cliente a otra persona, y eso no lo decide un formulario de edición.

### Por qué `schema.partial()` no alcanza

`customerSchema.partial()` **no** sirve para saber qué campos pidió el llamador. En Zod 4 sigue aplicando el `.default()` interior de cada campo:

```ts
customerSchema.partial().parse({ name: 'X' });
// → { name: 'X', creditDays: null, isActive: true }
```

Con eso, `update(id, { name: 'Nuevo nombre' })` enviaría `credit_days = null` e `is_active = true`: le borraría el plazo de crédito acordado a un cliente y reactivaría al que el dueño desactivó. Por eso el repositorio valida con el schema (para no perder sus reglas) y luego cruza el resultado con las claves que venían. `onlyKeysFrom` es esa comprobación.

### Tres estados, no dos

`packages/validation/src/index.ts` distingue tres estados que antes se confundían:

| Entrada                     | Significado                | Columna                                   |
| --------------------------- | -------------------------- | ----------------------------------------- |
| clave ausente o `undefined` | el formulario no lo tocó   | no se escribe                             |
| `null`                      | vaciar el dato a propósito | se escribe `NULL`                         |
| `''`                        | campo de formulario vacío  | se normaliza a `undefined`, no se escribe |

El caso de `null` es el que faltaba: `core.customers.phone` es nullable, pero el schema solo aceptaba `undefined`, así que **no había forma de quitarle el teléfono a un cliente que ya lo tenía**. `''` no servía porque no escribe nada, y el número se habría quedado para siempre.

### Los defaults son de la base

Las columnas que el llamador no envía las pone PostgreSQL: `is_active` es `not null default true` e `is_primary` es `not null default false`. El repositorio no los reenvía ni en altas ni en actualizaciones, para no mantener una segunda copia de cada default que se pueda contradecir con la tabla.

## Contactos: sin borrar, sin desactivar

`core.customer_contacts` no tiene `is_active` ni política de `DELETE`. El repositorio no expone `deleteContact` ni `deactivateContact`. Añadirlas aquí sería inventar un modelo que la base no respalda; si el negocio necesita archivar contactos, eso se decide sobre el esquema con una migración append-only, no en el cliente.

## Activar y desactivar clientes

`core.customers` no tiene `DELETE` a propósito: ventas, pagos y contactos lo referencian. Desactivar es la operación que corresponde y `deactivate`/`activate` solo mueven `is_active`.

## El resumen no incluye saldo

El saldo se deriva de `finance.receivables` cruzando `finance.sales`, y cada venta anulada se reconoce por su contra-asiento en `finance.ledger_entries` (ADR-0003). Reimplementar eso en TypeScript daría una cifra que no cuadra con el motor financiero en cuanto alguien anule una venta. Por eso `getSummary` devuelve el cliente y su conteo de contactos, y el saldo pertenece al bloque de finanzas.

## Qué prueba cada capa

- **Vitest** (`packages/supabase/test/`): mapeo snake_case → camelCase, texto del filtro de búsqueda, orden y paginación, parches parciales, traducción de errores, y que nunca se envíe `organization_id`. Son propiedades **del código TypeScript**.
- **pgTAP** (`supabase/tests/11_customers_data_access.test.sql`, `plan(25)`): aislamiento entre organizaciones, alta sin `organization_id`, fallo sin contexto, permisos de `viewer`, contactos que no se cuelgan de clientes ajenos, ausencia de `DELETE`, y que desactivar conserva la fila. Son propiedades **de PostgreSQL**: RLS, políticas y triggers.

Dos detalles de esas pruebas que son fáciles de escribir mal:

- El conteo de "no quedó nada a medias" se hace con `reset role`, como el dueño de la tabla, que no está sujeto a RLS (no hay `FORCE ROW LEVEL SECURITY`). Con el rol de siempre y sin contexto, `count(*)` da 0 con la tabla llena: probaría que RLS oculta, no que la escritura falló.
- Las aserciones corren con `set local role authenticated` a propósito. Si el papel se quedara en superusuario, el RLS se saltaría y la prueba mediría lo contrario de lo que dice medir.

Un doble falso no puede probar lo segundo: devolvería exactamente lo que se le dijera que devolviera. Por eso las propiedades de RLS están en pgTAP contra PostgreSQL real, en el job `migrations` del CI.

## Subpaths

`./browser`, `./mobile` y `./env` no cambian. Se añaden `./errors`, `./rows` y `./repositories/customers` para permitir importaciones puntuales. Ninguna exportación existente se rompe.
