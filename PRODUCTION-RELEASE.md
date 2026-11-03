# Stock v1 production release — 3 November 2026

Target: Vercel team `team_ugOqWnS2XOBcjyq0ujVHuj2O`, project `prj_Sm54dYkCaQ5g9SuOZLZo1dpH0YPZ`, production domain `smart-fridge-prototype.vercel.app`. Database: Supabase `vjpqvmwweaeewyosfjzl`, PostgreSQL 17.6. Only PR3/4 are in scope; PR5 is excluded.

Previous production: `dpl_GKU5sYp699GQPPvfDAfZrdKo7TDy`, source `cbcb6f61c2bc62ee73c23af14e18a41651ddf367`. The project is not Git-linked; merging does not publish it. CLI deployment is staged with production environment and `--skip-domain`, inspected, then explicitly promoted.

Release safeguards:

- Nutrition recommendations are hidden and navigation is blocked. AI API, weekly processing and broadcast notifications are off by default. Cron configuration is empty. No live AI calls, email or broadcasts form part of acceptance.
- Migration is additive and atomic. It takes a bounded table lock, captures fridge/cart/events/stats inside protected `sf_private.stock_release_backup`, adds receipt/control tables and the stock RPC, and then revokes direct stock-table INSERT/UPDATE/DELETE from anon/authenticated.
- Old open clients must reload. Reads remain available; old separate writes fail rather than bypassing transactions. The new service-worker cache name and no-cache headers deliver the current client on refresh. No forced navigation discards unsaved input.
- A controlled pause is available via `supabase/stock-release-pause.sql`. It disables new stock RPC writes without removing user data, receipts or backups. Resume uses the commented UPDATE only after investigation.
- Do not roll traffic back to the old insecure client or restore direct-write grants as a shortcut. For a release fault: pause writes, keep the additive schema/backup, correct the client and redeploy/promote a verified compatible build. Existing personal records are never reset for testing.
- Before promotion, validate the exact commit, READY state, production target, project/team, disabled release features, configured Supabase hostname, anonymous/forged-token rejection, and database schema/permissions. Verify again after promotion.
- Database acceptance uses synthetic UUIDs in a transaction that rolls back. It sends no mail, creates no persistent test account and never edits an existing person's rows. Counts and hashes prove existing stock data is preserved.

Schema and deployment snapshots, final SHAs, migration result, checks and URLs are recorded in the task's production results folder. The old deployment is retained for inspection, not as a safe write-compatible rollback target.
