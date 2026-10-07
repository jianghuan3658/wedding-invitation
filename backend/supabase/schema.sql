-- Wedding RSVP backend for a dedicated Supabase project, PostgreSQL 15+ / UTF-8.
-- Run as the project's postgres role. This file never embeds an administrator UID.
-- Auth must separately have Anonymous Sign-Ins enabled. See README.md.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists private.settings (
  singleton boolean primary key default true check (singleton),
  admin_uid uuid not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.wedding_rsvps (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique,
  owner_uid uuid not null unique,
  name text not null check (char_length(name) between 1 and 40 and name !~ '[[:cntrl:]]'),
  people integer not null check (people between 1 and 20),
  client_version bigint not null check (client_version between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  submitted_at timestamptz not null default now()
);

-- No FK to auth.users: deleting an anonymous Auth account must not erase its RSVP.
create table if not exists private.wedding_rsvp_operations (
  owner_uid uuid not null,
  operation_id uuid not null,
  fingerprint jsonb not null,
  accepted_at timestamptz not null default now(),
  primary key (owner_uid, operation_id)
);

create table if not exists private.wedding_rsvp_limits (
  owner_uid uuid primary key,
  minute_bucket bigint not null,
  request_count integer not null check (request_count between 1 and 10)
);

alter table private.settings enable row level security;
alter table private.wedding_rsvp_operations enable row level security;
alter table private.wedding_rsvp_limits enable row level security;
alter table public.wedding_rsvps enable row level security;

revoke all on table private.settings, private.wedding_rsvp_operations,
  private.wedding_rsvp_limits, public.wedding_rsvps from public, anon, authenticated;

create or replace function private.is_wedding_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from private.settings s
    where s.singleton and s.admin_uid = (select auth.uid())
      and (select auth.jwt() ->> 'is_anonymous') = 'false'
      and (select auth.jwt() ->> 'role') = 'authenticated'
      and pg_catalog.btrim(coalesce((select auth.jwt() ->> 'email'), '')) <> ''
  );
$function$;
revoke all on function private.is_wedding_admin() from public, anon, authenticated;
grant execute on function private.is_wedding_admin() to authenticated;

drop policy if exists wedding_admin_read on public.wedding_rsvps;
create policy wedding_admin_read on public.wedding_rsvps
  for select to authenticated using ((select private.is_wedding_admin()));
-- This explicit grant is needed by current Supabase Data API and Realtime.
-- Anonymous Auth users also use authenticated, but the policy returns false for them.
grant select on table public.wedding_rsvps to authenticated;
grant usage on schema public to authenticated;

create or replace function private.rsvp_receipt(p_row public.wedding_rsvps)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_row.id::text,
    'name', p_row.name,
    'people', p_row.people,
    'createdAt', pg_catalog.to_char(p_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'submittedAt', pg_catalog.to_char(p_row.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$function$;
revoke all on function private.rsvp_receipt(public.wedding_rsvps) from public, anon, authenticated;

create or replace function public.submit_wedding_rsvp(
  p_name text,
  p_people integer,
  p_submission_id uuid,
  p_operation_id uuid,
  p_client_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_fingerprint jsonb;
  v_previous_fingerprint jsonb;
  v_row public.wedding_rsvps%rowtype;
  v_has_row boolean;
  v_bucket bigint;
  v_count integer;
  v_now timestamptz;
begin
  if v_uid is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    raise exception using errcode = 'P0001', message = 'UNAUTHENTICATED';
  end if;
  -- ECMAScript trim whitespace, followed by NFC, matching the browser payload.
  v_name := normalize(pg_catalog.btrim(p_name,
    E' \t\n\r\f' || pg_catalog.chr(11) || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), NFC);
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 40
    or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = 'P0001', message = 'INVALID_NAME';
  end if;
  if p_people is null or p_people not between 1 and 20 then
    raise exception using errcode = 'P0001', message = 'INVALID_PEOPLE';
  end if;
  if p_submission_id is null or p_operation_id is null
    or p_submission_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_operation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_client_version is null or p_client_version not between 1 and 9007199254740991 then
    raise exception using errcode = 'P0001', message = 'INVALID_ID';
  end if;
  v_fingerprint := pg_catalog.jsonb_build_array(p_submission_id::text, v_name, p_people, p_client_version);

  -- Serialize all submissions for the trusted Auth UID, including the first insert.
  -- Hash collisions only serialize unrelated users; they cannot grant access.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text, 0));
  select * into v_row from public.wedding_rsvps r where r.owner_uid = v_uid;
  v_has_row := found;
  select o.fingerprint into v_previous_fingerprint
    from private.wedding_rsvp_operations o
    where o.owner_uid = v_uid and o.operation_id = p_operation_id;
  if found then
    if v_previous_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'P0001', message = 'ID_CONFLICT';
    end if;
    if not v_has_row then
      raise exception using errcode = 'P0001', message = 'INCONSISTENT_DATA';
    end if;
    -- A successful operation may be retried indefinitely, without another write
    -- or rate-limit charge. Return the latest row so the UI cannot show old data.
    return private.rsvp_receipt(v_row);
  end if;
  if v_has_row then
    if v_row.submission_id <> p_submission_id then
      raise exception using errcode = 'P0001', message = 'ID_CONFLICT';
    end if;
    if p_client_version <= v_row.client_version then
      raise exception using errcode = 'P0001', message = 'STALE_OPERATION';
    end if;
  end if;
  -- Do not expose whether a different owner already has this submission ID.
  if exists (select 1 from public.wedding_rsvps r
    where r.submission_id = p_submission_id and r.owner_uid <> v_uid) then
    raise exception using errcode = 'P0001', message = 'ID_CONFLICT';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_bucket := pg_catalog.floor(extract(epoch from v_now) / 60)::bigint;
  select case when l.minute_bucket = v_bucket then l.request_count else 0 end
    into v_count from private.wedding_rsvp_limits l where l.owner_uid = v_uid;
  v_count := coalesce(v_count, 0);
  if v_count >= 10 then
    raise exception using errcode = 'P0001', message = 'RATE_LIMITED';
  end if;
  insert into private.wedding_rsvp_limits(owner_uid, minute_bucket, request_count)
    values(v_uid, v_bucket, v_count + 1)
    on conflict(owner_uid) do update set minute_bucket = excluded.minute_bucket,
      request_count = excluded.request_count;

  if v_has_row then
    update public.wedding_rsvps set name = v_name, people = p_people,
      client_version = p_client_version, submitted_at = v_now
      where owner_uid = v_uid returning * into v_row;
  else
    begin
      insert into public.wedding_rsvps(submission_id, owner_uid, name, people,
        client_version, created_at, submitted_at)
        values(p_submission_id, v_uid, v_name, p_people, p_client_version, v_now, v_now)
        returning * into v_row;
    exception when unique_violation then
      -- Handles a simultaneous different-owner claim of the same submission ID.
      raise exception using errcode = 'P0001', message = 'ID_CONFLICT';
    end;
  end if;
  insert into private.wedding_rsvp_operations(owner_uid, operation_id, fingerprint, accepted_at)
    values(v_uid, p_operation_id, v_fingerprint, v_now);
  return private.rsvp_receipt(v_row);
end;
$function$;
revoke all on function public.submit_wedding_rsvp(text, integer, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.submit_wedding_rsvp(text, integer, uuid, uuid, bigint) to authenticated;

create or replace function public.authorize_wedding_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.is_wedding_admin() then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return pg_catalog.jsonb_build_object('authorized', true);
end;
$function$;
revoke all on function public.authorize_wedding_admin() from public, anon, authenticated;
grant execute on function public.authorize_wedding_admin() to authenticated;

create or replace function public.list_wedding_rsvps(p_cursor text default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_cursor uuid;
  v_rows jsonb;
  v_next_cursor text;
begin
  if not private.is_wedding_admin() then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_CURSOR';
  end if;
  if p_cursor is not null and p_cursor <> '' then
    if p_cursor !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001', message = 'INVALID_CURSOR';
    end if;
    v_cursor := p_cursor::uuid;
  end if;
  with candidates as (
    select r, r.id, pg_catalog.row_number() over (order by r.id) as position
      from public.wedding_rsvps r
      where v_cursor is null or r.id > v_cursor
      order by r.id limit (p_limit + 1)
  )
  select coalesce(pg_catalog.jsonb_agg(private.rsvp_receipt(c.r) order by c.id)
      filter (where c.position <= p_limit), '[]'::jsonb),
    case when pg_catalog.count(*) > p_limit
      then (pg_catalog.array_agg(c.id order by c.id))[p_limit]::text else null end
    into v_rows, v_next_cursor from candidates c;
  return pg_catalog.jsonb_build_object('rows', v_rows, 'nextCursor', v_next_cursor,
    'fetchedAt', pg_catalog.to_char(pg_catalog.statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$function$;
revoke all on function public.list_wedding_rsvps(text, integer) from public, anon, authenticated;
grant execute on function public.list_wedding_rsvps(text, integer) to authenticated;

-- INSERT/UPDATE events are visible only through the administrator SELECT policy.
-- Re-running this file must not duplicate the publication membership.
do $publication$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;
  if not exists (select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wedding_rsvps') then
    execute 'alter publication supabase_realtime add table public.wedding_rsvps';
  end if;
end;
$publication$;

comment on table public.wedding_rsvps is 'Wedding guest responses; clients write only through submit_wedding_rsvp; only the configured permanent administrator can read.';
comment on table private.settings is 'Private administrator allowlist. Keep this schema out of the exposed API schemas.';
notify pgrst, 'reload schema';
commit;
