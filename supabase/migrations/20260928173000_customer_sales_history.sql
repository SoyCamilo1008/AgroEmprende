-- ─────────────────────────────────────────────────────────────────────────────
-- Historial de ventas de un cliente
--
-- Por que hace falta esta vista y no se lee `finance.sales` desde la aplicacion
-- ---------------------------------------------------------------------------------
-- El bloque de cartera entrego `customer_receivables` y `customer_payments`, y
-- falto la tercera lectura: el HISTORIAL de ventas. Se podria leer
-- `finance.sales` tal cual desde TypeScript, pero hay un dato que esa tabla no
-- tiene: si la venta esta anulada.
--
-- "Anulada" no es una columna. Es la presencia de un contra-asiento `reversal` en
-- `finance.ledger_entries` que apunta a la venta (ADR-0003). No hay llave foranea
-- entre `sales` y `ledger_entries`: el ledger guarda `source_type` + `source_id`
-- para no atarse a cada tabla queurable, y `source_id` no es una FK. Por eso
-- PostgREST NO puede incrustarlo con un embed y no hay forma de pedirlo desde el
-- cliente sin traer el ledger entero y cruzarlo en JavaScript.
--
-- Sin esta vista, la pantalla de historial mostraria una venta anulada como si
-- hubiera ocurrido, junto a su numero de factura. Es el peor error posible en un
-- historial: no es que falte un dato, es que el dato dice lo contrario.
--
-- Y no puede filtrarse desde el cliente tampoco. PostgREST expresa `NOT EXISTS`,
-- pero no su combinacion con la comparacion de `source_id`: `or=` y `not.`
-- trabajan sobre una fila, no sobre "no hay otra fila que coincida". La consulta
-- que responde a la pregunta vive mejor en PostgreSQL.
--
-- Decidir el filtro al leer y no al escribir mantiene la regla de la casa: la
-- aplicacion no deduce estado contable.
--
-- El filtro que hace FALLAR EN CERRADO
-- -----------------------------------
-- `exists (...)` necesita leer `ledger_entries`, cuya politica exige `finance.read`.
-- Sin ese permiso el `exists` devuelve FALSE, no "no lo se": la venta anulada
-- apareceria marcada como VIGENTE, con su total y su numero de factura, y la
-- aplicacion la sumaria al historial como si existiera. Es el fallo mas caro
-- posible aqui: no es que falte un dato, es que el dato afirma lo contrario.
--
-- Por eso la vista exige `finance.read` para devolver filas. Un rol con permiso
-- de ventas pero sin el de ledger no ve el historial, en vez de verlo incompleto
-- y equivocado. Es la diferencia entre un sintoma visible (una lista vacia que
-- alguien investiga) y un error invisible (un numero que cuadra con la cartera y
-- no con la realidad).
--
-- En el seed actual todos los roles con `finance.sales.read` tienen tambien
-- `finance.read`, asi que este filtro no esconde nada de nadie. La prueba 54 de
-- `12_customer_financial_read_model` y la 20 de este archivo fijan ese invariante
-- para que, si alguien cambia la matriz de roles, se entere en el CI y no en una
-- pantalla de cartera.
--
-- `is_voided` y no un `status`: la fila de la venta NO desaparece cuando se anula
-- (ADR-0003, la contabilidad es append-only). Ocultarla del historial seria
-- borrar historia; marcarla es lo que hace un libro real.
--
-- Tambien decide el filtro de permissions: las vistas con `security_invoker = true`
-- heredan las politicas de sus tablas subyacentes, asi que sin ese modulo las
-- consultas correrian con los permisos del dueno de la vista y saltarian RLS.
-- Mismo argumento que en `customer_receivables`: `ledger_entries` exige
-- `finance.read`, `core.business_units` exige `org.read`.
-- `security_invoker` es OBLIGATORIO, y va ANTES del `as`.
--
-- Sin esta opcion, PostgreSQL ejecuta el cuerpo de la vista con los privilegios de
-- su DUENO, y el dueno de una vista creada por una migracion es el rol que la
-- aplico. Las politicas RLS de `sales` y `ledger_entries` no se evaluarian, y la
-- vista responderia con las ventas de TODAS las organizaciones. No es una fuga
-- hipotetica: la asercion 15 de este archivo la sufrio en la primera version de
-- esta migracion, que traia el comentario sobre `security_invoker` pero no la
-- opcion. El comentario no protege; la opcion, si.
--
-- La opcion va antes del `as` porque `WITH` es palabra reservada de la sentencia
-- `CREATE VIEW`: al final, despues del `where`, PostgreSQL responde
-- `syntax error at or near "(" (SQLSTATE 42601)`. El orden lo dicta el gramama:
-- `CREATE VIEW nombre WITH (opciones) AS consulta`.
create or replace view finance.customer_sales
with (security_invoker = true)
as
select
  s.organization_id,
  s.id as sale_id,
  s.customer_id,
  s.business_unit_id,
  bu.code as business_unit_code,
  bu.name as business_unit_name,
  s.invoice_number,
  s.sale_date,
  s.due_date,
  s.payment_method,
  s.subtotal,
  s.tax,
  s.total,
  s.description,
  s.created_by,
  s.created_at,
  -- `exists` y no un `count`: se quiere el SI o el NO, nunca un numero.
  exists (
    select 1
    from finance.ledger_entries le
    where le.organization_id = s.organization_id
      and le.source_type = 'finance.sales'
      and le.source_id = s.id
      and le.entry_type = 'reversal'
  ) as is_voided
from finance.sales s
-- `left join` y no `inner join`: `core.business_units` exige `org.read`, y sin ese
-- permiso las cifras del cliente deben SEGUIR viéndose con la unidad en NULL. Una
-- fila de dinero que desaparece por falta de permiso para leer su etiqueta es peor
-- que una etiqueta ausente.
left join core.business_units bu
  on bu.organization_id = s.organization_id
 and bu.id = s.business_unit_id
-- Ver el bloque de arriba: sin `finance.read` el `exists` daria FALSE en vez de
-- "desconocido", y una venta anulada se venderia como vigente.
where private.has_permission('finance.read');

comment on view finance.customer_sales is
  'Historial de ventas de un cliente, con `is_voided` derivado del contra-asiento reversal del ledger (ADR-0003). NO filtra las anuladas: ocultarlas del historial seria borrar historia. Las ventas anuladas no aparecen en finance.customer_receivables. security_invoker: RLS de las tablas subyacentes sigue aplicando.';

-- Sin indice propio: el filtro por cliente usa el indice `sales_customer`
-- (organization_id, customer_id) que creo la migracion anterior, y el orden por
-- fecha de venta ya lo cubre `sales_organization_date`. Indexar una vista no es
-- una opcion en PostgreSQL (SQLSTATE 42809); el indice va en la tabla.

-- El derecho a leer estas ventas es el de `finance.sales`, el mismo que tendria
-- leyendo la tabla. Se revocan los permisos por defecto de la vista y se concede
-- solo a `authenticated`: es el rol que trae sesion, y el que las politicas de RLS
-- filtran fila por fila. `anon` se queda sin permiso.
revoke all on finance.customer_sales from anon, authenticated;
grant select on finance.customer_sales to authenticated;
