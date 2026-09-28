# Seed de desarrollo

Este directorio contiene **datos de plantilla**, nunca datos reales del negocio.

## Qué contiene

- `seed.sql` — roles del sistema, catálogo de permisos, cuentas contables base,
  unidades de negocio de ejemplo y parámetros de referencia etiquetados.

## Qué NO debe contener nunca

- Nombres, teléfonos o documentos de clientes reales.
- Montos de ventas, pagos o deudas reales.
- Datos productivos reales (lotes con fechas reales, pesos de cerdos reales).
- Cualquier valor tomado de una base de datos de producción.

Si necesitas cargar datos reales en un entorno privado, usa
`supabase/seed/private/` (ignorado por git) y un script local:

```bash
pnpm db:reset                      # entorno limpio con plantillas
# carga manual o script propio contra el proyecto privado
```

## Cómo se documenta un dato

Todo valor de referencia en el seed va en `core.reference_parameters` con su
clasificación explícita, para que ninguna pantalla lo presente como hecho:

| data_kind    | Significado                               | Ejemplo                       |
| ------------ | ----------------------------------------- | ----------------------------- |
| `measured`   | Medido en campo                           | 1.200 g consumidos por ave    |
| `historical` | Hecho consumado y registrado              | inversión del galpón en 2026  |
| `reference`  | Precio de referencia actual, no histórico | 18.000 COP por cubeta         |
| `planned`    | Supuesto de planificación                 | 5 sacos de alimento por cerdo |
| `configured` | Parámetro del sistema                     | 30 huevos por cubeta          |

Ver docs/decisions/ADR-0011.
