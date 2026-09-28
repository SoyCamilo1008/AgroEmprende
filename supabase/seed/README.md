# Seed de desarrollo

Este directorio contiene **datos de plantilla**, nunca datos reales del negocio.

## Qué contiene

`seed.sql` carga **cinco** cosas, y ninguna es un dato de negocio:

| Sección                          | Qué carga                                                      |
| -------------------------------- | -------------------------------------------------------------- |
| 1. Permisos                      | 55 códigos de permiso, réplica de `PERMISSIONS` en TypeScript  |
| 2. Roles                         | `owner`, `admin`, `manager`, `operator`, `viewer` con su rango |
| 3. Matriz rol → permiso          | Quién tiene qué, expresada por reglas (no fila por fila)       |
| 4. Unidades de medida            | 9 códigos con su factor de conversión a la base                |
| 5. Plantilla del plan de cuentas | Las cuentas base que el onboarding copia en cada organización  |

Los permisos y los roles son la **definición del sistema**, no información de un cliente:
viven en tablas globales sin `organization_id`. Por eso se siembran.

## Qué NO contiene, y por qué

- **Organizaciones, unidades de negocio, clientes, contactos y proveedores.** Son datos de
  una granja real. El único camino para crearlos es el onboarding y las invitaciones, que
  son funciones con auditoría: nada entra por la puerta de atrás.
- **Parámetros de referencia.** Un parámetro como «huevos por cubeta» depende del manejo
  de cada granja y de la fecha; un valor sembrado en la base sería un hecho inventado
  presentado como configuración. Ver
  [ADR-0011](../../docs/decisions/ADR-0011-datos-reales.md).
- **Unidades de negocio de ejemplo.** Una unidad de negocio es la frontera contable
  (ADR-0004). Sembrar granjas ficticias haría que un entorno de desarrollo pareciera
  tener datos reales, que es justo el error que este directorio existe para evitar.

## Idempotencia

`supabase db reset` y `supabase start` ejecutan el seed más de una vez sobre la misma
base, así que **todo `insert` lleva `on conflict`**. Un seed que falla en la segunda
ejecución rompe el arranque local de todo el equipo.

## Verificación

```bash
pnpm tooling:check-schema   # permisos y roles del seed contra packages/types/src
pnpm db:reset               # aplica migraciones + seed (requiere Docker)
```

`check-schema` existe por una razón concreta: RLS consulta los permisos **por nombre**. Un
permiso agregado en TypeScript y olvidado en el seed no da error, deniega el acceso en
silencio. El verificador compara los dos lados y falla antes de que eso llegue a `main`.

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

Cuando un parámetro de referencia se cree (hoy la tabla existe vacía a propósito), su valor
lleva `data_kind` para que ninguna pantalla lo presente como hecho:

| `data_kind`  | Significado                               | Ejemplo                       |
| ------------ | ----------------------------------------- | ----------------------------- |
| `measured`   | Medido en campo                           | 1.200 g consumidos por ave    |
| `historical` | Hecho consumido y registrado              | inversión del galpón en 2026  |
| `reference`  | Precio de referencia actual, no histórico | 18.000 COP por cubeta         |
| `planned`    | Supuesto de planificación                 | 5 sacos de alimento por cerdo |
| `configured` | Parámetro del sistema                     | 30 huevos por cubeta          |

Ver [ADR-0011](../../docs/decisions/ADR-0011-datos-reales.md).
