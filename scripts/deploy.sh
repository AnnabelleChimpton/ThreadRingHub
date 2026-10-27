#!/usr/bin/env bash
# Deploy the Ring Hub on the production server.
#
#   ./scripts/deploy.sh
#
# Stops at the first failing step. Builds the new image and runs database
# migrations with it BEFORE swapping the running container, so a failed build
# or migration leaves the live hub untouched. Prints the previous commit so
# you can roll back.
#
# Why --build -V: Dockerfile.dev runs `prisma generate` at image build time
# and node_modules lives in an anonymous volume. Without --build the Prisma
# client goes stale after a schema change; without -V (renew anonymous
# volumes) the old node_modules volume masks the fresh client. That stale
# client took down signature verification on 2026-10-17.
set -euo pipefail

cd "$(dirname "$0")/.."

SERVICE="${HUB_SERVICE:-hub-api}"
HEALTH_URL="${HUB_HEALTH_URL:-http://127.0.0.1:3000/health}"

step() { printf '\n==> %s\n' "$*"; }

PREV="$(git rev-parse --short HEAD)"
step "Deploying from $(pwd) (currently $PREV)"

step "Pulling origin/main"
git pull --ff-only origin main
NEW="$(git rev-parse --short HEAD)"
ROLLBACK="git reset --hard $PREV && docker compose up -d --build -V $SERVICE"
if [ "$NEW" = "$PREV" ]; then
  echo "Already up to date — continuing anyway (rebuild + restart)."
fi

step "Checking docker-compose.yml"
docker compose config -q

step "Building the $SERVICE image (with the newest node:24-slim, for Node security fixes)"
# --pull: without it Docker reuses whatever base image it pulled first, which
# left the hub on Node 24.6.0 from 2025-08 until 2026-10.
docker compose build --pull "$SERVICE"

step "Applying database migrations (with the new image, before the swap)"
docker compose run --rm --no-deps "$SERVICE" npx prisma migrate deploy

step "Replacing the running container"
docker compose up -d -V "$SERVICE"

step "Waiting for $HEALTH_URL"
ok=""
for _ in $(seq 1 45); do
  if curl -sf -o /dev/null "$HEALTH_URL"; then ok=1; break; fi
  sleep 2
done
if [ -z "$ok" ]; then
  echo "Hub did not become healthy within 90s. Recent logs:"
  docker compose logs --tail 40 "$SERVICE" || true
  echo
  echo "Roll back with:"
  echo "  $ROLLBACK"
  exit 1
fi
echo "Hub is up."

step "Done: $PREV -> $NEW"
echo "Roll back with:"
echo "  $ROLLBACK"
echo "(Database migrations are not undone by a rollback.)"
