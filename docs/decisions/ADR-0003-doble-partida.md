# ADR-0003 — Venta y pago son hechos distintos: doble partida

- Estado: Aceptado
- Fecha: 2026-09-27

## Contexto

Un sistema de ventas para granjas tiene que responder dos preguntas que se confunden
constantemente: "¿cuánto vendí?" y "¿cuánto me han pagado?". La diferencia no es
académica. Una venta a crédito de 30 días genera ingreso hoy y caja dentro de un mes, y
un pago de un saldo de meses anteriores genera caja hoy e ingreso hace meses.

El error clásico en este tipo de software es tratar la venta como si fuera el pago:
registrar un solo movimiento y llamarlo "ingreso". Con eso los reportes de utilidad
mienten (se registra ingreso de lo que nadie ha pagado) y el flujo de caja miente (no se
ve el cobro).

## Decisión

Separamos los dos hechos y los llevamos a un libro mayor de doble partida.

- `Sale` es la **obligación comercial**: genera ingreso y, si es a crédito, una cuenta por
  cobrar con fecha de vencimiento.
- `Payment` es el **hecho de caja**: reduce el saldo de la cuenta por cobrar.

Consecuencias:

1. El ingreso se contabiliza **una sola vez**, en el momento de la venta. El pago nunca
   vuelve a generar ingreso.
2. Un pago se aplica a cuentas por cobrar concretas, en orden, mediante
   `allocatePayments`. El saldo de un cliente es `original − abonos`, y nunca es negativo:
   un abono que excede la deuda genera un saldo a favor, no un negativo.
3. La cuenta por cobrar es un saldo, no un documento aislado. Su estado
   (`PENDIENTE`, `PARCIAL`, `PAGADA`, `VENCIDA`) se deriva del saldo y de la fecha de
   vencimiento, nunca se escribe a mano.
4. Los asientos del libro mayor son inmutables. Una venta anulada no se borra: se reversa
   con un asiento de contra-parte, y el asiento original queda en el histórico.

## Alternativas descartadas

- **Un solo movimiento "venta"**: descartada. Confunde utilidad con caja y hace
  imposible un reporte de cartera real.
- **Recibos como tabla aparte sin relación con la venta**: descartada. Un pago parcial
  quedaría sin saber a qué venta se aplica y el saldo no se podría auditar.
- **Contabilidad de caja simple** (solo se registra lo cobrado): descartada. Pierde el
  pasivo y no cumple la promesa de "saber si me deben".

## Consecuencias

- El motor de cálculo expone `calculateReceivableBalance`, `allocatePayments` y
  `resolveReceivableStatus`, y sus invariantes están cubiertos por pruebas de
  propiedades.
- Las escrituras de ventas, pagos y gastos pasan por funciones SQL, no por `insert()`
  directo, para que el asiento y el documento queden en la misma transacción.
- La anulación de una venta es un permiso aparte (`finance.sales.void`) y queda auditada.
