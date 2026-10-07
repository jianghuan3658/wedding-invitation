-- Read-only operational health query. No RSVP, user, count, or secret data is read.
-- Run separately as the project's postgres role, after the wedding backend schema.
begin;

create or replace function public.wedding_service_health()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'ok', true,
    'checkedAt', pg_catalog.to_char(
      pg_catalog.statement_timestamp() at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
$function$;

revoke all on function public.wedding_service_health() from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function public.wedding_service_health() to anon, authenticated;
notify pgrst, 'reload schema';

commit;
