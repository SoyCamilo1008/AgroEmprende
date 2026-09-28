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
onboarding no debe tener fricción. Ver `supabase/config.toml` (configuración de Auth).

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

1. El usuario se registra con correo.
2. La Edge Function de bootstrap crea la organización, asigna el rol `owner` y, si el
   usuario lo pide, la primera unidad de negocio.
3. Se cargan los catálogos base (unidades de medida, tipos de producto) desde el seed, no
   desde constantes duplicadas en el cliente.
4. A partir de ahí, la unidad de negocio seleccionada es el contexto de todas las
   pantallas de registro.
