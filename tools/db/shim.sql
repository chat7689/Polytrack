-- The parts of a Supabase project that supabase/schema.sql relies on, for
-- running it in a plain Postgres (PGlite) in tests: the auth schema with
-- users, auth.uid()/auth.jwt() from the request settings, the API roles and
-- pgcrypto in the extensions schema.
create extension if not exists pgcrypto;
create schema if not exists extensions;
create or replace function extensions.crypt(text, text) returns text language sql immutable as $$ select public.crypt($1, $2) $$;
create or replace function extensions.gen_salt(text) returns text language sql volatile as $$ select public.gen_salt($1) $$;
create or replace function extensions.gen_salt(text, integer) returns text language sql volatile as $$ select public.gen_salt($1, $2) $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  updated_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public, auth, extensions to anon, authenticated;
grant execute on all functions in schema auth, extensions to anon, authenticated;
create or replace function extensions.gen_random_bytes(integer) returns bytea language sql volatile as $$ select public.gen_random_bytes($1) $$;
create or replace function extensions.digest(text, text) returns bytea language sql immutable as $$ select public.digest($1, $2) $$;
create or replace function extensions.digest(bytea, text) returns bytea language sql immutable as $$ select public.digest($1, $2) $$;
grant execute on all functions in schema extensions to anon, authenticated;
