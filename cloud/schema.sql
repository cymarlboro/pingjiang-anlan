-- 平江安澜: Independent app schema. NOT DEPLOYED. No original application tables are modified.
begin;
create schema if not exists private;
-- Shared private schema privileges remain unchanged for the original application.
grant usage on schema private to authenticated;
create table public.pja_documents (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 filename text not null check(char_length(filename) between 1 and 255 and btrim(filename)<>'' and filename !~ '[[:cntrl:]]'),
 object_path text not null unique, mime text not null check(mime in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown')),
 size bigint not null check(size between 1 and 31457280), extracted_text text check(extracted_text is null or char_length(extracted_text)<=1000000), created_at timestamptz not null default now(),
 unique(id,owner_id), check(object_path=owner_id::text||'/'||id::text||'/original')
);
create index pja_documents_owner_created_idx on public.pja_documents(owner_id,created_at desc);
create table public.pja_questions (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, document_id uuid not null,
 question text not null check(char_length(question) between 1 and 10000 and btrim(question)<>''),
 answer text not null default '' check(char_length(answer)<=20000),
 type text not null check(char_length(type) between 1 and 64 and btrim(type)<>''),
 source_quote text not null default '' check(char_length(source_quote)<=20000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(document_id,owner_id) references public.pja_documents(id,owner_id) on delete cascade
);
create index pja_questions_owner_idx on public.pja_questions(owner_id);
create index pja_questions_document_owner_idx on public.pja_questions(document_id,owner_id);
create table public.pja_moderation (
 document_id uuid primary key references public.pja_documents(id) on delete cascade,
 status text not null check(status in ('pending','approved','needs_changes','removed')),
 notes text not null default '' check(char_length(notes)<=5000),
 reviewer_id uuid not null references auth.users(id) on delete restrict,
 reviewed_at timestamptz not null default now()
);
create index pja_moderation_reviewer_idx on public.pja_moderation(reviewer_id,reviewed_at desc);
create table public.pja_audit_events (
 id bigint generated always as identity primary key, occurred_at timestamptz not null default clock_timestamp(), actor_id uuid,
 operation text not null check(operation in ('INSERT','UPDATE','DELETE')), table_schema text not null, table_name text not null,
 row_id text not null, document_id uuid, old_row jsonb, new_row jsonb,
 check((table_schema='public' and table_name in ('pja_documents','pja_questions','pja_moderation')) or (table_schema='private' and table_name='pja_admin_members'))
);
create index pja_audit_events_occurred_idx on public.pja_audit_events(occurred_at desc);
create index pja_audit_events_document_idx on public.pja_audit_events(document_id,occurred_at desc);
create index pja_audit_events_actor_idx on public.pja_audit_events(actor_id,occurred_at desc);
create table private.pja_admin_members(user_id uuid primary key references auth.users(id) on delete cascade,created_at timestamptz not null default now());
create function private.is_pja_admin() returns boolean language sql stable security invoker set search_path='' as $f$
 select exists(select 1 from private.pja_admin_members m where m.user_id=auth.uid());
$f$;
create function private.pja_documents_guard_immutable() returns trigger language plpgsql security invoker set search_path='' as $f$
begin
 if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id then raise exception using errcode='42501',message='document identity is immutable'; end if;
 return new;
end;$f$;
create function private.pja_moderation_stamp() returns trigger language plpgsql security invoker set search_path='' as $f$
begin
 if tg_op='UPDATE' and new.document_id is distinct from old.document_id then raise exception using errcode='42501',message='review document is immutable'; end if;
 new.reviewed_at:=clock_timestamp(); return new;
end;$f$;
create function private.pja_audit_row() returns trigger language plpgsql security definer set search_path='' as $f$
declare v_old_row jsonb; v_new_row jsonb; v_row_id text; v_document_id uuid;
begin
 if tg_op not in ('INSERT','UPDATE','DELETE') then raise exception 'invalid audit trigger'; end if;
 if tg_op<>'INSERT' then v_old_row:=to_jsonb(old); end if;
 if tg_op<>'DELETE' then v_new_row:=to_jsonb(new); end if;
 if tg_table_schema='public' and tg_table_name='pja_documents' then
  v_document_id:=coalesce((v_new_row->>'id')::uuid,(v_old_row->>'id')::uuid); v_row_id:=v_document_id::text;
  v_old_row:=v_old_row-'extracted_text'; v_new_row:=v_new_row-'extracted_text';
 elsif tg_table_schema='public' and tg_table_name='pja_questions' then
  v_row_id:=coalesce(v_new_row->>'id',v_old_row->>'id'); v_document_id:=coalesce((v_new_row->>'document_id')::uuid,(v_old_row->>'document_id')::uuid);
  v_old_row:=v_old_row-'question'-'answer'-'source_quote'; v_new_row:=v_new_row-'question'-'answer'-'source_quote';
 elsif tg_table_schema='public' and tg_table_name='pja_moderation' then
  v_document_id:=coalesce((v_new_row->>'document_id')::uuid,(v_old_row->>'document_id')::uuid); v_row_id:=v_document_id::text;
 elsif tg_table_schema='private' and tg_table_name='pja_admin_members' then
  v_row_id:=coalesce(v_new_row->>'user_id',v_old_row->>'user_id');
 else raise exception 'unsupported audit relation'; end if;
 if v_row_id is null then raise exception 'missing audit identity'; end if;
 insert into public.pja_audit_events(actor_id,operation,table_schema,table_name,row_id,document_id,old_row,new_row)
 values(auth.uid(),tg_op,tg_table_schema,tg_table_name,v_row_id,v_document_id,v_old_row,v_new_row);
 return null;
end;$f$;
create function private.pja_forbid_audit_mutation() returns trigger language plpgsql security invoker set search_path='' as $f$
begin raise exception using errcode='42501',message='pja_audit_events is append-only'; end;$f$;
create trigger pja_documents_guard_immutable before update on public.pja_documents for each row execute function private.pja_documents_guard_immutable();
create trigger pja_moderation_stamp before insert or update on public.pja_moderation for each row execute function private.pja_moderation_stamp();
create trigger pja_documents_audit after insert or update or delete on public.pja_documents for each row execute function private.pja_audit_row();
create trigger pja_questions_audit after insert or update or delete on public.pja_questions for each row execute function private.pja_audit_row();
create trigger pja_moderation_audit after insert or update or delete on public.pja_moderation for each row execute function private.pja_audit_row();
create trigger pja_admin_members_audit after insert or update or delete on private.pja_admin_members for each row execute function private.pja_audit_row();
create trigger pja_audit_events_immutable before update or delete on public.pja_audit_events for each row execute function private.pja_forbid_audit_mutation();
alter table public.pja_documents enable row level security;
alter table public.pja_questions enable row level security;
alter table public.pja_moderation enable row level security;
alter table public.pja_audit_events enable row level security;
alter table private.pja_admin_members enable row level security;
create policy pja_documents_select_owner_or_admin on public.pja_documents for select to authenticated using(owner_id=(select auth.uid()) or private.is_pja_admin());
create policy pja_documents_insert_owner on public.pja_documents for insert to authenticated with check(owner_id=(select auth.uid()));
create policy pja_documents_update_owner on public.pja_documents for update to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy pja_documents_delete_owner on public.pja_documents for delete to authenticated using(owner_id=(select auth.uid()));
create policy pja_questions_select_owner_or_admin on public.pja_questions for select to authenticated using(owner_id=(select auth.uid()) or private.is_pja_admin());
create policy pja_questions_insert_owner on public.pja_questions for insert to authenticated with check(owner_id=(select auth.uid()));
create policy pja_questions_update_owner on public.pja_questions for update to authenticated using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
create policy pja_questions_delete_owner on public.pja_questions for delete to authenticated using(owner_id=(select auth.uid()));
create policy pja_moderation_select_owner_or_admin on public.pja_moderation for select to authenticated using(private.is_pja_admin() or exists(select 1 from public.pja_documents d where d.id=pja_moderation.document_id and d.owner_id=(select auth.uid())));
create policy pja_moderation_insert_admin on public.pja_moderation for insert to authenticated with check(private.is_pja_admin() and reviewer_id=(select auth.uid()));
create policy pja_moderation_update_admin on public.pja_moderation for update to authenticated using(private.is_pja_admin()) with check(private.is_pja_admin() and reviewer_id=(select auth.uid()));
create policy pja_moderation_delete_admin on public.pja_moderation for delete to authenticated using(private.is_pja_admin());
create policy pja_audit_events_select_admin on public.pja_audit_events for select to authenticated using(private.is_pja_admin());
create policy pja_admin_members_select_self on private.pja_admin_members for select to authenticated using(user_id=(select auth.uid()));
revoke all on table public.pja_documents,public.pja_questions,public.pja_moderation,public.pja_audit_events,private.pja_admin_members from public,anon,authenticated;
revoke all on sequence public.pja_audit_events_id_seq from public,anon,authenticated;
grant select,insert,update,delete on table public.pja_documents,public.pja_questions,public.pja_moderation to authenticated;
grant select on table public.pja_audit_events,private.pja_admin_members to authenticated;
revoke all on function private.is_pja_admin() from public,anon,authenticated;
grant execute on function private.is_pja_admin() to authenticated;
revoke all on function private.pja_documents_guard_immutable(),private.pja_moderation_stamp(),private.pja_audit_row(),private.pja_forbid_audit_mutation() from public,anon,authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('pja-originals','pja-originals',false,31457280,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown']::text[]);
create policy pja_originals_select_owner_or_admin on storage.objects for select to authenticated using(bucket_id='pja-originals' and (private.is_pja_admin() or (split_part(name,'/',1)=(select auth.uid())::text and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original$')));
create policy pja_originals_insert_owner on storage.objects for insert to authenticated with check(bucket_id='pja-originals' and split_part(name,'/',1)=(select auth.uid())::text and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original$');
create policy pja_originals_delete_owner on storage.objects for delete to authenticated using(bucket_id='pja-originals' and split_part(name,'/',1)=(select auth.uid())::text and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original$');
create policy pja_originals_no_update on storage.objects as restrictive for update to authenticated using(bucket_id<>'pja-originals') with check(bucket_id<>'pja-originals');
commit;
