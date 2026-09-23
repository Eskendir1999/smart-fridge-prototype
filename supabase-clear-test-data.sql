-- Smart Fridge — очистка ВСЕХ тестовых данных перед новым заходом на тестирование.
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- Что делает: удаляет содержимое (холодильник/морозилка, корзина, журнал продуктов,
-- статистику, семейные профили и их замеры, чат с диетологом, push-токены) ВО ВСЕХ
-- домохозяйствах без исключения — включая applereview@myonlinefarm-smartfridge.app
-- (демо-аккаунт для ревью Apple). После запуска у applereview тоже будет пусто —
-- перед сдачей на ревью его нужно будет заново заполнить демо-данными.
--
-- Что НЕ трогает: сами аккаунты (auth.users), households/household_members (структура
-- домохозяйств и коды приглашений) — логин и связка "пользователь -> домохозяйство"
-- останутся рабочими, просто с пустым содержимым.

delete from public.cart_items;
delete from public.fridge_items;
delete from public.food_events;
delete from public.food_stats;
delete from public.family_measurements;
delete from public.family_profiles;
delete from public.dietitian_messages;
delete from public.dietitian_summaries;
delete from public.push_subscriptions;
delete from public.apns_tokens;
delete from public.measurement_logs; -- старая неиспользуемая таблица, на всякий случай тоже чистим
