# Costeo

Cómo se reparte el costo entre lotes, cerdos y cortes, y qué se hace cuando un costo
falta. Este documento describe el comportamiento; la razón de fondo está en
[ADR-0008](../decisions/ADR-0008-costo-promedio.md) y en el principio de
[no inventar datos](../decisions/ADR-0011-datos-reales.md).

## Regla general

El costo de producción se compone de:

1. **Costos directos del lote o ciclo**: compra de los animales, alimento, agua,
   medicina, transporte, mano de obra asignada, infraestructura cuando es
   identificable.
2. **Costos indirectos de la unidad de negocio**: se reparten por un criterio explícito y
   documentado (por ave, por m², por ciclo), nunca por intuición. Si no hay criterio
   acordado, el reparto queda pendiente.

Nada de esto se calcula en la pantalla: todo sale de `@agroemprende/calculations`.

## Alimento (el caso más importante)

Es el mayor costo de una granja avícola y porcícola, así que su cálculo está aparte en
`feed.ts`.

- El consumo se registra por lote/ciclo, fecha y fuente: `measured` (pesado en campo) o
  `estimated` (el usuario no lo pesó). El campo `isEstimated` viaja siempre: un consumo
  estimado se muestra como estimado, y los reportes pueden separarlos.
- El costo del alimento se conoce de dos maneras: el precio del saco (si el usuario lo
  conoce) o la **referencia de Parameters** (`reference`, 18.000 COP por cubeta es un
  ejemplo de precio de referencia, no un costo histórico). Si no hay ninguno de los dos,
  el costo por ave y por huevo quedan **pendientes**, no en cero.
- `calculateFeedConsumption` convierte gramos por ave × número de aves a kilos, aplica el
  precio y devuelve el total. `feedCostPerBird` y `feedCostPerEgg` son los derived que
  se muestran en pantalla; `summarizeFeedCosts` agrega un período.
- Un lote en fase de pollito, pollina o ponedora tiene distinto requerimiento: la
  conversión de gramos a kilos es siempre la misma, pero el valor por ave cambia con la
  fase, y eso lo decide el usuario con el dato real, no una tabla inventada.

## Agua

El costo por litro es **opcional a propósito** (§14: no inventar el costo real del agua).
Si el usuario no lo conoce, se registra el consumo en litros y el costo queda `NULL`,
marcado como pendiente. Se puede conocer el consumo sin conocer el costo: son dos hechos
independientes y la app los trata así.

## Aves: producción y postura

- Se registra **huevos buenos**, y por separado rotos, pequeños y mermas. Las mermas se
  informan aparte: no se descuentan de la producción para "suavizar" la postura.
- El promedio, el mejor día, el peor día, los huevos por ave y el margen se calculan
  **sobre huevos buenos**.
- La postura es un porcentaje con base 100 (`posturaBase` 30 huevos por cubeta es un
  parámetro `configured` del sistema). El porcentaje se calcula sin redondear y se
  redondea una sola vez al presentar, para no acumulado error.
- El margen por huevo es `(precio − costo variable por huevo) / precio`, con el precio de
  referencia del momento (`reference`, no histórico). Si el usuario no tiene precio de
  referencia, el margen queda pendiente.

## Cerdos: costo y rendimiento

- Cada cerdo tiene identidad individual. Pesos, sacrificios y cortes se registran por
  cerdo, con `method` que distingue báscula real de estimación.
- El rendimiento en canal (`calculateCarcassYield`) **solo** se calcula si hay peso de
  canal real. Con un solo peso no se inventa el otro: la fórmula `canal / vivo` necesita
  ambos, y estimar uno para "completar" el cálculo es exactamente el error que este
  proyecto evita.
- El costo del cerdo se acumula a lo largo de su vida (compra, alimento, medicina,
  transporte) y se reparte entre los cortes que salen de él, de forma que la suma de los
  costos de los cortes sea igual al costo total del cerdo (`reconcileCutsWithCarcass`).
- El subproducto (sangre, menudo, hueso) se puede valorar a precio de referencia o
  quedar `NULL`; no se inventa su valor. Si no tiene precio, es un costo asumido por el
  canal principal y queda registrado como tal.

## Inventario y promedio ponderado

Cuando un lote de compra entra con costo, el costo promedio del inventario se recalcula
y ese promedio es el que se aplica a las salidas posteriores. Ver
[ADR-0008](../decisions/ADR-0008-costo-promedio.md). `calculateInventoryBalance` mantiene
consistente `cantidad × costo = total` en cada balance.

## Reinversión y utilidad

`calculateReinvestmentImpact` responde "¿si en vez de vender esa vaca o ese lote hubiera
reinvertido, qué habría pasado?" Compara el flujo de caja reinvertido contra el flujo de
la venta, sin contar dos veces el mismo peso: la venta a crédito sale del resultado
comercial, el cobro sale del flujo de caja. Ver [ADR-0003](../decisions/ADR-0003-doble-partida.md).

Todo esto vive en `packages/calculations/src/` y está cubierto por pruebas de propiedades
(ver [testing](../testing.md)). Si un cálculo de costeo aparece en un componente, es un
error de arquitectura.
