import { Card, CardHeader, CardTitle } from '@agroemprende/ui';

/**
 * Pantalla inicial de la Fase 1.
 *
 * IMPORTANTE: esta pantalla NO muestra datos del negocio. Todavía no hay
 * conexión con la base de datos (Fase 2) y, por principio del proyecto,
 * no se muestran datos inventados ni de ejemplo que puedan confundirse con
 * información real. Ver docs/decisions/ADR-0011.
 */

const MODULES = [
  {
    code: 'PONEDORAS',
    name: 'Ponedoras',
    detail: 'Lotes, producción diaria, alimento, agua, salud y venta de huevos.',
  },
  {
    code: 'CERDOS',
    name: 'Cerdos',
    detail: 'Ciclos, cerdos individuales, pesos, alimento, sacrificio y cortes.',
  },
  {
    code: 'FIN',
    name: 'Finanzas',
    detail: 'Ventas, gastos, pagos, cuentas por cobrar, inversión y reinversión.',
  },
  {
    code: 'CLI',
    name: 'Clientes',
    detail: 'Cliente global con deuda separada por unidad de negocio.',
  },
  {
    code: 'INV',
    name: 'Inventarios',
    detail: 'Alimento, huevos y carne con trazabilidad completa.',
  },
  {
    code: 'IA',
    name: 'AgroIA',
    detail: 'Consultas sobre datos reales, sin inventar y con confirmación humana.',
  },
] as const;

const PRINCIPLES = [
  'El dinero se guarda y se calcula en NUMERIC y enteros de centavos, nunca en decimales flotantes.',
  'Cada movimiento financiero pertenece a una unidad de negocio y las finanzas no se mezclan.',
  'Una venta a crédito no es dinero recibido: son dos hechos distintos y se registran por separado.',
  'Si un dato falta, el sistema lo pide. Nunca se inventa un valor para llenar un campo.',
  'La base de datos es la autoridad de permisos; la interfaz solo oculta lo que no se puede hacer.',
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-10">
        <p className="text-sm font-medium text-brand">AgroEmprende</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Plataforma para emprendimientos agropecuarios
        </h1>
        <p className="mt-3 max-w-2xl text-foreground/70">
          Administración de producción, animales, finanzas, inventarios y clientes, con trazabilidad
          completa y análisis asistido por inteligencia artificial sobre datos reales del negocio.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold">Módulos del sistema</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((module) => (
            <Card key={module.code}>
              <CardHeader>
                <CardTitle>{module.name}</CardTitle>
                <span className="rounded bg-brand/10 px-2 py-0.5 font-mono text-xs text-brand">
                  {module.code}
                </span>
              </CardHeader>
              <p className="text-sm text-foreground/70">{module.detail}</p>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Reglas que no se rompen</h2>
        <ul className="space-y-2">
          {PRINCIPLES.map((principle) => (
            <li key={principle} className="flex gap-3 text-sm text-foreground/80">
              <span aria-hidden className="text-positive">
                ?
              </span>
              <span>{principle}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-12 border-t border-border pt-4 text-sm text-foreground/60">
        Fase 1 de 10: arquitectura y cimientos del proyecto. La conexión con la base de datos
        PostgreSQL en Supabase se activa en la Fase 2, junto con autenticación, roles y permisos.
      </footer>
    </main>
  );
}
