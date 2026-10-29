-- Only for local tests on a plain Postgres: the parts of Supabase the
-- migrations rely on (roles, auth.uid(), storage). Supabase already has them.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- as on Supabase: the server role can do everything
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on functions to service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);
-- the user of the request, as the Supabase API passes it
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets, name text, owner uuid
);
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated, service_role;

-- For tests: runs [command] and checks it fails with SQLSTATE [state];
-- returns the error message.
create function public.error_of(command text, state text) returns text
language plpgsql
as $$
begin
  execute command;
  raise exception 'expected error % but the command succeeded: %', state, command;
exception
  when others then
    if sqlstate <> state then
      raise exception 'expected error % but got % (%): %', state, sqlstate, sqlerrm, command;
    end if;
    return sqlerrm;
end
$$;
grant execute on function public.error_of(text, text) to anon, authenticated;
