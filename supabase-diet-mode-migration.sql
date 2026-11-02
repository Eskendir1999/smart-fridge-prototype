-- Smart Fridge — миграция для режима питания «кормящая мама», исключений продуктов
-- и замен блюд в меню. Применяется к уже существующей family_profiles
-- (см. supabase-family-profiles-migration.sql), данные не удаляются.
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- Пока миграция не применена, приложение продолжает работать: режим питания и замены
-- блюд сохраняются только в localStorage устройства.

alter table public.family_profiles
  add column if not exists diet_mode text not null default 'standard',
  add column if not exists baby_age_months int,
  add column if not exists excluded_foods text[] not null default '{}',
  add column if not exists meal_choices jsonb not null default '{}'::jsonb;

-- Ограничения отдельными шагами, чтобы миграцию можно было запустить повторно.
alter table public.family_profiles drop constraint if exists family_profiles_diet_mode_check;
alter table public.family_profiles add constraint family_profiles_diet_mode_check
  check (diet_mode in ('standard','breastfeeding'));

alter table public.family_profiles drop constraint if exists family_profiles_baby_age_check;
alter table public.family_profiles add constraint family_profiles_baby_age_check
  check (baby_age_months is null or (baby_age_months >= 0 and baby_age_months <= 36));

alter table public.family_profiles drop constraint if exists family_profiles_excluded_foods_check;
alter table public.family_profiles add constraint family_profiles_excluded_foods_check
  check (excluded_foods <@ array['dairy','egg','fish','nuts','gluten']::text[]);

alter table public.family_profiles drop constraint if exists family_profiles_meal_choices_check;
alter table public.family_profiles add constraint family_profiles_meal_choices_check
  check (jsonb_typeof(meal_choices) = 'object' and pg_column_size(meal_choices) < 8192);

-- RLS не меняется: новые колонки покрыты существующей политикой
-- "household members manage family profiles".
