# ADR-0008 — Inventario con promedio ponderado móvil

- Estado: Aceptado
- Fecha: 2026-09-27

## Contexto

La carne no se compra toda a la misma vez ni al mismo precio: cada lote de compra tiene
un costo distinto. Si se vende usando "el último precio" se falsea el costo de ventas. Si
se usa LIFO o FIFO se complica mucho para una granja pequeña, y además cambia el margen
según el orden de salida (no auditado).

Para que un reporte de utilidad sea creíble, el costo de lo que salió debe tener relación
con lo que se pagó por ello.

## Decisión

El inventario se valoriza con **promedio ponderado móvil**. Cada vez que entra inventario
(con un costo conocido), el costo promedio por unidad cambia y afecta a las salidas
posteriores.

Reglas:

1. Cada lote de inventario tiene su balance (`quantity`, `averageCost` en centavos por
   unidad, `totalCost`). No se mezclan lotes distintos a menos que la unidad lo exija.
2. Al recibir (compra, sacrificio con valor de carne, ajuste positivo), si el costo es
   conocido: se recalcula `averageCost = (saldo_total_centavos + entrada_total_centavos) /
(saldo_cantidad + entrada_cantidad)`, redondeando al centavo.
3. Al despachar (venta, consumo, merma registrada), se aplica el costo promedio vigente
   en ese momento, no el precio de compra.
4. Si el costo de una entrada no es conocido, **no se inventa**. El resultado de valor
   de inventario es `InsufficientData<InventoryBalanceResult>` y la pantalla muestra
   "costo pendiente". Esto evita mezclar dato real con dato supuesto y obliga a completar
   la información.
5. Las mermas disminuyen cantidad, pero no crean ingreso; se reportan aparte.
6. La trazabilidad existe: `traceMeatLot` permite seguir qué salió de qué lotes (para
   cerdos, esto incluye canal y cortes) para que el reporte de rendimiento sea auditable.

## Alternativas descartadas

- **FIFO**: teóricamente más exacto, pero requiere mantener lotes individuales y su costo
  cambia con la rotación. Para una granja con pocas compras es más código, menos claro
  para el usuario y difícil de explicar en el reporte.
- **LIFO**: no representa lo que realmente ocurrió (la granja no consume lo comprado más
  recientemente primero).
- **Último precio conocido**: es el error más común: sube el margen cuando subió el precio
  ayer pero el saco de hace tres semanas estaba más barato.
- **Inventar costo cuando falta**: descartado explícitamente. Es lo contrario al
  principio de no inventar datos.

## Consecuencias

- `packages/calculations/src/inventory.ts` implementa `calculateWeightedAverageCost`,
  `calculateInventoryBalance` y `reconcileCutsWithCarcass`.
- Las pruebas verifican que, cuando hay varias entradas, el costo de una salida intermedia
  es el promedio en ese instante, y que el balance total es consistente.
- Las pantallas que muestran valor de inventario deben contemplar el estado "pendiente"
  (datos insuficientes), no mostrar "0".
