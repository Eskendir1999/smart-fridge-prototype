# Nutrition Stage2 — limited production integration, 3 November 2026

The supplied cumulative package was recovered from the Results panel of the existing nutrition chat. ZIP SHA256: `54c5f355620c37fc35a4739b45cc0dba3c144e705fd070824f2b613a071ff182`. Patch SHA256: `d89d105280d813e59f2cacbc711c15420e19ca2367548cf7bcb5f05904805f94`. Applying it once to `9a6583266712d8d2593a39d431a5291e3eb026d6` reproduced manifest tree `f2c572ef239bae6e2795bbd947683aff6e96ff17`. Stage1 was not applied separately.

Integration base is current main `f837035fe0370476d9b429f51bb050b530d7981e`. Stock RPC, receipt retries, editor baseline, manual shopping, write pause and backup migration are retained. Other chats' branches and PR5/6/7 are not merged or rewritten by this integration.

## Accepted release scope

- AI chat and weekly summaries have no provider/database execution path, even if old environment flags are set. Auth checks remain. Nutrition/profile navigation stays disabled in production; profiles and measurements are not loaded there.
- The cumulative package removes calorie/deficit/goal prescriptions, fasting and weight-scaled ingredient quantities. Exclusion and profile-context safeguards are integrated but remain behind the disabled nutrition gate.
- Native widget snapshots contain shared shopping only and explicitly clear personal fields. Updated Scriptable does not request login, read personal tables or fall back to the old measurement cache; it attempts to remove that cache when run. Physical-device updates and deletion of copies already on other devices are not proven.
- Telegram household status no longer reads a first family profile or measurements through service-role access. Shared fridge/cart status remains.
- Privacy/widget text describes the actual limited release and remaining database limitations.

## Production database gate: NOT ACCEPTED, no migration

`review/profile-privacy.sql` stays a review candidate. No profile SQL is placed in `supabase/migrations`; no legacy owner backfill or production personal-data deletion is performed.

Actual Supabase `vjpqvmwweaeewyosfjzl` has four legacy profiles, seventeen family measurements, six legacy account measurements and one AI summary. The owner column is absent. A rollback-only production test proved that synthetic B in the same family can read/update A's synthetic profile and read/delete its measurement. Another family and anon were denied. All synthetic rows were rolled back; existing personal rows were never mutated.

The schema has no custom public/auth triggers, no public views, no public tables in the Realtime publication and no pg_cron schema. Existing personal-table grants include unnecessary TRUNCATE/REFERENCES/TRIGGER permissions. Service-role access bypasses RLS; application output paths therefore require their own guards.

The SQL candidate passes local owner/same-family/foreign-family isolation, reassignment denial and confirmed deletion tests in PostgreSQL/PostgREST. It preserves legacy rows without inferring ownership. That is insufficient for production: a diagnostic proves authenticated anonymous profile creation is still allowed; AI archive export/delete is blocked even for its account owner. These are explicit blockers, not accepted behavior.

Before releasing personal-data access:

1. Supply a verified legacy-owner/support process without inferring ownership from created_by, family membership, name or last selected profile.
2. Complete owner-only export and confirmed deletion of profiles, measurements, legacy AI archive and derived data, with account and backup retention rules. Verify errors, zero-row responses and cross-user direct requests.
3. Prepare a migration against actual constraints/grants, reject anonymous Auth accounts and unintended reassignment/linkage, review privileged paths and recovery, then run managed Supabase HTTP/RLS acceptance before promotion.
4. Verify physical devices, old widget/cache/notification copies and their update behavior. A new web/script file does not erase already issued copies.
5. Keep AI off until consent, provider conditions, profile authorization, memory lifecycle and request cancellation are accepted separately.

The nutrition chat is independently preparing a later “My data” stage. It is not silently included here.

## Acceptance evidence

The integrated suite has 121 unit/SQL checks, five stock-browser groups and five privacy-browser groups. Privacy-browser tests enable the held-back UI only in the loopback fixture; production source/build keep nutrition disabled. Native HTTP acceptance uses disposable PostgreSQL 17.6/PostgREST 16.5, real SDK and signed local JWTs. Token issuance and `/auth/user` are fixtures, not managed Supabase Auth. The production schema and rollback-only diagnostic are separately inspected; no real-user login, pilot or broadcast is performed.

Production acceptance checks exact deployment/project/commit, disabled flags, public routes and auth rejection, no uncaught login-page errors and unchanged personal-data hashes. Existing stock backups and pause controls remain available. Recovery uses a verified compatible build, retaining the additive stock schema; no return to the old direct-write client.

Password protection is tracked separately in [backlog #8](https://github.com/Eskendir1999/smart-fridge-prototype/issues/8); Auth settings are unchanged.
