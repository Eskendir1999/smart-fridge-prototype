#!/usr/bin/env bash
# Restore rehearsal: load a backup into a disposable local database and compare row counts.
#
#   REHEARSAL_ADMIN_URL=postgresql://user:pw@127.0.0.1:5432/postgres scripts/restore-rehearsal.sh backups/smart-fridge-*.dump[.age]
#
# An .age file is decrypted with AGE_IDENTITY (path to the private key file). Only localhost targets are allowed.
set -euo pipefail
src="${1:?path to .dump or .dump.age}"
: "${REHEARSAL_ADMIN_URL:?Set REHEARSAL_ADMIN_URL to a local admin connection}"
host=$(python3 -c 'import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).hostname or "")' "$REHEARSAL_ADMIN_URL")
[[ "$host" == "127.0.0.1" || "$host" == "localhost" ]] || { echo "Refusing non-local target: $host" >&2; exit 2; }

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
dump="$src"
if [[ "$src" == *.age ]]; then
  : "${AGE_IDENTITY:?Set AGE_IDENTITY to the private key file to decrypt}"
  dump="$work/restore.dump"; age -d -i "$AGE_IDENTITY" -o "$dump" "$src"
fi
counts="${src%.age}.counts.tsv"
[[ -f "$counts" ]] || { echo "Missing $counts" >&2; exit 2; }

db="sf_restore_$(date -u +%Y%m%d%H%M%S)"
target=$(python3 -c 'import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p._replace(path="/"+sys.argv[2]).geturl())' "$REHEARSAL_ADMIN_URL" "$db")
psql "$REHEARSAL_ADMIN_URL" -qc "create database $db"
cleanup(){ [[ "${KEEP:-0}" == 1 ]] || psql "$REHEARSAL_ADMIN_URL" -qc "drop database if exists $db" >/dev/null; rm -rf "$work"; }
trap cleanup EXIT

# Supabase roles and schemas that restored policies and grants refer to.
psql "$target" -q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists extensions;
drop schema public cascade; -- recreated by the dump
SQL

started=$(date +%s)
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$target" "$dump"
took=$(( $(date +%s) - started ))

fail=0
while IFS=$'\t' read -r table expected; do
  case "$table" in
    meta:policies) sql="select count(*) from pg_policies where schemaname in ('public','sf_private')";;
    meta:functions) sql="select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','sf_private')";;
    *) sql="select count(*) from $table";;
  esac
  got=$(psql "$target" -Atqc "$sql")
  if [[ "$got" != "$expected" ]]; then echo "MISMATCH $table expected=$expected got=$got"; fail=1; fi
done < "$counts"
tables=$(wc -l < "$counts")
if [[ $fail -eq 0 ]]; then echo "RESTORE OK: $tables checks (rows, policies, functions) match, ${took}s"; else echo "RESTORE FAILED"; exit 1; fi
