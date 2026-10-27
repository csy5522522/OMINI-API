#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
backup_root="${BACKUP_DIRECTORY:-/opt/backups/omini-api}"
backup_dir="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$backup_dir"
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -u root --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF observatory' | gzip > "$backup_dir/database.sql.gz"
cp .env "$backup_dir/environment.env"
cp compose.yaml "$backup_dir/compose.yaml"
if [ -f deploy/compose.low-memory.yaml ]; then cp deploy/compose.low-memory.yaml "$backup_dir/compose.low-memory.yaml"; fi
if [ -f deploy/nginx.conf ]; then cp deploy/nginx.conf "$backup_dir/nginx.conf"; fi
git rev-parse HEAD > "$backup_dir/revision.txt"
gzip -t "$backup_dir/database.sql.gz"
printf 'Backup saved: %s\n' "$backup_dir"
