#!/usr/bin/env bash
# Tear down this worktree's development environment (`make down`): containers,
# volumes, network, image, .env.worktree and port slot. Idempotent: on an
# already clean worktree it does nothing and succeeds.
# shellcheck disable=SC2086  # docker ids are whitespace-separated words on purpose
set -euo pipefail

die() { echo "dev_clean: $*" >&2; exit 1; }

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout"
cd "$root"
project=$("$here/dev_env.sh" project)

if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  die "Docker is not reachable; start it and re-run (slot and .env.worktree kept)"
fi

# Placeholder values only satisfy the compose file's required variables.
POCKETMARK_DEV_PORT=0 POCKETMARK_DEV_IMAGE="$project:dev" \
  docker compose -p "$project" -f compose.dev.yaml down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true

# Sweep anything left under the project label (stack started from another path, partial failures).
label="label=com.docker.compose.project=$project"
containers=$(docker ps -aq --filter "$label")
[ -z "$containers" ] || docker rm -f -v $containers >/dev/null
volumes=$(docker volume ls -q --filter "$label")
[ -z "$volumes" ] || docker volume rm -f $volumes >/dev/null
networks=$(docker network ls -q --filter "$label")
[ -z "$networks" ] || docker network rm $networks >/dev/null
docker image rm -f "$project:dev" >/dev/null 2>&1 || true

rm -f "$root/.env.worktree" "$root/.env.worktree.tmp"
"$here/dev_env.sh" release
echo "dev_clean: $project removed"
