# Autenticación y organizaciones

## Modelo

AgroEmprende es **multitenant por organización**. Un usuario pertenece a una o más
organizaciones; dentro de una organización hay una o más unidades de negocio. Los datos
de una organización nunca son visibles para otra, y esa garantía no depende de la
aplicación: depende de RLS (ver [RLS](rls.md)).

```
usuario (auth.users)
  └── membresía  →  organización
                       └── unidades de negocio
                              └── lotes, ciclos, ventas, pagos, gastos, inventario
```

El primer usuario que se registra crea su propia organización. No hay un proceso de
aprobación ni un administrador global: es una herramienta de pago por uso y el
onboarding no debe tener fricción. Ver `supabase/config.toml` (configuración de Auth) y
la sección [Onboarding](#onboarding).

## Roles

Los roles son org-scoped: un usuario puede ser `owner` en una organización y `viewer` en
otra. Los códigos están definidos en `@agroemprende/types` (`ROLES`) y son la fuente de
verdad que se carga en `core.roles` y `core.role_permissions` en el seed.

| Rol        | Rango | Qué puede hacer                                                        |
| ---------- | ----- | ---------------------------------------------------------------------- |
| `owner`    | 100   | Todo, incluido administrar la organización y los miembros              |
| `admin`    | 80    | Todo excepto transferir la propiedad y eliminar la organización        |
| `manager`  | 60    | Operar su unidad de negocio: registrar producción, ventas, pagos       |
| `operator` | 40    | Registrar hechos operativos de su unidad, sin ver utilidad consolidada |
| `viewer`   | 20    | Solo lectura                                                           |

Los permisos son granulares (`finance.sales.create`, `poultry.production.create`,
`finance.profit.read`…) y están en `PERMISSIONS`. Un `operator` **no** ve
`finance.profit.read`: la utilidad consolidada es del dueño, no del que registra.

## Propiedad de la organización

Toda organización tiene **exactamente un `owner` activo**, y esa regla la garantiza la base
de datos, no la aplicación. Son dos mecanismos distintos porque son dos problemas
distintos:

- **Como máximo uno** — el índice único parcial
  `organization_members_one_active_owner (organization_id) where role_code = 'owner' and
is_active`. Es lo único que un índice puede expresar.
- **Al menos uno** — un trigger de restricción **diferido**
  (`organizations_one_active_owner_invariant` y
  `organization_members_one_active_owner_invariant`) que al cerrar la transacción cuenta
  los propietarios activos y falla con `23514` si no hay exactamente uno.

El diferido no es un detalle: es lo que hace posible la transferencia, porque en una
transacción "el anterior deja de ser owner" y "el nuevo lo es" se escriben juntos. Con
una comprobación inmediata, ninguna de las dos mitades por separado sería válida.

Cambiar de propietario se hace **siempre** con
`public.transfer_organization_ownership(organization_id, new_owner_id)`, que en una sola
transacción:

1. exige sesión activa y bloquea la fila de la organización (`FOR UPDATE`), lo que
   serializa dos transferencias simultáneas;
2. comprueba que quien llama **es** el propietario actual — un `admin` que pudiera hacerlo
   podría nombrarse a sí mismo, y la regla de "un owner" no lo detectaría porque se
   cumpliría;
3. exige que el destinatario exista, pertenezca a esa organización y esté activo, con un
   mensaje distinto para cada motivo;
4. degrada al propietario anterior a `admin` —que en esta fase tiene los mismos permisos,
   perder la propiedad no es perder el acceso a la granja— y promueve al nuevo;
5. escribe una entrada de auditoría con los dos ids.

El orden de los pasos 4 importa y no es intercambiable: el índice único no es diferible, así
que promover antes de degradar daría violación de unicidad a mitad de la transferencia.

Quitarle el rol a un propietario por otra vía sigue siendo imposible: la política
`organization_members_update` permite escribir la fila, pero la comprobación diferida
rechaza la transacción al final. `supabase/tests/03_ownership.test.sql` cubre los dos
lados.

## Dónde se aplica la autorización

En tres capas, y la última es la que manda:

1. **UI**: oculta botones y deshabilita acciones según permisos. Es conveniencia, no
   seguridad: un usuario puede llamar la API a mano.
2. **Route handlers / Server Actions**: validan sesión y permiso antes de llamar a
   Supabase. Evita perder un round-trip y da errores claros.
3. **Base de datos**: RLS en cada tabla y `private.assert_permission()` dentro de las
   funciones SQL. Es la única capa que no se puede saltar desde el cliente. Ver [RLS](rls.md).

Si una acción no está cubierta por las tres, está sin proteger. La UI nunca es la
protección.

## Sesión

- Web: Supabase SSR con cookies `httpOnly`. El cliente de servidor vive en
  `apps/web/src/lib/supabase/server.ts` y el de navegador en el paquete
  `@agroemprende/supabase`. Son clientes distintos a propósito: el de servidor es el
  único que puede escribir cookies.
- Móvil: sesión en `expo-secure-store`, nunca en `AsyncStorage`. El cliente móvil
  (`createMobileClient`) inicializa el almacenamiento seguro.
- El paquete `@agroemprende/supabase` valida las variables de entorno con Zod
  (`parseSupabasePublicEnv`) al cargar el módulo: si falta la URL o la anon key, la app
  falla en el arranque con un mensaje claro, no en la primera consulta.

## Onboarding

El alta es una **función de base de datos**, no una Edge Function ni tres llamadas del
cliente:

```sql
select public.create_organization_with_business_unit(
  'Finca El Porvenir', 'PONEDORAS', 'Galpones ponedoras', 'poultry_layers'
);
```

`public.create_organization_with_business_unit` es `SECURITY DEFINER` con
`search_path = ''`, y en una sola transacción crea la organización, la membresía de
`owner`, la primera unidad de negocio, las cuentas base copiadas de la plantilla y la
entrada de auditoría.

**Por qué una función y no varias llamadas.** Con tres `insert()` sueltos, un fallo a la
mitad deja una organización sin dueño: un usuario que no puede hacer nada y que tampoco
puede arreglarlo, porque no existe el camino que lo arregla. Una función atómica no tiene
ese estado intermedio.

**Por qué no una Edge Function.** Tendría el mismo problema: la Edge Function llamaría a
varios RPC y, si el segundo fallara, quedaría el mismo organizational huérfano. El
límite transaccional tiene que estar donde está el dato.

Es **idempotente**, que es lo que importa en móvil con mala señal:

- Con `p_idempotency_key`, la misma llave del mismo usuario devuelve lo ya creado.
- Sin llave, si el usuario ya tiene una organización, esa es la suya. Volver a "crear" no
  duplica ni adivina: devuelve `created: false` con el mismo id.

En ambos casos la respuesta es el mismo JSON (`organization_id`, `business_unit_id`,
`created`), así que el cliente no distingue "creado" de "ya existía" y no necesita
lógica de reintento.

## Invitaciones

Cómo entra un usuario nuevo a una organización existente. También es una función, por la
misma razón de atomicidad:

```sql
-- Quien administra miembros (owner o admin):
select public.create_organization_invitation('operario@ejemplo.com', 'operator');
-- Devuelve el token. La interfaz muestra el enlace; el servidor lo enviaría por correo.

-- Quien recibe la invitación, ya con su cuenta iniciada:
select public.accept_organization_invitation('a3f9…');
```

Cuatro propiedades, y cada una está probada en `supabase/tests/02_invitations.test.sql`:

1. **El token es una credencial, no un identificador.** Son 32 bytes de
   `gen_random_bytes` en hexadecimal, se guarda con `unique`, y no se acepta un token
   que venga en el cuerpo de la petición: lo genera la función.
2. **Se ata al correo.** `accept_organization_invitation` compara el correo de
   `auth.users` con el de la invitación. Un enlace reenviado por error no le da la
   organización a quien lo abra. El error es `42501`.
3. **Es de un solo uso.** Aceptarlo dos veces falla con un mensaje claro en vez de
   devolver éxito: quien llega con un token ya usado no es la persona invitada, y
   responderle "ok" lo haría creer que sí lo es.
4. **No hay invitación a `owner`.** Chocaría con la garantía de un solo dueño activo y
   ademásaría la propiedad por el enlace equivocado. La transferencia de propiedad es un
   proceso explícito.

La Fase 2 **no envía correo**: no hay proveedor de email configurado. La función devuelve el
token para que la interfaz muestre el enlace. Cuando haya proveedor, el envío se
agrega sin cambiar el esquema.

La lectura de `core.organization_invitations` requiere `org.members.manage`: un miembro
que no administra miembros puede ver la lista de clientes de su organización, pero no los
tokens de invitación.
