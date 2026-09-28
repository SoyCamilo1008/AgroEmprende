## Qué cambia

<!-- Resumen en una o dos frases: qué hace este PR desde el punto de vista del usuario. -->

## Por qué

<!-- El problema que resuelve. Si cierra un issue, escribir Closes #123. -->

## Tipo de cambio

- [ ] Corrección (bug)
- [ ] Nueva funcionalidad
- [ ] Cambio de cálculo financiero o productivo
- [ ] Esquema de base de datos (requiere migración)
- [ ] Documentación
- [ ] Refactor sin cambio de comportamiento

## Checklist

- [ ] `pnpm check` pasa (formato, lint, tipos, pruebas)
- [ ] `pnpm build` pasa
- [ ] Agregué o actualicé pruebas para el cambio
- [ ] Si el cambio afecta la base de datos, hay migración nueva y `pnpm db:reset` funciona
- [ ] No hay secretos, credenciales ni datos reales en el diff
- [ ] Documentación actualizada si cambia una regla de negocio

## Si toca cálculos de negocio

- [ ] ¿Hay un PR con un ADR si la decisión cambia una regla? (`docs/decisions/`)
- [ ] ¿Los importes se construyen con `toMoney` / `pesosToMoney` y no con números sueltos?
- [ ] ¿Un dato que puede faltar devuelve `InsufficientData<T>` en vez de un valor por defecto?
- [ ] ¿Las fechas de negocio son `IsoDate` y no `Date`?

## Capturas (solo si cambia la interfaz)

<!-- Antes y después, cuando el cambio sea visual. -->
