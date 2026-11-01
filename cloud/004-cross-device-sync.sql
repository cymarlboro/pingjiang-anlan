-- 平江安澜 1.0: independent-app same-account Android/Windows sync. DRAFT, not yet deployed.
-- No secret/service keys. Existing document moderation policies remain intact.
begin;
create or replace function private.pja_sync_payload_is_safe(input jsonb)
returns boolean language sql immutable security invoker set search_path = '' as $safe$
 with recursive nodes(value) as (
   select input
   union all
   select child.value from nodes n cross join lateral (
     select e.value from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end) e
     union all
     select a.value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(n.value)='array' then n.value else '[]'::jsonb end) a
   ) child
 )
 select not exists (
   select 1 from nodes n cross join lateral pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end) k(key)
   where pg_catalog.regexp_replace(pg_catalog.lower(k.key),'[^a-z0-9]','','g') ~ '(key|token|secret|password|credential|role|roles)$'
   or pg_catalog.regexp_replace(pg_catalog.lower(k.key),'[^a-z0-9]','','g') = any(array[
     'key','apikey','token','password','secret','authorization','auth','bearer','accesstoken','refreshtoken',
     'clientsecret','credential','credentials','keystore','storepass','keypass','privatekey','servicerole','role','roles','isadmin'
   ])
 );
$safe$;
revoke all on function private.pja_sync_payload_is_safe(jsonb) from public,anon,authenticated;
create table if not exists public.pja_learning_state (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 revision bigint not null default 0 check(revision between 0 and 9007199254740990),
 payload jsonb not null check(pg_catalog.jsonb_typeof(payload)='object' and pg_catalog.octet_length(payload::text)<=16777216),
 updated_at timestamptz not null default pg_catalog.now()
);
alter table public.pja_learning_state enable row level security;
drop policy if exists pja_learning_state_select_owner_or_admin on public.pja_learning_state;
create policy pja_learning_state_select_owner_or_admin on public.pja_learning_state
 for select to authenticated using(owner_id=(select auth.uid()) or private.is_pja_admin());
revoke all on table public.pja_learning_state from public,anon,authenticated;
grant select on table public.pja_learning_state to authenticated;
-- Clients cannot modify the table directly; only the owner-scoped CAS function writes.
create or replace function public.pja_sync_commit(expected_revision bigint,new_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $sync$
declare
 v_owner uuid := auth.uid();
 v_revision bigint;
 v_bad boolean;
begin
 if v_owner is null then raise exception using errcode='PT401',message='Sign in required'; end if;
 if expected_revision is null or expected_revision<0 or expected_revision>=9007199254740990 then
   raise exception using errcode='PT400',message='Invalid revision';
 end if;
 if new_payload is null or pg_catalog.jsonb_typeof(new_payload) is distinct from 'object'
    or (new_payload->>'schemaVersion') is distinct from '1'
    or pg_catalog.jsonb_typeof(new_payload->'state') is distinct from 'object'
    or pg_catalog.jsonb_typeof(new_payload->'native') is distinct from 'object'
    or new_payload - array['schemaVersion','state','native'] <> '{}'::jsonb
    or pg_catalog.octet_length(new_payload::text)>16777216 then
   raise exception using errcode='PT400',message='Invalid sync payload';
 end if;
 if (new_payload->'state') - array['schemaVersion','settings','referenceIds','selectedIds','answerEdits','session','history','imports','schedule','lastUpdated'] <> '{}'::jsonb
    or (new_payload->'native') - array['customContent','imports'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(new_payload->'native'->'customContent') is distinct from 'object'
    or pg_catalog.jsonb_typeof(new_payload->'native'->'imports') is distinct from 'array'
    or (new_payload->'native'->'customContent') - array['schemaVersion','customQuestions','customSources','customTypes','customAnswers'] <> '{}'::jsonb then
   raise exception using errcode='PT400',message='Unexpected sync fields';
 end if;
 if not private.pja_sync_payload_is_safe(new_payload) then
   raise exception using errcode='PT400',message='Credentials are forbidden in sync';
 end if;
 -- A concurrent first writer either wins this insert or is read after its commit.
 insert into public.pja_learning_state(owner_id,revision,payload)
 values(v_owner,0,new_payload) on conflict(owner_id) do nothing;
 select s.revision into v_revision from public.pja_learning_state s where s.owner_id=v_owner for update;
 if v_revision is distinct from expected_revision then
   raise exception using errcode='PT409',message='Sync revision conflict';
 end if;
 update public.pja_learning_state s set revision=v_revision+1,payload=new_payload,updated_at=pg_catalog.clock_timestamp()
 where s.owner_id=v_owner;
 return pg_catalog.jsonb_build_object('ownerId',v_owner,'revision',v_revision+1,'payload',new_payload,'conflict',false);
end;
$sync$;
revoke all on function public.pja_sync_commit(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.pja_sync_commit(bigint,jsonb) to authenticated;
comment on table public.pja_learning_state is 'Private per-account study records and parsed imported content. No API keys or auth tokens. Admin may inspect uploads; direct client writes are forbidden.';
notify pgrst,'reload schema';
commit;
