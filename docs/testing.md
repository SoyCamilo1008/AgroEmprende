# Testing

## Qué protege el motor de cálculo

`@agroemprende/calculations` es la parte del sistema donde un error no se ve: un cálculo
mal hecho devuelve un número plausible y el usuario toma una decisión de negocio con él.
Por eso está cubierto con dos tipos de prueba.

### 1. Pruebas de ejemplos

Verifican casos concretos con números conocidos: "una venta de 100 huevos a 500 COP con un
descuento de 2.000 da 48.000". Son fáciles de leer y localizan regresiones rápidas.

Viven junto al código: `packages/calculations/test/{money,feed,production,sales,inventory,cycles}.test.ts`.

### 2. Pruebas de propiedades

Verifican **invariantes**, no ejemplos. Si un refactor rompe la contabilidad, fallan
aunque todos los ejemplos sigan pasando. Son la red de seguridad real.

`packages/calculations/test/invariants.property.test.ts` usa `fast-check` para verificar,
entre otras, estas invariantes:

| Invariante                                                     | Por qué importa                                 |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `total = subtotal − discount` y `total ≥ 0`                    | Un total negativo es un bug de dinero           |
| Un descuento mayor que el subtotal lanza `RangeError`          | No se "cobra en negativo"                       |
| `saldo = original − abonos`, y `saldo ≥ 0`                     | Un saldo negativo no significa nada             |
| `allocatePayments` es determinista y suma exactamente el abono | Un abono perdido es dinero perdido              |
| `cantidad × costo = total` en cada balance de inventario       | El inventario descuadrado rompe la utilidad     |
| El costo promedio se recalcula en cada entrada                 | Costear con el último precio falsea la utilidad |
| Sumar y restar dinero es coherente con el redondeo explícito   | Los centavos de deriva se acumulan              |

Las propiedades se escriben con `fc.property` y arbitrarios acotados (`moneyArb` genera
centavos enteros no negativos dentro de un rango razonable). Cuando una propiedad falla,
`fast-check` reproduce el caso mínimo: ese caso se agrega como ejemplo fijo.

## Pruebas de validación

`packages/validation/test/schemas.test.ts` cubre los esquemas Zod, con énfasis en las
reglas que impiden datos sucios: fecha inválida, cantidad cero, descuento mayor que el
subtotal y venta a crédito sin fecha de vencimiento (que lanzaría una cuenta por cobrar
que nunca vence y desaparece de los reportes de antigüedad).

## Pruebas de base de datos

La base de datos tiene su propia suite en `supabase/tests/`, escrita con
[pgTAP](https://pgtap.org/). No es una Suite más: es la única que puede comprobar que el
aislamiento entre inquilinos funciona.

```bash
pnpm db:start     # levanta Supabase local (requiere Docker)
pnpm db:reset     # aplica migraciones desde cero y carga el seed
pnpm db:test      # ejecuta supabase/tests
pnpm db:stop
```

### Qué protege

Una política de RLS que deja pasar de más **también pasa las pruebas de sintaxis**.
`supabase db lint` valida que el esquema sea legal, no que un usuario no pueda leer lo de
otro. Esa clase de bug no se ve hasta que alguien lee un dato ajeno, así que la suite
prueba el aislamiento directamente:

| Archivo                        | Qué prueba                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `01_multitenant_rls.test.sql`  | Aislamiento entre organizaciones, denegaciones por permiso, contexto de organización |
| `02_invitations.test.sql`      | Token de invitación: entropía, uso único y vínculo con el correo                     |
| `03_ownership.test.sql`        | Un único propietario por organización y las reglas de su transferencia               |
| `04_tenant_integrity.test.sql` | Que ninguna fila pueda colgar de algo de otra granja                                 |

Cada archivo es una transacción con `rollback`, así que se pueden declarar helpers sin
contaminar el siguiente archivo. Las aserciones corren con el rol `authenticated` puesto,
porque la consulta que se evalúa **dentro** de `is(...)` tiene que sufrir los grants y las
políticas reales: si el papel se quedara en superusuario, el RLS se saltaría y la prueba
mediría lo contrario de lo que dice medir.

`04_tenant_integrity.test.sql` es la excepción deliberada, y por eso lleva el motivo
escrito en la cabecera: corre **sin** cambiar de rol a propósito. Una referencia cruzada
entre granjas también fallaría por RLS, así que con el rol puesto la prueba daría verde
aunque la clave foránea no existiera. Solo escribiéndolas como el dueño del esquema — donde
RLS no se aplica — se puede afirmar que la integridad la garantiza la base y no una
política.

### La invariante del propietario necesita su propio archivo

`03_ownership.test.sql` existe por una razón técnica concreta: la regla de "exactamente un
propietario activo" se comprueba con un trigger **diferido**, y un trigger diferido se
dispara en el `COMMIT`. Una aserción normal nunca llega ahí, así que el archivo hace

```sql
set constraints all immediate;
```

para convertir la comprobación en inmediata y poder capturarla con `throws_ok`. Sin esas
líneas, las tres comprobaciones de la invariante pasarían sin estar probando nada. Es el
único archivo donde `rollback` es la última instrucción y no un detalle: el error que se
quiere provocar, si no se captura, aborta la transacción entera.

La transferencia se llama **una sola vez** y su resultado se guarda en una tabla auxiliar
antes de comprobarlo: la segunda llamada fallaría, porque quien la invoca ya no es el
propietario.

### Por qué no se ejecutan en local sin Docker

`supabase start` necesita Docker. En una máquina que no lo tiene, estas pruebas **no se
ejecutan**, y eso hay que decirlo claro: hasta que el job `migrations` del CI pase en
verde, el esquema de la Fase 2 está escrito pero no verificado contra PostgreSQL. Un
`pnpm test` en verde no dice nada sobre el SQL.

El job ejecuta, en este orden:

1. `supabase start` + `pnpm db:reset` — aplica **todas** las migraciones desde cero y
   carga el seed. Es la única forma de detectar una migración mal ordenada.
2. `pnpm db:lint` — valida el esquema resultante.
3. `pnpm db:test` — ejecuta pgTAP contra ese esquema.

## Qué NO está cubierto todavía

Ser honesto sobre esto importa más que la cobertura:

- **Las apps no tienen pruebas de componentes ni de integración.** `apps/web` y
  `apps/mobile` exponen `lint` y `typecheck`, no `test`.
- **No hay E2E.** Se agrega cuando exista un flujo real de registro sobre la base.
- **Las pruebas SQL cubren la frontera, no el negocio.** No hay pruebas de ventas,
  inventario ni producción: son los módulos de las fases siguientes.
- **`pnpm tooling:check-schema` no es una prueba de base de datos.** Compara que los
  permisos del seed coincidan con los de TypeScript, que toda tabla tenga RLS y que los
  `GRANT`/`REVOKE` de las migraciones, aplicados en orden, dejen cada tabla alcanzable.
  Es una red contra el error más probable al escribir código nuevo, no un sustituto de
  `db:test`.

### Por qué el simulador de permisos existe

`GRANT`, `REVOKE` y RLS son capas que se pisan, y su error más caro es silencioso. Si una
migración ejecuta `revoke all on all tables in schema core` **después** de que otra
concediera permisos, la tabla queda viva y con sus políticas correctas, pero
inalcanzable: el SQL se escribe bien, todas las consultas fallan al ejecutarse con
`permission denied`, y ni el linter ni TypeScript lo notan. Por eso `check-schema`
simula el estado de permisos en el orden en que PostgreSQL aplicaría las migraciones y
falla si:

1. una migración borra los permisos que otra ya concedió, o
2. una tabla con RLS termina sin ningún permiso para `anon` ni `authenticated`.

Ambas reglas tienen prueba negativa: reintroducir el bug a mano hace fallar el comando.

## Comandos

```bash
pnpm test                 # toda la suite de TypeScript
pnpm test:coverage        # con cobertura
pnpm --filter @agroemprende/calculations test
pnpm test:watch

pnpm tooling:check        # reglas de migración + coherencia esquema/código
pnpm db:test              # pgTAP (requiere Docker)
```

`turbo.json` define `test.outputs` como `[]` a propósito: las pruebas no producen
artefactos que convenga cachear, y declarar `coverage/**` en `test` haría que un cache hit
restaurara archivos viejos. `pnpm tooling:check` y `pnpm db:test` viven **fuera** de
turbo a propósito: no dependen del grafo de paquetes, y `db:test` necesita un servicio
levantado que turbo no sabe levantar.

## Reglas para escribir pruebas

1. Una prueba describe el **comportamiento esperado**, no la implementación. Si el
   refactor cambia la estructura interna y la prueba falla, la prueba estaba atada a los
   detalles.
2. Las funciones de cálculo son puras y reciben `today: IsoDate` explícito. No se usa
   `new Date()` dentro de una prueba: el resultado dejaría de ser determinista.
3. Todo importe se construye con `pesosToMoney` o `toMoney`, nunca con un número pelado.
   Mezclar `Money` con `number` es un error de compilación (`TS2322`), y está bien que lo
   sea.
4. Si una prueba falla porque el código está mal, se arregla el código. Ajustar la
   expectativa para que pase es cómo un bug entra en producción con sello de verde.
5. Un bug encontrado en producción primero se reproduce como prueba que falla, y después
   se corrige.
