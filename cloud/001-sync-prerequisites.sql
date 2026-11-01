-- Independent namespace only. Does not revoke or replace original application objects.
begin;
create schema if not exists private;
grant usage on schema private to authenticated;
create table if not exists private.pja_admin_members (
 user_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
alter table private.pja_admin_members enable row level security;
drop policy if exists pja_admin_members_select_self on private.pja_admin_members;
create policy pja_admin_members_select_self on private.pja_admin_members
 for select to authenticated using(user_id=(select auth.uid()));
revoke all on table private.pja_admin_members from public,anon,authenticated;
grant select on table private.pja_admin_members to authenticated;
create or replace function private.is_pja_admin() returns boolean
 language sql stable security invoker set search_path='' as $f$
 select exists(select 1 from private.pja_admin_members m where m.user_id=auth.uid());
$f$;
revoke all on function private.is_pja_admin() from public,anon,authenticated;
grant execute on function private.is_pja_admin() to authenticated;
commit;
