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

## Qué NO está cubierto todavía

Ser honesto sobre esto importa más que la cobertura:

- **Las apps no tienen pruebas de componentes ni de integración.** `apps/web` y
  `apps/mobile` exponen `lint` y `typecheck`, no `test`. Faltan las pruebas de las
  funciones SQL (`supabase test db`) porque todavía no hay esquema.
- **No hay E2E.** Se agrega en la Fase 2, cuando exista un flujo real de registro.
- **No hay prueba de migraciones.** `pnpm tooling:check-migrations` valida las reglas de
  nombre y contenido, no que el esquema resultante sea el correcto.

## Comandos

```bash
pnpm test                 # toda la suite
pnpm test:coverage        # con cobertura
pnpm --filter @agroemprende/calculations test
pnpm test:watch
```

`turbo.json` define `test.outputs` como `[]` a propósito: las pruebas no producen
artefactos que convenga cachear, y declarar `coverage/**` en `test` haría que un cache hit
restaurara archivos viejos.

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
