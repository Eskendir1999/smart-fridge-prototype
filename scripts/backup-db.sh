#!/usr/bin/env bash
# Free-tier database backup for Smart Fridge (Supabase Free has no automatic backups).
#
#   SUPABASE_DB_URL=postgresql://...  BACKUP_AGE_RECIPIENT=age1...  scripts/backup-db.sh [out-dir]
#
# Dumps schemas public, sf_private and auth (data + schema) in pg_dump custom format, then encrypts it
# with age for BACKUP_AGE_RECIPIENT. Personal data never lands on disk unencrypted unless --plain is
# given explicitly (only for a local rehearsal against a disposable database).
# pg_dump must be the same major version as the server or newer.
set -euo pipefail

plain=0
if [[ "${1:-}" == "--plain" ]]; then plain=1; shift; fi
out_dir="${1:-backups}"
: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL (Supabase → Connect → Session pooler URI)}"

if [[ $plain -eq 0 ]]; then
  : "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT (public key from age-keygen) or pass --plain for a local rehearsal}"
  command -v age >/dev/null || { echo "age is not installed (apt install age / brew install age)" >&2; exit 2; }
fi

client_major=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
server_major=$(psql "$SUPABASE_DB_URL" -Atqc 'show server_version_num' | cut -c1-2)
if (( client_major < server_major )); then
  echo "pg_dump $client_major is older than server $server_major; install postgresql-client-$server_major" >&2
  exit 2
fi

mkdir -p "$out_dir"
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="$out_dir/smart-fridge-$stamp.dump"

pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges \
  --schema=public --schema=sf_private --schema=auth \
  --file="$dump"

# Row counts travel with the dump so a restore can be checked without opening the data.
psql "$SUPABASE_DB_URL" -Atq -F $'\t' -c "
  select n.nspname||'.'||c.relname,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p') and n.nspname in ('public','sf_private')
  union all select 'meta:policies', count(*) from pg_policies where schemaname in ('public','sf_private')
  union all select 'meta:functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','sf_private')
  order by 1" > "$dump.counts.tsv"

if [[ $plain -eq 0 ]]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$dump.age" "$dump"
  rm -f "$dump"
  dump="$dump.age"
fi

( cd "$out_dir" && sha256sum "$(basename "$dump")" "$(basename "${dump%.age}").counts.tsv" > "smart-fridge-$stamp.sha256" )
echo "$dump"
