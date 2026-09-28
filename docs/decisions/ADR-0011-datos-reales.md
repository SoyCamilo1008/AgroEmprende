# ADR-0011 — El sistema no inventa datos y el seed nunca trae datos reales

- Estado: Aceptado
- Fecha: 2026-09-27

## Contexto

Un sistema de gestión se usa para tomar decisiones: "¿me conviene comprar más cerdos?",
"¿cuánto me están costando los huevos?", "¿me deben?". Si el software rellena huecos con
valores plausibles, esas decisiones se toman sobre ficción y el usuario no tiene forma de
saberlo. El daño no es un error visible: es una mala decisión de negocio.

Al mismo tiempo, un ambiente de demostración con datos inventados termina filtrándose a
producción, o se confunde con datos reales, o termina en un repositorio.

## Decisión

### Principio: no inventar

Si un valor no se conoce, se **pide** o se marca **pendiente**. Nunca se rellena.

En el código:

- `InsufficientData<T>` en lugar de valores por defecto.
- Los cálculos opcionales (costo de agua, rendimiento en canal, precio del agua) son
  opcionales **a propósito**; si faltan, el resultado es "pendiente", no cero.
- AgroIA declara qué datos necesita. Si no los tiene, lo dice con exactitud y no estima
  el número, aunque "suene" razonable. Cuando propone una acción, muestra los valores que
  usó y exige confirmación humana.
- Cada dato de referencia cargado por el sistema lleva su clasificación en
  `core.reference_parameters.data_kind`, para que ninguna pantalla lo presente como un
  hecho medido.

### Clasificación de datos de referencia

| `data_kind`  | Significado                               | Ejemplo                       |
| ------------ | ----------------------------------------- | ----------------------------- |
| `measured`   | Medido en campo                           | 1.200 g consumidos por ave    |
| `historical` | Hecho consumado y registrado              | inversión del galpón en 2026  |
| `reference`  | Precio de referencia actual, no histórico | 18.000 COP por cubeta         |
| `planned`    | Supuesto de planificación                 | 5 sacos de alimento por cerdo |
| `configured` | Parámetro del sistema                     | 30 huevos por cubeta          |

### Principio: el seed es plantilla

`supabase/seed/` contiene únicamente datos de plantilla: roles del sistema, catálogo de
permisos, cuentas base, unidades de ejemplo y parámetros etiquetados.

Nunca contiene nombres, teléfonos o documentos de clientes reales; montos de ventas,
pagos o deudas reales; datos productivos reales (fechas de lotes, pesos de cerdos); ni
ningún valor tomado de una base de producción.

Para cargar datos reales se usa `supabase/seed/private/` (ignorado por git) y un script
local. Ver `supabase/seed/README.md`.

## Alternativas descartadas

- **Valores "de ejemplo" dentro de la app (John Doe, 1000 COP)**: descartada. Se mezclan
  con los datos reales del usuario y nadie sabe cuáles son cuáles.
- **Defaults en los cálculos (costo de agua = 500 COP/litro)**: descartada. Un default
  silencioso se convierte en un "dato" en el primer reporte y nadie lo revisa jamás.
- **IA que rellena con "estimaciones razonables"**: descartada. La IA no sabe el costo del
  agua de esa granja; una estimación suya no es un dato, y presentarla como tal es peor
  que no tener el dato.

## Consecuencias

- Los reportes deben poder mostrar "pendiente" junto a los números, no solo números.
- Cada valor de referencia se etiqueta con su `data_kind` en la interfaz.
- Un PR que agregue un default numérico a una función de cálculo se rechaza en revisión.
- La tabla `core.reference_parameters` y su campo `data_kind` son parte del contrato de
  datos de v1, no un extra de la v2.
