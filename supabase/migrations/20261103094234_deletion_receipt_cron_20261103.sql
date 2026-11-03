-- Supabase production maintenance. Core privacy migration is tested separately on
-- disposable PostgreSQL/PGlite, which do not ship the pg_cron extension.
create extension if not exists pg_cron;
select cron.schedule('sf-purge-deletion-receipts','* * * * *',
 'select sf_private.purge_expired_deletion_receipts()');
-- Expiry is enforced on every request even if the scheduler is delayed/unavailable.
-- Physical cleanup runs each minute; backup retention is a separate unverified scope.
