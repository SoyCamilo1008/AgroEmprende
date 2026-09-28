# ADR-0004 — Cada libro es de una unidad de negocio

- Estado: Aceptado
- Fecha: 2026-09-27

## Contexto

Una explotación avícola y una porcícola no se comportan igual: el alimento se consume en
gramos por ave y en kilos por cerdo, los lotes viven meses contra ciclos de meses, los
ingresos vienen por venta de huevos y por venta de carne. Sumar sus costos en un mismo
libro produce un número que no describe a nadie.

Además, una misma organización puede manejar varias granjas, y el dueño necesita ver cada
una por separado y el consolidado de todas.

## Decisión

La **unidad de negocio** (`business_unit`) es la frontera contable. Cada libro, cada
reporte y cada movimiento pertenece a exactamente una unidad.

- `businessUnitId` es obligatorio en lotes, ciclos, ventas, pagos, gastos, inventario y
  consumos. No es opcional "porque luego se sabe".
- Un movimiento sin unidad es un error de validación, no un registro pendiente de clasificar.
- El consolidado de la organización se calcula sumando unidades ya calculadas. Nunca se
  suman filas crudas de unidades distintas.
- Un cliente es global para la organización; la unidad vive en las líneas del movimiento.
  Ver [ADR-0003](ADR-0003-doble-partida.md).
- Las unidades de medida no se mezclan dentro de una misma dimensión: el alimento se mide
  en gramos o kilos, los huevos en unidades, el agua en litros. Cada conversión es
  explícita y vive en `@agroemprende/types`, que es la única fuente de `MEASURE_UNITS`.

## Alternativas descartadas

- **Una sola unidad implícita (la granja)**: descartada. Impide operar dos granjas de la
  misma organización y hace imposible auditar el costo de un lote.
- **Unidad opcional, se llena después**: descartada. El dato que falta se llena cuando ya
  no se puede reconstruir y el reporte queda mal sin que nadie lo note.
- **Costos directamente a nivel de organización**: descartada. El pollo y el cerdo tienen
  estructuras de costo distintas y el reparto deja de ser explicable.

## Consecuencias

- `BusinessUnit`, `BusinessUnitScope` y `BUSINESS_UNIT_TYPES` viven en
  `@agroemprende/types` y se replican en `core.business_units`.
- El selector de unidad es un control global de la aplicación, no un filtro opcional: las
  pantallas de detalle solo cargan la unidad seleccionada.
- Los permisos de escritura se evalúan contra la unidad, de modo que un operador de una
  granja no puede escribir en otra aunque tenga el permiso global.
