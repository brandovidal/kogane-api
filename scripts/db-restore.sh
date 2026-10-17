#!/usr/bin/env bash
set -euo pipefail

env_file="$1"
file="${2:-}"

[ -n "$file" ] || { echo "Usage: make db-restore FILE=.data/backups/dev-<date>.db"; exit 1; }
[ -f "$file" ] || { echo "No existe $file"; exit 1; }
[ "$(sqlite3 -readonly "$file" 'pragma integrity_check' 2>/dev/null)" = "ok" ] || { echo "$file no es una base SQLite válida"; exit 1; }

db=$(grep -E '^DATABASE_URL=' "$env_file" | cut -d= -f2- | tr -d '"' | cut -d'?' -f1 | sed 's|^file:||')

if lsof -t "$db" 2>/dev/null | xargs -r ps -o comm= -p 2>/dev/null | grep -qi node; then
  echo "La API tiene abierta $db: detén make dev y vuelve a correr db-restore"; exit 1
fi
if lsof "$db" 2>/dev/null | grep -qi dbeaver; then
  echo "Aviso: DBeaver tiene abierta $db; desconéctalo y vuelve a conectar después de restaurar"
fi

if [ "${CONFIRM:-}" != "yes" ]; then
  printf "Se reemplazan TODOS los datos de %s con %s.\nEscribe dev para confirmar: " "$db" "$file"
  read -r answer
  [ "$answer" = "dev" ] || { echo "Cancelado: no se cambió nada."; exit 1; }
fi

if [ -f "$db" ]; then make --no-print-directory db-backup ENV=dev; fi
cp "$file" "$db"
rm -f "$db-journal" "$db-wal" "$db-shm"
echo "Restaurada $db desde $file"
