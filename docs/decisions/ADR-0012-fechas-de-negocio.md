# ADR-0012 — Las fechas de negocio son fechas, no instantes

- Estado: Aceptado
- Fecha: 2026-09-27

## Contexto

Un lote de ponedoras produce huevos "hoy". Si "hoy" se guarda como un instante UTC
(`2026-09-27T02:00:00Z`), ese valor apunta a las 9:00 p. m. del 26 de septiembre en
Bogotá. Un registro hecho a las 11:59 p. m. en Colombia se guarda como el día siguiente,
y toda la história del lote aparece corrida un día.

Con lotes de 18 semanas y salidas de miles de huevos, un corrimiento de un día no es un
detalle cosmético: el costo diario del alimento se reparte entre días que no son los
reales, la postura por día se desplaza y los picos y caídas se inventan.

## Decisión

Separamos los dos conceptos con dos tipos distintos.

- `IsoDate` (`YYYY-MM-DD`) — **fecha de negocio**: producción, venta, pago, sacrificio,
  ajuste. Es lo que el usuario piensa cuando dice "ese día". No tiene zona
  horaria. Las fechas de negocio se interpretan en la zona horaria del negocio
  (`America/Bogota` por defecto en `NEXT_PUBLIC_DEFAULT_TIMEZONE`).
- `IsoDateTime` (ISO-8601 con `Z`) — **instante**: cuándo se creó una fila, cuándo se
  autenticó un usuario, cuándo se ejecutó una función. Esto sí se compara en tiempo
  absoluto y se muestra en la zona del usuario.

Reglas:

1. Las columnas de fecha de negocio en PostgreSQL son `date`, no `timestamptz`.
2. Un `Date` de JavaScript no se usa para fechas de negocio. `new Date('2026-09-27')` se
   interpreta en UTC y es la fuente clásica de este error.
3. Las comparaciones de antigüedad (vencimiento de cartera, días de un lote) comparan
   `IsoDate` contra `IsoDate`, nunca instantes. `daysOverdue` cuenta días calendario.
4. El "hoy" de la aplicación lo produce una única función a partir de la zona horaria
   del negocio, no `new Date()` en cada pantalla.

## Alternativas descartadas

- **`timestamptz` para todo**: descartada. Mezcla el instante del sistema con el día del
  negocio y hace imposible corregir un registro corrido sin saber la zona con la que
  se escribió.
- **`Date` de JavaScript**: descartada por la razón anterior.
- **Guardar el día como número**: descartada. No es legible ni consultable, y complica
  cada reporte.

## Consecuencias

- `@agroemprende/types` define `IsoDate` e `IsoDateTime` como tipos distintos para que el
  compilador rechace mezclarlos.
- `packages/calculations` recibe `today: IsoDate` como parámetro explícito en lugar de
  llamar a `new Date()` internamente, de modo que los cálculos son deterministas y
  testeables.
- `IsoDate` se valida con `isoDateSchema` (Zod) en la entrada y con `check` de Postgres
  (`YYYY-MM-DD`) en la base de datos.
- Los campos de auditoría (`created_at`, `updated_at`) sí son `timestamptz`.
