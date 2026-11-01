-- Transactional synthetic account isolation and CAS checks. No real login/key.
-- Every fixture (including temporary admin membership) is rolled back.
begin;
select set_config('pja.test.original_count',(select count(*)::text from public.scj_learning_state),true);
select set_config('scj.test.a',gen_random_uuid()::text,true),
       set_config('scj.test.b',gen_random_uuid()::text,true),
       set_config('scj.test.admin',gen_random_uuid()::text,true);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select current_setting('scj.test.'||v)::uuid,'authenticated','authenticated',
       current_setting('scj.test.'||v)||'@example.invalid','{}','{}',now(),now()
from unnest(array['a','b','admin']) v;
insert into private.pja_admin_members(user_id) values(current_setting('scj.test.admin')::uuid);
select set_config('scj.test.payload','{"schemaVersion":1,"state":{"schemaVersion":2,"history":[]},"native":{"customContent":{"schemaVersion":1,"customQuestions":[],"customSources":[],"customTypes":{},"customAnswers":[]},"imports":[]}}',true);
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('scj.test.a'),'role','authenticated')::text,true);
do $test$
declare result jsonb; blocked boolean:=false;
begin
 result:=public.pja_sync_commit(0,current_setting('scj.test.payload')::jsonb);
 if result->>'ownerId'<>auth.uid()::text or (result->>'revision')::bigint<>1 then raise exception 'first owner/revision failed'; end if;
 result:=public.pja_sync_commit(1,current_setting('scj.test.payload')::jsonb);
 if (result->>'revision')::bigint<>2 then raise exception 'second revision failed'; end if;
 begin perform public.pja_sync_commit(0,current_setting('scj.test.payload')::jsonb);
 exception when sqlstate 'PT409' then blocked:=true; end;
 if not blocked then raise exception 'stale revision accepted'; end if;
 if (select count(*) from public.pja_learning_state where owner_id=auth.uid())<>1 then raise exception 'owner read failed'; end if;
 blocked:=false;
 begin update public.pja_learning_state set revision=7 where owner_id=auth.uid();
 exception when insufficient_privilege then blocked:=true; end;
 if not blocked then raise exception 'direct write accepted'; end if;
 blocked:=false;
 begin perform public.pja_sync_commit(2,jsonb_set(current_setting('scj.test.payload')::jsonb,'{state,metadata}', '{"userToken":"synthetic-only"}'::jsonb));
 exception when sqlstate 'PT400' then blocked:=true; end;
 if not blocked then raise exception 'unexpected state field accepted'; end if;
 blocked:=false;
 begin perform public.pja_sync_commit(2,jsonb_set(current_setting('scj.test.payload')::jsonb,'{state,answerEdits}', '{"1":{"userToken":"synthetic-only"}}'::jsonb));
 exception when sqlstate 'PT400' then blocked:=true; end;
 if not blocked then raise exception 'credential suffix accepted'; end if;
 if (select revision from public.pja_learning_state where owner_id=auth.uid())<>2 then raise exception 'failed write changed revision'; end if;
end;$test$;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('scj.test.b'),'role','authenticated','user_metadata',jsonb_build_object('is_admin',true))::text,true);
do $test$
begin
 if private.is_pja_admin() then raise exception 'metadata admin spoof accepted'; end if;
 if exists(select 1 from public.pja_learning_state where owner_id=current_setting('scj.test.a')::uuid) then raise exception 'B read A'; end if;
 perform public.pja_sync_commit(0,current_setting('scj.test.payload')::jsonb);
 if exists(select 1 from public.pja_learning_state where owner_id<>auth.uid()) then raise exception 'B cross-owner visibility'; end if;
end;$test$;
reset role;
set local role anon;
do $test$
declare blocked boolean:=false;
begin
 begin perform public.pja_sync_commit(0,current_setting('scj.test.payload')::jsonb);
 exception when insufficient_privilege then blocked:=true; end;
 if not blocked then raise exception 'anon commit accepted'; end if;
 blocked:=false;
 begin perform count(*) from public.pja_learning_state;
 exception when insufficient_privilege then blocked:=true; end;
 if not blocked then raise exception 'anon select accepted'; end if;
end;$test$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('scj.test.admin'),'role','authenticated')::text,true);
do $test$
begin
 if not private.is_pja_admin() then raise exception 'temporary admin not recognized'; end if;
 if (select count(*) from public.pja_learning_state where owner_id in(current_setting('scj.test.a')::uuid,current_setting('scj.test.b')::uuid))<>2 then raise exception 'admin cannot review fixtures'; end if;
end;$test$;
reset role;
do $test$
begin
 if has_function_privilege('anon','public.pja_sync_commit(bigint,jsonb)','EXECUTE') then raise exception 'anonymous RPC grant'; end if;
 if has_function_privilege('authenticated','private.pja_sync_payload_is_safe(jsonb)','EXECUTE') then raise exception 'helper grant'; end if;
 if not exists(select 1 from pg_class where oid='public.pja_learning_state'::regclass and relrowsecurity) then raise exception 'RLS missing'; end if;
 if (select count(*) from public.scj_learning_state)<>current_setting('pja.test.original_count')::bigint then raise exception 'original subject changed'; end if;
end;$test$;
rollback;
select 'PASS: PJA owner isolation, CAS, direct-write rejection, credentials, anon, admin; original subject untouched; all synthetic fixtures rolled back' as verification;
