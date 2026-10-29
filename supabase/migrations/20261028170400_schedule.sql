-- Every 5 minutes pg_cron calls the "notifications" Edge Function, which
-- sends the wedding day and new photos notifications.
--
-- The address of the project is read from the Vault secret "project_url",
-- created once from the SQL editor of the dashboard:
--   select vault.create_secret('https://<project>.supabase.co', 'project_url');
-- The shared secret between the job and the function is generated here and
-- only lives in the Vault.
--
-- Not applied by test/run.sh: a plain Postgres has no pg_cron, pg_net or Vault.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select vault.create_secret(
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'notifications_secret',
  'Shared secret between the pg_cron job and the notifications Edge Function'
)
where not exists (select 1 from vault.secrets where name = 'notifications_secret');

-- True if [secret] is the job's secret; only the server (the Edge Function
-- with the service role) may ask.
create function public.is_notifications_secret(secret text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets where name = 'notifications_secret' and decrypted_secret = secret
  )
$$;

revoke execute on function public.is_notifications_secret(text) from public, anon, authenticated;
grant execute on function public.is_notifications_secret(text) to service_role;

select cron.schedule(
  'guest-notifications',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  $job$
);
