/**
 * El "hoy" del negocio para las pantallas de Next.js.
 *
 * ADR-0012, regla 4: lo produce UNA función a partir de la zona horaria del negocio,
 * no `new Date()` en cada pantalla. Este archivo es el que lee el entorno; el cálculo
 * puro vive en `@agroemprende/calculations` para que los tests puedan fijarle el
 * instante y no dependan del reloj ni de la zona de la máquina que corre la prueba.
 *
 * Una zona mal escrita en el entorno es un fallo de arranque deliberado: es mejor que
 * la aplicación no levante que mostrar vencimientos calculados con una fecha corrida.
 */
import { businessDateIn, DEFAULT_BUSINESS_TIME_ZONE } from '@agroemprende/calculations';
import type { IsoDate } from '@agroemprende/types';

/**
 * La zona horaria del negocio.
 *
 * Se lee de `NEXT_PUBLIC_DEFAULT_TIMEZONE` y, si no está, se usa la del proyecto.
 * `businessDateIn` valida la zona: un `America/NoExiste` lanza `RangeError` aquí y no
 * dos meses después cuando una cartera aparezca vencida el día equivocado.
 */
export const businessTimeZone = (): string =>
  process.env.NEXT_PUBLIC_DEFAULT_TIMEZONE?.trim() || DEFAULT_BUSINESS_TIME_ZONE;

/**
 * El día de hoy en el negocio.
 *
 * `now` es un parámetro para poder probar la pantalla con una fecha fija; por defecto
 * es el reloj del servidor, que es el único lugar donde una fecha de negocio se puede
 * decidir sin que el navegador del usuario diga una cosa y el servidor otra.
 */
export const businessToday = (now: Date = new Date()): IsoDate =>
  businessDateIn(businessTimeZone(), now);
