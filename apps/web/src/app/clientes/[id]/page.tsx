import {
  createCustomerFinanceRepository,
  createCustomerRepository,
  isDomainError,
} from '@agroemprende/supabase';
import type {
  CustomerFinanceRepository,
  CustomerRepository,
  CustomerSummary,
} from '@agroemprende/supabase';
import { uuidSchema } from '@agroemprende/validation';
import {
  Badge,
  Card,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  MoneyDisplay,
  Stat,
  StatGrid,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
} from '@agroemprende/ui';
import type {
  CustomerFinancialSummary,
  CustomerFinancePage,
  CustomerPayment,
  CustomerReceivable,
  CustomerSale,
  IsoDate,
} from '@agroemprende/types';
import { notFound } from 'next/navigation';
import { businessToday } from '@/lib/business-date';
import { paymentMethodLabel, receivableTone, settlementMethodLabel } from '@/lib/labels';
import { createClient } from '@/lib/supabase/server';

/**
 * Ficha del cliente: quién es, qué debe y qué ha hecho.
 *
 * Cómo se traen los datos
 * ----------------------
 * Las cinco lecturas salen en un `Promise.all`, no encadenadas. La pantalla tarda lo
 * que tarda la más lenta y no la suma, y el servidor abre las consultas en paralelo en
 * vez de cinco viajes de ida y vuelta.
 *
 * Lo que NO se hace, que es lo importante: no hay bucles. No se recorre `summary.rows`
 * para pedir una cartera por unidad, ni `items` para pedir un pago por venta. El
 * resumen viene consolidado desde PostgreSQL y cada lista viene paginada con su total.
 * Un `rows.map(...)` que consultara por fila sería N+1 contra una base real: N viajes
 * por cliente, y con veinte clientes en pantalla veinte veces el trabajo. Los números
 * de este panel salen de UNA fila de PostgreSQL, no de una suma en JavaScript.
 *
 * Dónde se decide qué está vencido
 * -------------------------------
 * En la base. `today` viaja hasta la vista y hasta la función del resumen para que
 * PostgreSQL cuente lo vencido contra esa misma fecha (ADR-0012). Aquí no se compara
 * ninguna fecha: si esta pantalla decidiera qué está vencido, el mismo cliente
 * aparecería al día en un reporte y vencido en la ficha.
 *
 * Límites de tamaño
 * -----------------
 * Cada panel pide `PANEL_LIMIT` filas y el total que devuelve la base. Cuando se
 * muestran menos de las que hay, se dice "las primeras N de M": un saldo que se ve
 * completo y no lo está es peor que uno que se sabe incompleto.
 */
const PANEL_LIMIT = 20;

interface PageProps {
  readonly params: Promise<{ readonly id: string }>;
}

/**
 * Los tres desenlaces posibles de cargar la ficha.
 *
 * Se nombran uno por uno porque se RESPONDEN distinto: `not_found` es un 404 de Next,
 * `forbidden` es una pantalla que explica qué revisar, y `failed` es un error que sube
 * para que alguien lo arregle. Si los tres se colapsaran en "no se pudo leer", un
 * permiso mal asignado y un cliente borrado se verían igual, y la diferencia entre un
 * problema de datos y uno de permisos es justo la que hay que reportar distinto.
 */
type LoadedCliente =
  | ({ readonly status: 'ok' } & LoadedData)
  | { readonly status: 'not_found' }
  | { readonly status: 'forbidden' };

interface LoadedData {
  readonly customerSummary: CustomerSummary;
  readonly financeSummary: CustomerFinancialSummary;
  readonly receivables: CustomerFinancePage<CustomerReceivable>;
  readonly sales: CustomerFinancePage<CustomerSale>;
  readonly payments: CustomerFinancePage<CustomerPayment>;
}

export default async function ClientePage({ params }: PageProps) {
  const { id } = await params;

  // Un id que no es un UUID no se manda a la base: se responde 404. Un filtro con
  // basura produce un error de sintaxis de PostgreSQL en vez de un "no existe", y esa
  // diferencia queda registrada en los logs.
  if (!uuidSchema.safeParse(id).success) notFound();

  const supabase = await createClient();
  const customers = createCustomerRepository(supabase);
  const finance = createCustomerFinanceRepository(supabase);

  // Una sola fecha para las cinco lecturas. Si cada una calculara la suya en un
  // instante distinto, una consulta que cruza la medianoche vería al cliente vencido y
  // la siguiente lo vería al día, en la misma pantalla.
  const today: IsoDate = businessToday();

  const loaded = await loadCliente(customers, finance, id, today);

  if (loaded.status === 'not_found') notFound();

  if (loaded.status === 'forbidden') {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <EmptyState
          title="Tu sesión no alcanza para este cliente"
          detail="Las lecturas de cartera y ventas responden a los permisos de finances y sales de tu organización en PostgreSQL. Si deberías verlos, revisa tu asignación de roles."
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <CustomerHeader
        customer={loaded.customerSummary.customer}
        contactCount={loaded.customerSummary.contactCount}
      />
      <PortfolioSummary summary={loaded.financeSummary} today={today} />
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <ReceivablesPanel page={loaded.receivables} />
        <SalesPanel page={loaded.sales} />
      </div>
      <div className="mt-6">
        <PaymentsPanel page={loaded.payments} />
      </div>
    </main>
  );
}

/**
 * Las cinco lecturas de la ficha, en paralelo, con el desenlace ya clasificado.
 *
 * `notFound()` lanza, así que la comprobación del cliente que no existe se hace
 * AQUÍ y no dentro de la pantalla: si el error de "no encontrado" pasara por el
 * manejo de errores de base de datos, se confundiría con una caída.
 */
async function loadCliente(
  customers: CustomerRepository,
  finance: CustomerFinanceRepository,
  id: string,
  today: IsoDate,
): Promise<LoadedCliente> {
  try {
    const [customerSummary, financeSummary, receivables, sales, payments] = await Promise.all([
      customers.getSummary(id),
      finance.getSummary(id, today),
      finance.listReceivables(id, { today, limit: PANEL_LIMIT }),
      finance.listSales(id, { today, limit: PANEL_LIMIT }),
      finance.listPayments(id, { today, limit: PANEL_LIMIT }),
    ]);

    if (customerSummary === null) return { status: 'not_found' };

    return { status: 'ok', customerSummary, financeSummary, receivables, sales, payments };
  } catch (error) {
    // Sin sesión, o con una sesión a la que RLS no le deja leer, la respuesta es un 403
    // de PostgREST. NO se convierte en un 404 a propósito: decir "no existe" cuando el
    // cliente sí existe pero no se puede leer esconde un problema de permisos detrás de
    // uno de datos, y son los que se arreglan de forma distinta.
    if (isDomainError(error) && error.kind === 'authorization') {
      return { status: 'forbidden' };
    }
    throw error;
  }
}
function CustomerHeader({
  customer,
  contactCount,
}: {
  readonly customer: CustomerSummary['customer'];
  readonly contactCount: number;
}) {
  return (
    <header className="mb-8">
      <p className="text-sm font-medium text-brand">Clientes</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">{customer.name}</h1>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground/60">
        {/* Lo que no se registró se dice que no está, no se inventa un valor para
            llenar el hueco (ADR-0011). */}
        <span>{customer.taxId ?? 'Sin identificación'}</span>
        {customer.code === null ? null : <span className="font-mono">{customer.code}</span>}
        <span>{contactCount === 0 ? 'Sin contactos' : `${contactCount} contactos`}</span>
        {customer.creditDays === null ? null : <span>{customer.creditDays} días de crédito</span>}
      </p>
      {customer.isActive ? null : (
        <p className="mt-3">
          <Badge label="Cliente inactivo" tone="muted" />
        </p>
      )}
    </header>
  );
}

/**
 * El mosaico de totales.
 *
 * Si el resumen no vino, NO se muestran ceros: un saldo de $0 que nadie calculó es
 * peor que un guion, porque el usuario lo toma como un dato y decide con él. `pending`
 * existe exactamente para ese caso.
 */
function PortfolioSummary({
  summary,
  today,
}: {
  readonly summary: CustomerFinancialSummary;
  readonly today: IsoDate;
}) {
  const consolidated = summary.consolidated;
  const pending = consolidated === null;
  const unitCount = summary.rows.filter((row) => !row.isConsolidated).length;

  return (
    <section aria-labelledby="titulo-resumen">
      <h2 id="titulo-resumen" className="sr-only">
        Resumen financiero del cliente
      </h2>
      <Card>
        <CardHeader>
          <CardTitle>Resumen</CardTitle>
          <span className="text-xs text-foreground/60">
            {pending ? 'Sin datos' : `Hoy, ${today}`}
          </span>
        </CardHeader>
        <StatGrid>
          <Stat label="Debe" tone={pending ? 'neutral' : 'negative'} pending={pending}>
            {consolidated === null ? null : <MoneyDisplay value={consolidated.outstanding} />}
          </Stat>
          <Stat label="Vencido" tone={pending ? 'neutral' : 'negative'} pending={pending}>
            {consolidated === null ? null : (
              <MoneyDisplay value={consolidated.overdueOutstanding} />
            )}
          </Stat>
          <Stat label="Pagado" tone="positive" pending={pending}>
            {consolidated === null ? null : <MoneyDisplay value={consolidated.totalPaid} />}
          </Stat>
          <Stat label="Vendido" pending={pending}>
            {consolidated === null ? null : <MoneyDisplay value={consolidated.totalSold} />}
          </Stat>
          <Stat label="Ventas" pending={pending}>
            {consolidated === null ? null : consolidated.salesCount}
          </Stat>
          <Stat label="Abiertas" pending={pending}>
            {consolidated === null ? null : consolidated.openCount}
          </Stat>
          <Stat
            label="Vencidas"
            tone={pending ? 'neutral' : 'negative'}
            pending={pending}
            hint={
              consolidated?.oldestOpenDueDate == null
                ? undefined
                : `La más antigua vence el ${consolidated.oldestOpenDueDate}`
            }
          >
            {consolidated === null ? null : consolidated.overdueCount}
          </Stat>
          <Stat label="Unidades" pending={pending}>
            {pending ? null : unitCount}
          </Stat>
        </StatGrid>
      </Card>
    </section>
  );
}

interface PanelHeadingProps {
  readonly id: string;
  readonly title: string;
  /** Total que dice la base, que puede ser mayor que las filas mostradas. */
  readonly total: number;
  readonly limit: number;
}

/** Encabezado de panel, con el conteo real y no el de las filas a la vista. */
const PanelHeading = ({ id, title, total, limit }: PanelHeadingProps) => (
  <CardHeader>
    <CardTitle id={id}>{title}</CardTitle>
    <span className="text-xs text-foreground/60">
      {total > limit ? `Las primeras ${limit} de ${total}` : `${total} en total`}
    </span>
  </CardHeader>
);

function ReceivablesPanel({ page }: { readonly page: CustomerFinancePage<CustomerReceivable> }) {
  return (
    <section aria-labelledby="titulo-cartera">
      <Card>
        <PanelHeading id="titulo-cartera" title="Cartera" total={page.total} limit={PANEL_LIMIT} />
        {page.items.length === 0 ? (
          <EmptyState
            title="No debe nada"
            detail="No hay obligaciones con saldo abierto. Las ventas ya saldadas siguen en el historial."
          />
        ) : (
          <DataTable caption="Obligaciones abiertas del cliente, con su saldo y su vencimiento">
            <TableHead>
              <TableRow>
                <TableHeadCell>Factura</TableHeadCell>
                <TableHeadCell>Unidad</TableHeadCell>
                <TableHeadCell>Vence</TableHeadCell>
                <TableHeadCell align="right">Saldo</TableHeadCell>
                <TableHeadCell>Estado</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {page.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell header>{item.invoiceNumber}</TableCell>
                  <TableCell>{item.businessUnit?.name ?? 'Sin unidad'}</TableCell>
                  <TableCell>{item.dueDate}</TableCell>
                  <TableCell align="right">
                    <MoneyDisplay value={item.balance} />
                  </TableCell>
                  <TableCell>
                    {/* El tono es solo color. La etiqueta la escribió PostgreSQL, y los
                        días de atraso solo se acompañan cuando el estado los explica. */}
                    <Badge label={item.statusLabel} tone={receivableTone(item.status)}>
                      {item.status === 'overdue' ? (
                        <span className="opacity-70">{item.daysOverdue} d</span>
                      ) : null}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </section>
  );
}

function SalesPanel({ page }: { readonly page: CustomerFinancePage<CustomerSale> }) {
  return (
    <section aria-labelledby="titulo-historial">
      <Card>
        <PanelHeading
          id="titulo-historial"
          title="Historial de ventas"
          total={page.total}
          limit={PANEL_LIMIT}
        />
        {page.items.length === 0 ? (
          <EmptyState
            title="Sin ventas registradas"
            detail="Este cliente todavía no tiene ninguna venta. Las ventas a crédito son las que generan cartera."
          />
        ) : (
          <DataTable caption="Ventas del cliente, de la más reciente a la más antigua">
            <TableHead>
              <TableRow>
                <TableHeadCell>Factura</TableHeadCell>
                <TableHeadCell>Fecha</TableHeadCell>
                <TableHeadCell>Condición</TableHeadCell>
                <TableHeadCell align="right">Total</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {page.items.map((item) => (
                <TableRow
                  key={item.id}
                  className={item.isVoided ? 'text-foreground/40' : undefined}
                >
                  <TableCell header>
                    {item.invoiceNumber}
                    {/* La venta anulada NO desaparece: la contabilidad es append-only
                        (ADR-0003). Se marca para que se vea que existió y se revirtió. */}
                    {item.isVoided ? <Badge label="Anulada" tone="muted" className="ml-2" /> : null}
                  </TableCell>
                  <TableCell>{item.saleDate}</TableCell>
                  <TableCell>{paymentMethodLabel(item.paymentMethod)}</TableCell>
                  <TableCell align="right">
                    <MoneyDisplay value={item.total} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </section>
  );
}

function PaymentsPanel({ page }: { readonly page: CustomerFinancePage<CustomerPayment> }) {
  return (
    <section aria-labelledby="titulo-abonos">
      <Card>
        <PanelHeading id="titulo-abonos" title="Abonos" total={page.total} limit={PANEL_LIMIT} />
        {page.items.length === 0 ? (
          <EmptyState
            title="Sin abonos"
            detail="No se ha registrado ningún pago para este cliente."
          />
        ) : (
          <DataTable caption="Abonos aplicados a la cartera del cliente, del más reciente al más antiguo">
            <TableHead>
              <TableRow>
                <TableHeadCell>Fecha</TableHeadCell>
                <TableHeadCell>Factura</TableHeadCell>
                <TableHeadCell>Medio</TableHeadCell>
                <TableHeadCell align="right">Abono</TableHeadCell>
                <TableHeadCell align="right">Aplicado</TableHeadCell>
                <TableHeadCell align="right">Saldo a favor</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {page.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell header>{item.paymentDate}</TableCell>
                  <TableCell>{item.invoiceNumber}</TableCell>
                  <TableCell>{settlementMethodLabel(item.method)}</TableCell>
                  <TableCell align="right">
                    <MoneyDisplay value={item.amount} />
                  </TableCell>
                  <TableCell align="right">
                    <MoneyDisplay value={item.appliedAmount} />
                  </TableCell>
                  <TableCell align="right">
                    {/* El saldo a favor es del cliente, no una deuda: se pinta en verde
                        y no en negativo, porque en negativo parecería que el negocio le
                        debe, que es justo lo contrario. */}
                    {item.unappliedAmount === 0 ? (
                      <span className="text-foreground/40">—</span>
                    ) : (
                      <MoneyDisplay value={item.unappliedAmount} tone="positive" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </section>
  );
}
