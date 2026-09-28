# Principios de negocio

Estos principios no son preferencias de estilo. Cada uno existe porque romperlo produce
un error silencioso: un número que parece correcto y no lo es. Cuando código y principio
se contradigan, el código está mal.

## 1. El sistema no inventa datos

Si un valor no se conoce, se pide al usuario o se guarda como `NULL` marcado como
pendiente. Nunca se rellena con un promedio, con un valor "típico" de la industria ni con
un cero disfrazado de dato.

En el código esto se expresa con el tipo `InsufficientData<T>`:

```ts
type InsufficientData<T> = { ok: true; value: T } | { ok: false; missing: readonly string[] };
```

Las funciones de cálculo reciben ese tipo en lugar de un `default`, así que el compilador
obliga a manejar el caso "no se sabe". Ejemplos reales: el costo por litro de agua es
opcional a propósito, y el rendimiento en canal no se calcula sin el peso de la canal.

Ver [ADR-0011](decisions/ADR-0011-datos-reales.md).

## 2. El dinero es un entero de centavos

Un peso es un entero de centavos. Nada de `float`, nada de `number` para dinero. El
redondeo es explícito (`ROUND_HALF_UP`) y ocurre en un solo lugar por operación, nunca de
forma implícita al guardar.

Una venta es `unitPrice × quantity` en centavos; el precio unitario se puede editar en
cada venta, y el descuento nunca puede superar el subtotal: eso lanza `RangeError` en vez
de producir un total negativo.

Ver [ADR-0006](decisions/ADR-0006-dinero-en-centavos.md).

## 3. Vender no es recibir dinero

Una venta a crédito es una obligación comercial, no un ingreso en caja. Son dos hechos
distintos con dos fechas distintas:

- `Sale` → genera ingreso y cuenta por cobrar.
- `Payment` → hecho de caja que reduce la cuenta por cobrar.

Por eso el ingreso se contabiliza **una sola vez**, en el libro mayor, y los reportes de
utilidad y de flujo de caja no pueden contar el mismo peso dos veces.

Ver [ADR-0003](decisions/ADR-0003-doble-partida.md).

## 4. Cada libro es de una unidad de negocio

Pollos, cerdos y cada granja tienen sus propios costos y sus propios lotes. El consolidado
de la organización se calcula sumando unidades, nunca mezclando gastos en un mismo libro.

El `businessUnitId` viaja explícito en cada movimiento. El reporte por unidad se puede
auditar; el consolidado se puede reconstruir.

Ver [ADR-0004](decisions/ADR-0004-unidades-de-negocio.md).

## 5. El cliente es global, el movimiento no

El cliente es una entidad única de la organización: no se duplica por unidad de negocio.
Sus compras sí pertenecen a una unidad concreta, y por eso `businessUnitId` va en las
líneas de la venta, no en el cliente.

Esto evita el clásico problema de "el mismo cliente con tres fichas" y de saldos que no
cuadran al consolidar.

## 6. Las fechas de negocio son fechas

Producción, venta y pago ocurren en un día del calendario del negocio, no en un instante.
Por eso son `IsoDate` (`YYYY-MM-DD`) y nunca `Date`: un `Date` depende de la zona horaria
del navegador y un registro hecho a las 11:59 p. m. se desplaza al día siguiente.

Ver [ADR-0012](decisions/ADR-0012-fechas-de-negocio.md).

## 7. El inventario se costea con promedio ponderado móvil

Cada entrada y cada salida se valoran al costo promedio vigente en ese momento, que
cambia con cada compra. El costo de un lote de producción se compone del promedio de sus
entradas, no del precio que alguém recuerda.

Cuando hay un dato de costo desconocido, el resultado se marca como pendiente en vez de
asumir el último costo conocido.

Ver [ADR-0008](decisions/ADR-0008-costo-promedio.md) y [Costeo](database/costing.md).

## 8. Las mermas se informan, no se promedian

La producción se mide con huevos buenos. Las mermas, los huevos rotos y los pequeños se
registran y se reportan por separado. El promedio de huevos por ave, el mejor día, el peor
día y el margen se calculan sobre huevos buenos: mezclar mermas con producción real
subestima el rendimiento de la granja y hace que un buen día parezca malo.

## 9. Solo COP, sin impuestos en v1

v1 maneja únicamente pesos colombianos. No hay IVA, retenciones, ICA ni DIAN. La
estructura de las tablas deja espacio para añadirlos después, pero el motor de cálculo no
los implementa: una obligación que no se puede cumplir no debe aparecer en un reporte
como si estuviera cubierta.

## 10. AgroIA propone, la persona decide

El asistente no escribe en la base de datos por su cuenta. Declara qué datos necesita,
si no los tiene lo dice, propone la acción con los valores que usó y espera confirmación.
La ejecución pasa por los mismos permisos y la misma validación que una acción manual.

Ver [ADR-0011](decisions/ADR-0011-datos-reales.md) y [RLS](architecture/rls.md).
