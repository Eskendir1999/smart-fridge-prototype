# Бэкап и восстановление (бесплатно, тариф Supabase Free)

У Supabase Free нет автоматических бэкапов. Вместо них — еженедельная зашифрованная выгрузка.

## Один раз настроить (владелец)
1. На своём компьютере: `age-keygen -o smart-fridge-backup.key`. Файл с ключом храните офлайн (менеджер паролей, флешка). Строку `Public key: age1…` скопируйте.
2. GitHub → репозиторий → Settings → Secrets and variables → Actions:
   - `SUPABASE_DB_URL` — Supabase → Connect → Session pooler (URI с паролем базы);
   - `BACKUP_AGE_RECIPIENT` — строка `age1…`.
3. Actions → «Weekly encrypted DB backup» → Run workflow. Дальше запускается сам по понедельникам в 02:17 (Алматы), хранит 90 дней.

Пока секретов нет, задача просто пропускается.

## Что попадает в бэкап
Схемы `public`, `sf_private`, `auth` (custom-формат pg_dump), зашифровано age. Рядом — `.counts.tsv` (только количество строк, политик и функций, без данных) и `.sha256`.

## Репетиция восстановления (раз в месяц, 5 минут)
```bash
# скачать артефакт из Actions, распаковать
sha256sum -c smart-fridge-*.sha256
AGE_IDENTITY=smart-fridge-backup.key \
REHEARSAL_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
  scripts/restore-rehearsal.sh smart-fridge-*.dump.age
# ожидается: RESTORE OK: N checks (rows, policies, functions) match
```
Скрипт работает только с локальной базой, создаёт временную БД и удаляет её (оставить: `KEEP=1`).

## Ручной бэкап сейчас
```bash
SUPABASE_DB_URL=… BACKUP_AGE_RECIPIENT=age1… scripts/backup-db.sh backups
```
Нужен `pg_dump` той же major-версии, что сервер, или новее.

## Проверено
17.11.2026: выгрузка → шифрование → проверка sha256 → восстановление в чистый Postgres 16 → совпали строки всех таблиц, политики и функции (на тестовой базе со всеми миграциями). На реальной базе Supabase первый прогон — после добавления секретов.
