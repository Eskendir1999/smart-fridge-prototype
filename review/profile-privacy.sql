-- REVIEW CANDIDATE ONLY. Not a deployment migration; never auto-run on production.
-- Release owner must inventory existing constraints/policies, backups and existing clients.
-- No legacy ownership inference from created_by, household membership, name or last selection.
begin;
alter table public.family_profiles add column if not exists profile_owner_user_id uuid references auth.users(id) on delete cascade;
alter table public.family_profiles alter column household_id drop not null;
alter table public.family_profiles drop constraint if exists family_profiles_household_id_fkey;
alter table public.family_profiles add constraint family_profiles_household_id_fkey foreign key (household_id) references public.households(id) on delete set null;
-- Creator attribution must not delete another person's confirmed profile.
alter table public.family_profiles alter column created_by drop not null;
alter table public.family_profiles drop constraint if exists family_profiles_created_by_fkey;
alter table public.family_profiles add constraint family_profiles_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.family_profiles enable row level security;
alter table public.family_measurements enable row level security;
revoke all on public.family_profiles, public.family_measurements from anon, authenticated;
grant select, insert, update, delete on public.family_profiles, public.family_measurements to authenticated;
-- Restrictive gates remain ANDed with any pre-existing permissive family policy.
create policy sf_private_profile_gate on public.family_profiles as restrictive for all to authenticated
 using (profile_owner_user_id = (select auth.uid()) and not coalesce((nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'is_anonymous')::boolean,false))
 with check (profile_owner_user_id = (select auth.uid()) and age >= 18 and not coalesce((nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'is_anonymous')::boolean,false));
create policy sf_private_profile_owner on public.family_profiles for all to authenticated
 using (profile_owner_user_id = (select auth.uid()) and not coalesce((nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'is_anonymous')::boolean,false))
 with check (profile_owner_user_id = (select auth.uid()) and age >= 18 and not coalesce((nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'is_anonymous')::boolean,false));
create policy sf_private_measurement_gate on public.family_measurements as restrictive for all to authenticated
 using (exists(select 1 from public.family_profiles p where p.id = profile_id and p.profile_owner_user_id = (select auth.uid())))
 with check (exists(select 1 from public.family_profiles p where p.id = profile_id and p.profile_owner_user_id = (select auth.uid())));
create policy sf_private_measurement_owner on public.family_measurements for all to authenticated
 using (exists(select 1 from public.family_profiles p where p.id = profile_id and p.profile_owner_user_id = (select auth.uid())))
 with check (exists(select 1 from public.family_profiles p where p.id = profile_id and p.profile_owner_user_id = (select auth.uid())));
create policy sf_private_profile_insert on public.family_profiles as restrictive for insert to authenticated
 with check (created_by = (select auth.uid()) and (household_id is null or public.is_household_member(household_id)));
-- Old account-wide conversations remain an isolated archive, no use by the live client.
-- Owner export/deletion of that archive is a release prerequisite, not supplied by this candidate.
alter table public.dietitian_messages enable row level security;
alter table public.dietitian_summaries enable row level security;
revoke all on public.dietitian_messages, public.dietitian_summaries from anon, authenticated;
create policy sf_ai_archive_messages on public.dietitian_messages as restrictive for all to authenticated using(false) with check(false);
create policy sf_ai_archive_summaries on public.dietitian_summaries as restrictive for all to authenticated using(false) with check(false);
commit;
