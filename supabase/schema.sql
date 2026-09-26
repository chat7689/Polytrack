-- aiPolytrack on Supabase: tables, security rules and server functions.
--
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- It is safe to run again (after an update): it only creates what is
-- missing and replaces functions and policies with the current versions.
--
-- Everything that must not be trusted to a player's own browser runs here,
-- inside the database: invite codes, best times only ever getting faster,
-- credit balances, race start/settle and payouts.

-- ------------------------------------------------------------------ tables

-- who may use the admin page (add yourself: see the end of this file)
create table if not exists public.admins (
  user_id uuid primary key
);

-- small key/value settings: 'invite' {code}, 'admin_passcode' {salt, passHash}
create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

-- one row per player. legacy = moved over from Firebase and not yet
-- claimed by a new login (it keeps its times on the boards meanwhile)
create table if not exists public.profiles (
  id uuid primary key,
  display_name text not null,
  banned boolean not null default false,
  legacy boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_name_ci on public.profiles (lower(display_name));

create table if not exists public.bests (
  uid uuid not null,
  course_id text not null,
  display_name text not null,
  banned boolean not null default false,
  time_ms integer not null check (time_ms > 0 and time_ms < 600000),
  updated_ms bigint not null default 0,
  primary key (uid, course_id)
);
create index if not exists bests_course on public.bests (course_id);

create table if not exists public.ghosts (
  uid uuid not null,
  course_id text not null,
  time_ms integer not null,
  samples text not null check (length(samples) < 400000),
  v smallint not null default 2,
  primary key (uid, course_id)
);

create table if not exists public.credit_events (
  id bigserial primary key,
  uid uuid not null,
  delta numeric not null,
  kind text not null,
  race_id text,
  note text,
  legacy_id text unique,          -- the Firebase document it came from
  created_at timestamptz not null default now()
);
create index if not exists credit_events_uid on public.credit_events (uid);

create table if not exists public.car_customization (
  uid uuid primary key,
  unlocked jsonb not null default '[]',
  primary_color jsonb not null,
  secondary_color jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.run_log (
  id bigserial primary key,
  uid uuid not null,
  display_name text,
  kind text,
  course_id text,
  outcome text,
  time_ms integer,
  data jsonb not null default '{}',
  legacy_id text unique,
  created_at timestamptz not null default now()
);
create index if not exists run_log_created on public.run_log (created_at desc);

create table if not exists public.season_awards (
  season text primary key,
  data jsonb not null default '{}'
);

create table if not exists public.admin_notes (
  uid uuid primary key,
  real_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.races (
  id text primary key,
  state text not null check (state in ('lobby', 'starting', 'running', 'settled')),
  course_id text,
  created_at timestamptz not null default now(),
  created_by uuid,
  join_deadline timestamptz,
  started_at timestamptz,
  ends_at timestamptz,
  settled_by uuid
);
create index if not exists races_created on public.races (created_at desc);

create table if not exists public.race_entries (
  race_id text not null references public.races (id) on delete cascade,
  uid uuid not null,
  display_name text not null,
  buy_in integer not null check (buy_in > 0),
  attempts integer[] not null default '{}',
  best_time_ms integer,
  placement integer,
  payout integer,
  primary key (race_id, uid)
);

-- Firebase uid -> the placeholder id its data lives under until claimed
create table if not exists public.legacy_ids (
  old_uid text primary key,
  new_id uuid not null unique default gen_random_uuid()
);

-- ----------------------------------------------------------------- helpers

-- the address a username signs in with (must match the game's USERNAME_DOMAIN)
create or replace function public.login_email(p_name text) returns text
language sql immutable as $$ select lower(p_name) || '@chat7689.github.io' $$;

-- the database clock, so every game counts race deadlines the same way
create or replace function public.server_ms() returns bigint
language sql volatile as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

-- the calling player's profile; refuses anyone not signed in, without a
-- profile, or banned
create or replace function public._player() returns public.profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.profiles;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'no profile' using errcode = '28000'; end if;
  if p.banned then raise exception 'this account is suspended' using errcode = '42501'; end if;
  return p;
end $$;

create or replace function public._balance(p_uid uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select floor(coalesce(sum(delta), 0) + 0.000000001)::integer from public.credit_events where uid = p_uid
$$;

create or replace function public.valid_hsl(c jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(c) = 'object'
    and (select count(*) from jsonb_object_keys(c)) = 3
    and jsonb_typeof(c -> 'h') = 'number' and (c ->> 'h')::numeric between 0 and 360
    and jsonb_typeof(c -> 's') = 'number' and (c ->> 's')::numeric between 0 and 100
    and jsonb_typeof(c -> 'l') = 'number' and (c ->> 'l')::numeric between 0 and 100
$$;

-- ---------------------------------------------------------- account setup

-- Moves everything held under a legacy placeholder id to a real login.
create or replace function public._adopt(p_from uuid, p_to uuid, p_name text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_from = p_to then return; end if;
  delete from public.profiles where id = p_to and legacy;           -- never happens, but never collide
  update public.profiles set id = p_to, legacy = false, display_name = p_name where id = p_from;
  update public.bests set uid = p_to, display_name = p_name where uid = p_from;
  update public.ghosts set uid = p_to where uid = p_from;
  update public.credit_events set uid = p_to where uid = p_from;
  update public.car_customization set uid = p_to where uid = p_from
    and not exists (select 1 from public.car_customization where uid = p_to);
  delete from public.car_customization where uid = p_from;
  update public.admin_notes set uid = p_to where uid = p_from
    and not exists (select 1 from public.admin_notes where uid = p_to);
  delete from public.admin_notes where uid = p_from;
  update public.run_log set uid = p_to where uid = p_from;
  update public.race_entries set uid = p_to where uid = p_from;
  update public.season_awards set data = replace(data::text, p_from::text, p_to::text)::jsonb
    where data::text like '%' || p_from::text || '%';
  update public.legacy_ids set new_id = p_to where new_id = p_from;
end $$;

-- Called by the game right after a new login is created. Checks the name
-- belongs to this login, then either takes over the player's Firebase-era
-- profile (no invite needed) or checks the invite code. A wrong code
-- removes the login again so the name stays free.
create or replace function public.claim_profile(p_name text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  leg public.profiles;
  inv text;
  typed text := coalesce(p_code, '');
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if exists (select 1 from public.profiles where id = me) then
    return jsonb_build_object('ok', true, 'existing', true);
  end if;
  if coalesce(p_name, '') !~ '^[A-Za-z0-9_-]{3,14}$' or email <> public.login_email(p_name) then
    return jsonb_build_object('ok', false, 'error', 'name');
  end if;
  select * into leg from public.profiles where legacy and lower(display_name) = lower(p_name) for update;
  if found then
    perform public._adopt(leg.id, me, leg.display_name);          -- their name as it always was
    return jsonb_build_object('ok', true, 'adopted', true);
  end if;
  if exists (select 1 from public.profiles where lower(display_name) = lower(p_name)) then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end if;
  select value ->> 'code' into inv from public.settings where key = 'invite';
  if inv is null or not (trim(typed) = inv or upper(regexp_replace(typed, '\s', '', 'g')) = upper(inv)) then
    -- the login goes too, so the name is free again (if this project's
    -- rules ever refuse that, a retry with the right code still works)
    begin delete from auth.users where id = me; exception when others then null; end;
    return jsonb_build_object('ok', false, 'error', 'invite');
  end if;
  insert into public.profiles (id, display_name) values (me, p_name);
  return jsonb_build_object('ok', true);
end $$;

-- Whether a name belongs to a player from before the move who has not
-- signed up again yet, so the sign-in page can tell them to (their old
-- password is not here). Asked before anyone is signed in.
create or replace function public.returning_player(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles where legacy and lower(display_name) = lower(trim(coalesce(p_name, ''))))
$$;

-- ------------------------------------------------------------- times

-- A best only ever gets faster. Returns {improved:false, serverMs} when
-- the server already holds a faster (or equal) run.
create or replace function public.submit_best(p_course text, p_time_ms integer, p_samples text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles := public._player(); cur integer;
begin
  if coalesce(p_course, '') !~ '^[a-z0-9]{1,16}$' or p_time_ms is null or p_time_ms <= 0 or p_time_ms >= 600000 then
    raise exception 'bad time' using errcode = '22023';
  end if;
  select time_ms into cur from public.bests where uid = p.id and course_id = p_course for update;
  if cur is not null and cur <= p_time_ms then
    return jsonb_build_object('improved', false, 'serverMs', cur);
  end if;
  insert into public.bests (uid, course_id, display_name, banned, time_ms, updated_ms)
  values (p.id, p_course, p.display_name, p.banned, p_time_ms, (extract(epoch from now()) * 1000)::bigint)
  on conflict (uid, course_id) do update
    set time_ms = excluded.time_ms, updated_ms = excluded.updated_ms, display_name = excluded.display_name, banned = excluded.banned;
  if p_samples is not null and length(p_samples) between 1 and 399999 then
    insert into public.ghosts (uid, course_id, time_ms, samples, v) values (p.id, p_course, p_time_ms, p_samples, 2)
    on conflict (uid, course_id) do update set time_ms = excluded.time_ms, samples = excluded.samples, v = 2;
  end if;
  return jsonb_build_object('improved', true);
end $$;

create or replace function public.reset_my_scores() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.bests where uid = auth.uid();
  delete from public.ghosts where uid = auth.uid();
end $$;

-- ------------------------------------------------------------- credits

create or replace function public.my_balance() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select public._balance(auth.uid())
$$;

-- +1 for finishing a course, +3 for a credit run
create or replace function public.grant_credit(p_kind text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles := public._player();
begin
  if p_kind not in ('grind', 'crun') then raise exception 'unknown credit' using errcode = '22023'; end if;
  -- no course is driven in under 10 seconds: a flood of calls earns nothing
  perform pg_advisory_xact_lock(hashtext('credits:' || p.id::text));
  if exists (select 1 from public.credit_events where uid = p.id and kind = p_kind and created_at > now() - interval '10 seconds') then
    return public._balance(p.id);
  end if;
  insert into public.credit_events (uid, delta, kind) values (p.id, case when p_kind = 'crun' then 3 else 1 end, p_kind);
  return public._balance(p.id);
end $$;

-- a colour pack: 10 credits, only if the player has them
create or replace function public.buy_color() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles := public._player();
begin
  perform pg_advisory_xact_lock(hashtext('credits:' || p.id::text));
  if public._balance(p.id) < 10 then raise exception 'You need 10 credits for a color.' using errcode = 'P0001'; end if;
  insert into public.credit_events (uid, delta, kind) values (p.id, -10, 'color');
  return public._balance(p.id);
end $$;

-- ---------------------------------------------------------------- races
-- States: lobby -> starting (2+ joined, 60 s to join) -> running (course
-- chosen, 10 minutes) -> settled (payouts written). Every step is done
-- here, checked against the database clock.

create or replace function public.open_lobby() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare rid text;
begin
  perform public._player();
  perform pg_advisory_xact_lock(hashtext('races'));
  select id into rid from public.races where state in ('lobby', 'starting', 'running') order by created_at desc limit 1;
  if rid is not null then return rid; end if;
  rid := 'race_' || replace(gen_random_uuid()::text, '-', '');
  insert into public.races (id, state, created_by) values (rid, 'lobby', auth.uid());
  return rid;
end $$;

create or replace function public.join_race(p_race text, p_buy_in integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles := public._player(); r public.races; n integer;
begin
  if p_buy_in is null or p_buy_in < 1 or p_buy_in > 1000000 then raise exception 'Enter a buy-in of at least 1 credit.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('credits:' || p.id::text));
  select * into r from public.races where id = p_race for update;
  if not found or r.state not in ('lobby', 'starting') then raise exception 'That race is no longer taking entries.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.race_entries where race_id = p_race and uid = p.id) then
    raise exception 'You are already in this race.' using errcode = 'P0001';
  end if;
  if public._balance(p.id) < p_buy_in then raise exception 'That is more credits than you have.' using errcode = 'P0001'; end if;
  insert into public.race_entries (race_id, uid, display_name, buy_in) values (p_race, p.id, p.display_name, p_buy_in);
  insert into public.credit_events (uid, delta, kind, race_id) values (p.id, -p_buy_in, 'buyin', p_race);
  select count(*) into n from public.race_entries where race_id = p_race;
  if r.state = 'lobby' and n >= 2 then
    update public.races set state = 'starting', join_deadline = now() + interval '60 seconds' where id = p_race;
  end if;
  return jsonb_build_object('ok', true, 'balance', public._balance(p.id));
end $$;

-- Moves a race on if its deadline has passed: picks the course (from the
-- game's current map list) or settles it. Safe to call as often as liked.
create or replace function public.advance_race(p_race text, p_pool text[]) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.races;
  pool text[];
  pot numeric; denom numeric; nfin integer;
  e record;
  pay integer;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into r from public.races where id = p_race for update;
  if not found then return null; end if;
  if r.state = 'lobby' and (select count(*) from public.race_entries where race_id = p_race) >= 2 then
    update public.races set state = 'starting', join_deadline = now() + interval '60 seconds' where id = p_race;
    return 'starting';
  end if;
  if r.state = 'starting' and now() >= r.join_deadline then
    select array_agg(distinct c) into pool from unnest(coalesce(p_pool, '{}')) c where c ~ '^s2c[0-9]{1,3}$';
    if pool is null or array_length(pool, 1) is null then raise exception 'no courses' using errcode = '22023'; end if;
    update public.races set state = 'running', course_id = pool[1 + floor(random() * array_length(pool, 1))::integer],
      started_at = now(), ends_at = now() + interval '10 minutes' where id = p_race;
    return 'running';
  end if;
  if r.state = 'running' and now() >= r.ends_at then
    select coalesce(sum(buy_in), 0) into pot from public.race_entries where race_id = p_race;
    with ranked as (
      select uid, row_number() over (order by best_time_ms, uid) as place
      from public.race_entries where race_id = p_race and best_time_ms is not null
    )
    update public.race_entries en set placement = ranked.place from ranked
    where en.race_id = p_race and en.uid = ranked.uid;
    select count(*), coalesce(sum(buy_in::numeric / placement), 0) into nfin, denom
      from public.race_entries where race_id = p_race and placement is not null;
    for e in select * from public.race_entries where race_id = p_race loop
      if nfin = 0 then
        pay := e.buy_in;                               -- nobody finished: everyone gets their stake back
      elsif e.placement is null then
        pay := null;                                   -- did not finish: their stake is in the pot
      else
        pay := least(floor(pot / denom * e.buy_in / e.placement), pot)::integer;
      end if;
      if pay is not null then
        update public.race_entries set payout = pay where race_id = p_race and uid = e.uid;
        insert into public.credit_events (uid, delta, kind, race_id) values (e.uid, pay, 'payout', p_race);
      end if;
    end loop;
    update public.races set state = 'settled', settled_by = auth.uid() where id = p_race;
    return 'settled';
  end if;
  return r.state;
end $$;

-- One attempt of the caller's, while the race is running (null = did not
-- finish). Returns the number of attempts used, this one included.
create or replace function public.record_race_attempt(p_race text, p_time_ms integer) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare en public.race_entries; st text;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select state into st from public.races where id = p_race;
  if st is distinct from 'running' then raise exception 'That race is over.' using errcode = 'P0001'; end if;
  select * into en from public.race_entries where race_id = p_race and uid = auth.uid() for update;
  if not found then raise exception 'You are not in this race.' using errcode = 'P0001'; end if;
  if coalesce(array_length(en.attempts, 1), 0) >= 3 then raise exception 'All 3 attempts are used.' using errcode = 'P0001'; end if;
  -- null is an attempt that did not finish
  if p_time_ms is not null and (p_time_ms <= 0 or p_time_ms >= 600000) then raise exception 'bad time' using errcode = '22023'; end if;
  update public.race_entries
    set attempts = attempts || p_time_ms, best_time_ms = least(coalesce(best_time_ms, p_time_ms), p_time_ms)
    where race_id = p_race and uid = auth.uid();
  return coalesce(array_length(en.attempts, 1), 0) + 1;
end $$;

-- ---------------------------------------------------------------- admin

create or replace function public._require_admin() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'admins only' using errcode = '42501'; end if;
end $$;

-- every player with their balance and real name, in one query
create or replace function public.admin_players() returns table (
  id uuid, display_name text, banned boolean, legacy boolean, created_at timestamptz, credits integer, real_name text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return query
    select p.id, p.display_name, p.banned, p.legacy, p.created_at,
           coalesce(floor(c.total + 0.000000001), 0)::integer, n.real_name
    from public.profiles p
    left join (select uid, sum(delta) as total from public.credit_events group by uid) c on c.uid = p.id
    left join public.admin_notes n on n.uid = p.id
    order by p.display_name;
end $$;

create or replace function public.admin_credit_totals() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return (select jsonb_build_object(
    'earned', coalesce(sum(delta) filter (where delta > 0), 0),
    'spent', coalesce(-sum(delta) filter (where delta < 0), 0)) from public.credit_events);
end $$;

create or replace function public.admin_set_credits(p_uid uuid, p_target integer) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare live numeric;
begin
  perform public._require_admin();
  if p_target is null or p_target < 0 or p_target > 1000000000 then raise exception 'bad amount' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('credits:' || p_uid::text));
  select coalesce(sum(delta), 0) into live from public.credit_events where uid = p_uid;
  if live <> p_target then
    insert into public.credit_events (uid, delta, kind, note) values (p_uid, p_target - live, 'adjust', 'admin set to ' || p_target);
  end if;
  return public._balance(p_uid);
end $$;

create or replace function public.admin_set_banned(p_uid uuid, p_banned boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  update public.profiles set banned = p_banned where id = p_uid;
  update public.bests set banned = p_banned where uid = p_uid;
end $$;

-- a new password for a player who forgot theirs (logins have no inbox, so
-- there is no reset email); bcrypt, the same as Supabase's own sign-up
create or replace function public.admin_set_password(p_uid uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform public._require_admin();
  if length(coalesce(p_password, '')) < 6 then raise exception 'Use at least 6 characters.' using errcode = 'P0001'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
    where id = p_uid;
  if not found then
    raise exception 'That player has no login yet (they have not signed up since the move).' using errcode = 'P0001';
  end if;
end $$;

-- removes a player completely, login included
create or replace function public.admin_delete_player(p_uid uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer := 0; added integer;
begin
  perform public._require_admin();
  delete from public.bests where uid = p_uid; get diagnostics added = row_count; n := n + added;
  delete from public.ghosts where uid = p_uid; get diagnostics added = row_count; n := n + added;
  delete from public.credit_events where uid = p_uid; get diagnostics added = row_count; n := n + added;
  delete from public.run_log where uid = p_uid; get diagnostics added = row_count; n := n + added;
  delete from public.race_entries where uid = p_uid; get diagnostics added = row_count; n := n + added;
  delete from public.car_customization where uid = p_uid; get diagnostics added = row_count; n := n + added;
  delete from public.admin_notes where uid = p_uid; get diagnostics added = row_count; n := n + added;
  delete from public.admins where user_id = p_uid;
  update public.season_awards set data = (
    select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(data) where value ->> 'uid' is distinct from p_uid::text);
  delete from public.profiles where id = p_uid; get diagnostics added = row_count; n := n + added;
  delete from public.legacy_ids where new_id = p_uid;
  begin delete from auth.users where id = p_uid; exception when others then null; end;
  return n;
end $$;

-- Loads one chunk of a Firebase export or a backup (the admin page sends it
-- in parts), and says how many rows were added. Safe to run again: nothing
-- is duplicated, and a faster time is never replaced by a slower one. A
-- player who already signed up again under their old name gets their old
-- data straight away.
create or replace function public.admin_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb;
  id_of uuid;
  counts jsonb := '{}';
  n integer;
  added integer;
begin
  perform public._require_admin();

  -- players first, so everything else can be mapped to them
  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p -> 'profiles', '[]')) loop
    if coalesce(r ->> 'id', '') = '' or coalesce(r ->> 'displayName', '') = '' then continue; end if;
    select new_id into id_of from public.legacy_ids where old_uid = r ->> 'id';
    if id_of is null then
      -- already back under a new login? then that login is who this is
      select pr.id into id_of from public.profiles pr where lower(pr.display_name) = lower(r ->> 'displayName') and not pr.legacy;
      insert into public.legacy_ids (old_uid, new_id) values (r ->> 'id', coalesce(id_of, gen_random_uuid()))
        on conflict (old_uid) do nothing;
      select new_id into id_of from public.legacy_ids where old_uid = r ->> 'id';
    end if;
    if not exists (select 1 from public.profiles where id = id_of) then
      insert into public.profiles (id, display_name, banned, legacy, created_at)
      values (id_of, r ->> 'displayName', coalesce((r ->> 'banned')::boolean, false), true,
              coalesce(to_timestamp((r ->> 'createdAt')::numeric / 1000), now()))
      on conflict do nothing;
      get diagnostics added = row_count; n := n + added;
    end if;
  end loop;
  counts := counts || jsonb_build_object('profiles', n);

  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p -> 'bests', '[]')) loop
    select new_id into id_of from public.legacy_ids where old_uid = r ->> 'uid';
    if id_of is null or (r ->> 'timeMs') is null then continue; end if;
    insert into public.bests (uid, course_id, display_name, banned, time_ms, updated_ms)
    values (id_of, r ->> 'courseId', coalesce(r ->> 'displayName', 'Driver'), coalesce((r ->> 'banned')::boolean, false),
            round((r ->> 'timeMs')::numeric)::integer, coalesce((r ->> 'updatedMs')::numeric, 0)::bigint)
    on conflict (uid, course_id) do update
      set time_ms = excluded.time_ms, updated_ms = excluded.updated_ms
      where excluded.time_ms < public.bests.time_ms;
    get diagnostics added = row_count; n := n + added;
  end loop;
  counts := counts || jsonb_build_object('bests', n);

  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p -> 'ghosts', '[]')) loop
    select new_id into id_of from public.legacy_ids where old_uid = r ->> 'uid';
    if id_of is null or coalesce(r ->> 'samples', '') = '' or length(r ->> 'samples') >= 400000 then continue; end if;
    insert into public.ghosts (uid, course_id, time_ms, samples, v)
    values (id_of, r ->> 'courseId', round((r ->> 'timeMs')::numeric)::integer, r ->> 'samples', coalesce((r ->> 'v')::smallint, 1))
    on conflict (uid, course_id) do update
      set time_ms = excluded.time_ms, samples = excluded.samples, v = excluded.v
      where excluded.time_ms < public.ghosts.time_ms;
    get diagnostics added = row_count; n := n + added;
  end loop;
  counts := counts || jsonb_build_object('ghosts', n);

  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p -> 'creditEvents', '[]')) loop
    select new_id into id_of from public.legacy_ids where old_uid = r ->> 'uid';
    if id_of is null or jsonb_typeof(r -> 'delta') <> 'number' then continue; end if;
    insert into public.credit_events (uid, delta, kind, race_id, note, legacy_id, created_at)
    values (id_of, (r ->> 'delta')::numeric,
            coalesce(r ->> 'kind', substring(r ->> 'id' from '_([a-z]+)$'), 'legacy'),
            r ->> 'raceId', r ->> 'note', r ->> 'id',
            coalesce(to_timestamp((r ->> 'createdAt')::numeric / 1000), now()))
    on conflict (legacy_id) do nothing;
    get diagnostics added = row_count; n := n + added;
  end loop;
  counts := counts || jsonb_build_object('creditEvents', n);

  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p -> 'carCustomization', '[]')) loop
    select new_id into id_of from public.legacy_ids where old_uid = coalesce(r ->> 'uid', r ->> 'id');
    if id_of is null or not public.valid_hsl(r -> 'primary') or not public.valid_hsl(r -> 'secondary') then continue; end if;
    -- A player who signed up before the import already has starter
    -- colours: their old ones join the list and are put back on the car.
    -- Once merged, the old list is contained in theirs, so a repeat import
    -- leaves whatever they have chosen since alone.
    insert into public.car_customization (uid, unlocked, primary_color, secondary_color)
    values (id_of, coalesce(r -> 'unlocked', '[]'), r -> 'primary', r -> 'secondary')
    on conflict (uid) do update
      set unlocked = (select coalesce(jsonb_agg(distinct x), '[]') from (
            select jsonb_array_elements(excluded.unlocked) x
            union select jsonb_array_elements(public.car_customization.unlocked)) u),
          primary_color = excluded.primary_color, secondary_color = excluded.secondary_color, updated_at = now()
      where not (public.car_customization.unlocked @> excluded.unlocked);
    get diagnostics added = row_count; n := n + added;
  end loop;
  counts := counts || jsonb_build_object('carCustomization', n);

  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p -> 'adminNotes', '[]')) loop
    select new_id into id_of from public.legacy_ids where old_uid = r ->> 'id';
    if id_of is null or coalesce(r ->> 'realName', '') = '' then continue; end if;
    insert into public.admin_notes (uid, real_name) values (id_of, r ->> 'realName') on conflict (uid) do nothing;
    get diagnostics added = row_count; n := n + added;
  end loop;
  counts := counts || jsonb_build_object('adminNotes', n);

  n := 0;
  for r in select * from jsonb_array_elements(coalesce(p -> 'runLog', '[]')) loop
    select new_id into id_of from public.legacy_ids where old_uid = r ->> 'uid';
    if id_of is null then continue; end if;
    insert into public.run_log (uid, display_name, kind, course_id, outcome, time_ms, data, legacy_id, created_at)
    values (id_of, r ->> 'displayName', r ->> 'kind', r ->> 'courseId', r ->> 'outcome',
            round(coalesce((r ->> 'timeMs')::numeric, 0))::integer,
            r - 'uid' - 'displayName' - 'kind' - 'courseId' - 'outcome' - 'timeMs' - 'createdAt' - 'id',
            r ->> 'id', coalesce(to_timestamp((r ->> 'createdAt')::numeric / 1000), now()))
    on conflict (legacy_id) do nothing;
    get diagnostics added = row_count; n := n + added;
  end loop;
  counts := counts || jsonb_build_object('runLog', n);

  -- season awards: each placing's uid mapped to its new id
  for r in select * from jsonb_array_elements(coalesce(p -> 'seasonAwards', '[]')) loop
    insert into public.season_awards (season, data)
    select r ->> 'id', coalesce(jsonb_object_agg(k, v || jsonb_build_object('uid',
             coalesce((select new_id::text from public.legacy_ids where old_uid = v ->> 'uid'), v ->> 'uid'))), '{}')
      from jsonb_each(r - 'id') as t(k, v) where jsonb_typeof(v) = 'object'
    on conflict (season) do update set data = excluded.data;
  end loop;

  if p ? 'invite' and coalesce(p -> 'invite' ->> 'code', '') <> '' then
    insert into public.settings (key, value) values ('invite', jsonb_build_object('code', p -> 'invite' ->> 'code'))
    on conflict (key) do nothing;
  end if;
  if p ? 'adminPasscode' and coalesce(p -> 'adminPasscode' ->> 'passHash', '') <> '' then
    insert into public.settings (key, value)
    values ('admin_passcode', jsonb_build_object('salt', p -> 'adminPasscode' ->> 'salt', 'passHash', p -> 'adminPasscode' ->> 'passHash'))
    on conflict (key) do nothing;
  end if;
  return counts;
end $$;

-- ---------------------------------------------------- row level security

alter table public.admins enable row level security;
alter table public.settings enable row level security;
alter table public.profiles enable row level security;
alter table public.bests enable row level security;
alter table public.ghosts enable row level security;
alter table public.credit_events enable row level security;
alter table public.car_customization enable row level security;
alter table public.run_log enable row level security;
alter table public.season_awards enable row level security;
alter table public.admin_notes enable row level security;
alter table public.races enable row level security;
alter table public.race_entries enable row level security;
alter table public.legacy_ids enable row level security;

do $$
declare t text;
begin
  -- admins may read and change everything directly
  foreach t in array array['admins', 'settings', 'profiles', 'bests', 'ghosts', 'credit_events', 'car_customization',
                          'run_log', 'season_awards', 'admin_notes', 'races', 'race_entries', 'legacy_ids'] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
  -- signed-in players may read the shared game data
  foreach t in array array['profiles', 'bests', 'ghosts', 'car_customization', 'season_awards', 'races', 'race_entries'] loop
    execute format('drop policy if exists player_read on public.%I', t);
    execute format('create policy player_read on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

drop policy if exists own_admin_row on public.admins;
create policy own_admin_row on public.admins for select to authenticated using (user_id = auth.uid());

drop policy if exists own_credits on public.credit_events;
create policy own_credits on public.credit_events for select to authenticated using (uid = auth.uid());

-- a player writes only their own colours, in the right shape
drop policy if exists own_colors_insert on public.car_customization;
create policy own_colors_insert on public.car_customization for insert to authenticated
  with check (uid = auth.uid() and public.valid_hsl(primary_color) and public.valid_hsl(secondary_color)
              and jsonb_typeof(unlocked) = 'array' and jsonb_array_length(unlocked) <= 500);
drop policy if exists own_colors_update on public.car_customization;
create policy own_colors_update on public.car_customization for update to authenticated
  using (uid = auth.uid())
  with check (uid = auth.uid() and public.valid_hsl(primary_color) and public.valid_hsl(secondary_color)
              and jsonb_typeof(unlocked) = 'array' and jsonb_array_length(unlocked) <= 500);

-- every attempt is logged by the player's own game
drop policy if exists own_run_insert on public.run_log;
create policy own_run_insert on public.run_log for insert to authenticated
  with check (uid = auth.uid() and kind in ('campaign', 'creditsrun', 'race')
              and time_ms > 0 and time_ms < 600000
              and (outcome is null or outcome in ('finished', 'restarted', 'terminated')));

-- table access for the API roles (the policies above decide the rows)
grant usage on schema public to authenticated;
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- functions: signed-in players only (each one checks its own rules)
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.returning_player(text) to anon;

-- ------------------------------------------------------------- live updates
-- The game follows these tables as they change (leaderboards, balances,
-- races). Deletions carry the whole old row so boards can drop it.
alter table public.bests replica identity full;
alter table public.race_entries replica identity full;
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['bests', 'credit_events', 'races', 'race_entries'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------- make yourself admin
-- After you have signed up in the game, run this ONE line on its own
-- (with your username instead of YOUR_USERNAME):
--
--   insert into public.admins (user_id) select id from auth.users where email = public.login_email('YOUR_USERNAME');
