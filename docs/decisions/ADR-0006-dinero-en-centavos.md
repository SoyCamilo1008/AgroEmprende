# ADR-0006 — El dinero es un entero de centavos

- Estado: Aceptado
- Fecha: 2026-09-27

## Contexto

En JavaScript no existe un entero de 64 bits. `number` es un `float` de 53 bits, y un
centavo con muchos decimales no se representa exacto. La forma habitual de guardar dinero —
`0.1 + 0.2`— produce `0.30000000000000004`. Repetido en miles de líneas de venta, un
reporte termina con centavos de diferencia que el usuario no puede explicar y que nadie
sabe corregir.

## Decisión

El dinero es un **entero de centavos**, en `number`, y solo se convierte a pesos en el
momento de mostrarlo.

- `Money` es un entero de centavos. `toMoney(pesos)` y `pesosToMoney(centavos)` son las
  únicas puertas de entrada; el resto del sistema opera en centavos.
- El redondeo es explícito y ocurre una sola vez por operación, en el borde:
  `ROUNDING_MODE = ROUND_HALF_UP`. Un porcentaje se redondea al centavo, no al peso.
- Un descuento mayor que el subtotal lanza `RangeError` en vez de producir un total
  negativo. Un saldo de cliente nunca es negativo: el exceso es saldo a favor.
- En PostgreSQL el monto se guarda como `NUMERIC(18,2)`, que sí es decimal exacto. La
  conversión ocurre en el borde de la función SQL, nunca en la lógica de negocio.
- El porcentaje de postura y otros ratios se calculan sin redondear y se redondean una
  sola vez al presentar. Redondear el ratio y luego multiplicar por el número de aves
  acumula error por la vía larga.

## Alternativas descartadas

- **`number` en pesos**: descartada. Es la causa directa del error de centavos.
- **`big.js` o `decimal.js`**: descartada por ahora. Aporta precisión, pero obliga a
  serializar y deserializar en cada frontera (JSON, SQL, React) y el equipo termina
  escribiendo aritmética a mano igual. Volveremos a evaluarla cuando v2 tenga múltiples
  monedas o impuestos que exijan más de dos decimales.
- **Enteros de 64 bits con `BigInt`**: descartada. `BigInt` no es serializable por
  `JSON.stringify` y complica cada llamada a la base de datos sin ganancia real, porque
  dos decimales caben sin problemas en un entero de 53 bits.

## Consecuencias

- `packages/calculations/src/money.ts` es la única fuente de aritmética monetaria, y sus
  invariantes están cubiertos por pruebas de propiedades.
- `@agroemprende/types` exporta `toMoney` para que las apps no construyan centavos a mano.
- El motor calcula en centavos de punta a punta. La conversión a pesos ocurre en
  `formatMoney` y en el componente de presentación.
- La forma tipada `Quantity` (decimal) es independiente de `Money`: comparar
  cantidades con centavos es un error de compilación, no un bug de redondeo.
