-- description: Crea los esquemas por dominio y las utilidades privadas compartidas.
-- depends_on:

-- ─────────────────────────────────────────────────────────────────────────────
-- Esquemas por dominio (docs/database/migrations.md, regla 5).
--
-- Se crean solo los que esta fase usa. `finance`, `poultry`, `swine`,
-- `inventory` y `ai` llegan con su propia migración: un esquema vacío no
-- aporta nada y esconde el orden real de dependencias.
--
-- `private` nunca se expone: contiene las funciones que las políticas de RLS
-- invocan, y esas funciones no son parte de la API.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists core;
create schema if not exists catalog;
create schema if not exists private;

comment on schema core is
  'Datos maestros de la organización: organizaciones, membresías, roles, permisos, unidades de negocio, clientes, proveedores, cuentas y auditoría.';
comment on schema catalog is
  'Catálogos de referencia del sistema: unidades de medida y sus conversiones.';
comment on schema private is
  'Funciones auxiliares de RLS y onboarding. NO se expone en la API de PostgREST.';

-- Sin esto, cualquiera con permiso USAGE sobre el esquema podría resolver las
-- funciones que las políticas usan para decidir el acceso.
revoke all on schema private from public;

-- pgcrypto vive en `extensions` en Supabase. Se necesita para generar los
-- tokens de invitación con entropía criptográfica, no con random().
create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────────
-- Utilidades privadas
-- ─────────────────────────────────────────────────────────────────────────────

-- `updated_at` es un campo de auditoría: lo escribe la base, no el cliente.
-- Se usa en todas las tablas con `created_at`/`updated_at`.
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Conversión segura a uuid. Un `::uuid` directo sobre un texto inválido lanza
-- una excepción y aborta la consulta; aquí un contexto mal formado se degrada
-- a NULL, que en las políticas significa "sin acceso" en vez de "error 500".
create or replace function private.try_uuid(value text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
begin
  return value::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;
