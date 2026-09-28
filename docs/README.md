# Documentación de AgroEmprende

Este directorio es la referencia del proyecto. Si una regla aparece en el código y en
aquí, y el código dice otra cosa, el código está mal.

## Orden de lectura sugerido

Quien llega nuevo al proyecto debería leer, en este orden:

1. `../README.md` — qué es el proyecto y cómo se ejecuta.
2. [Principios de negocio](principios.md) — las reglas que no se negocian.
3. [Testing](testing.md) — qué está cubierto por pruebas y qué no.
4. Los registros de decisión de abajo, según el área en la que trabajes.
5. [Arquitectura](architecture/) — seguridad y datos.
6. [Base de datos](database/) — esquema, migraciones y costeo.

## Decisiones registradas (ADR)

Un ADR captura el _porqué_ de una decisión y las alternativas que se descartaron. No se
editan: un ADR que ya no describe la realidad se reemplaza por otro más nuevo.

| ADR                                                   | Decisión                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| [ADR-0003](decisions/ADR-0003-doble-partida.md)       | Venta y pago son hechos distintos; todo va al libro mayor           |
| [ADR-0004](decisions/ADR-0004-unidades-de-negocio.md) | Cada libro es de una unidad de negocio y las unidades no se mezclan |
| [ADR-0006](decisions/ADR-0006-dinero-en-centavos.md)  | El dinero es un entero de centavos                                  |
| [ADR-0008](decisions/ADR-0008-costo-promedio.md)      | El inventario se costea con promedio ponderado móvil                |
| [ADR-0011](decisions/ADR-0011-datos-reales.md)        | El sistema no inventa datos y el seed nunca trae datos reales       |
| [ADR-0012](decisions/ADR-0012-fechas-de-negocio.md)   | Las fechas de negocio son fechas, no instantes                      |

## Arquitectura

- [Autenticación y organizaciones](architecture/auth.md) — registro, organizaciones,
  roles y el límite del multitenant.
- [Row Level Security](architecture/rls.md) — por qué la base de datos es la autoridad
  y qué se hace con las escrituras.

## Base de datos

- [Migraciones](database/migrations.md) — nombre, cabeceras, qué está prohibido y el
  flujo de trabajo. Las verifica `pnpm tooling:check-migrations`.
- [Costeo](database/costing.md) — cómo se reparte el costo del alimento, del agua y de
  la mano de obra entre lotes, cerdos y cortes.

## Referencia rápida

| Tema               | Regla                                                       |
| ------------------ | ----------------------------------------------------------- |
| Dinero             | Entero de centavos, `ROUND_HALF_UP`, sin `float`            |
| Fechas de negocio  | `IsoDate` (`YYYY-MM-DD`), nunca `Date`                      |
| Fechas de instante | `IsoDateTime` en UTC con `Z`                                |
| Datos faltantes    | `InsufficientData<T>`, nunca un valor por defecto inventado |
| Moneda             | Solo COP en v1. Sin IVA, retenciones, ICA ni DIAN           |
| Identificadores    | UUID con marca de dominio por tabla                         |
| Imports relativos  | Sin extensión                                               |
