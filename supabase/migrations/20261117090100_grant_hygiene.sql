begin;
set local lock_timeout='5s';
-- Supabase default grants left anon/authenticated with every table privilege (incl. TRUNCATE,
-- which RLS does not cover) on four early tables. RLS already blocked API misuse; this narrows
-- the grants to what the client actually uses. Server functions run as service_role and are unaffected.
-- Tables created outside the migration ledger are handled only when present.
do $$
declare t text;
begin
 foreach t in array array['households','household_members','household_join_attempts','push_subscriptions'] loop
  if to_regclass('public.'||t) is not null then
   execute format('revoke all on public.%I from anon, authenticated', t);
  end if;
 end loop;
 -- Reads only; families are created/joined through security-definer RPCs.
 if to_regclass('public.households') is not null then grant select on public.households to authenticated; end if;
 if to_regclass('public.household_members') is not null then grant select on public.household_members to authenticated; end if;
 -- Own push subscriptions (RLS: auth.uid() = user_id).
 if to_regclass('public.push_subscriptions') is not null then
  grant select, insert, update, delete on public.push_subscriptions to authenticated;
 end if;
end $$;
notify pgrst,'reload schema';
commit;
