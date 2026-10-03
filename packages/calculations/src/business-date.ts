import type { IsoDate } from '@agroemprende/types';

/**
 * El "hoy" del negocio (ADR-0012, regla 4).
 *
 * Por qué esta función existe
 * ---------------------------
 * Porque `new Date()` NO es la fecha de hoy del negocio. A las 11:30 p. m. del 1 de
 * octubre en Bogotá, UTC ya va en el 2 de octubre: el mismo momento es "1 de octubre"
 * para el granjero y "2 de octubre" para `toISOString()`. Todo lo que se guarda como
 * `date` en la base y todo lo que cuenta días quedaría corrido un día, y el corrimiento
 * se acumula: un lote de 18 semanas de producción apareceria empezando desde un día
 * equivocado y los picos de postura caen donde no son.
 *
 * Reglas que esta función respeta
 * -------------------------------
 * - Convierte el INSTANTE en la FECHA del negocio, no al revés. `new Date('2026-10-01')`
 *   sería UTC medianoche y en Bogotá sería el 30 de septiembre a las 7 p. m.: por eso
 *   nunca se construye una `IsoDate` desde un `Date`.
 * - Devuelve `YYYY-MM-DD` sin ninguna hora. La firma lo dice (`IsoDate`) y el
 *   ensamblado por partes lo garantiza, porque depender del formato de salida de un
 *   idioma cambia entre versiones de ICU sin avisar.
 * - Es pura: recibe el instante como parámetro y por defecto usa `new Date()`. Los
 *   tests la llaman con un instante fijo y por eso no dependen del reloj.
 *
 * Lo que NO hace: no sabe nada del negocio. No sabe si hoy es festivo, ni si el local
 * ya cerró su día. Eso es regla del negocio y vive en otro lado (ADR-0012 lo deja
 * explícito); esta función solo responde "qué día es aquí".
 */

/** Zona horaria usada cuando el entorno no declara una. El país del proyecto. */
export const DEFAULT_BUSINESS_TIME_ZONE = 'America/Bogota';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * El día del negocio, en la zona del negocio, del instante `now`.
 *
 * `now` es un parámetro normal, no una comodidad: es lo que hace que la función sea
 * determinista y que un test pueda fijar "el 2 de octubre a las 00:30 en Bogotá", que
 * en UTC es el mismo 2 de octubre pero que es exactamente el caso donde un
 * `toISOString()` da la respuesta correcta por casualidad y no por razón.
 *
 * @throws RangeError si la zona horaria no existe o el instante es inválido. Una zona
 * mal escrita tiene que ser un fallo visible al arrancar, no un "hoy" desplazado que
 * nadie detecta hasta que las cuentas no cuadran.
 */
export const businessDateIn = (timeZone: string, now: Date = new Date()): IsoDate => {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('businessDateIn: el instante recibido no es una fecha valida');
  }

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    // `Intl` lanza `RangeError` con un texto que cambia entre runtimes; el nombre de
    // la zona es lo que hace falta para arreglarlo.
    throw new RangeError(`businessDateIn: zona horaria invalida "${timeZone}"`);
  }

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  // Las partes vienen YA en la zona pedida; lo que se hace aqui es armarlas a mano en
  // vez de confiar en el formato de la configuracion regional. `en-CA` devolveria
  // `2026-10-02` y `en-US` devolveria `10/02/2026`: depender de eso para construir una
  // fecha de negocio es la forma corta de tener dos fechas distintas en dos maquinas,
  // y el fallo aparece como "un dia corrido" que nadie sabe de donde sale.
  const formatted = `${read('year')}-${read('month')}-${read('day')}`;
  const match = ISO_DATE.exec(formatted);
  if (match === null) {
    throw new RangeError(`businessDateIn: no se pudo formar una fecha desde "${formatted}"`);
  }

  return formatted as IsoDate;
};

/** El "hoy" del negocio con la zona por defecto del proyecto. */
export const businessToday = (now: Date = new Date()): IsoDate =>
  businessDateIn(DEFAULT_BUSINESS_TIME_ZONE, now);

/**
 * Suma días de CALENDARIO a una fecha de negocio.
 *
 * No usa `Date` para porque `setDate` es local: sumar 30 días a una `IsoDate` con el
 * reloj del servidor devolvería el 31 de diciembre al 1 de enero si el servidor está
 * en UTC y el negocio en Bogotá. Se parsesa, se cuenta en UTC puro y se vuelve a armar.
 *
 * @throws RangeError si la fecha no es `YYYY-MM-DD`.
 */
export const addDays = (date: IsoDate, days: number): IsoDate => {
  const match = ISO_DATE.exec(date);
  if (match === null) {
    throw new RangeError(`addDays: fecha invalida "${date}"`);
  }
  if (!Number.isInteger(days)) {
    throw new RangeError(`addDays: los dias deben ser un entero (${days})`);
  }

  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const shifted = new Date(utc + days * 86_400_000);
  const year = String(shifted.getUTCFullYear()).padStart(4, '0');
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}` as IsoDate;
};
