#!/usr/bin/env bash
# make redis: the local Redis of the reminders (P20, D87) from docker-compose.yaml, on localhost:6379, kept with its data
# between runs in the redis-data volume. noeviction like production: BullMQ must never lose its keys.
set -euo pipefail

command -v docker >/dev/null || { echo "Docker is needed for the local Redis"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running: open Docker Desktop"; exit 1; }

docker compose --progress quiet up -d --wait redis
echo "Redis on redis://localhost:6379"
