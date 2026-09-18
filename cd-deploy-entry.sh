#!/usr/bin/env bash
# congvc-c00 CD entrypoint — the ONLY command the CD deploy key may run.
#
# Installed as a forced command in ~/.ssh/authorized_keys, so the private key
# held in the repo's Actions secrets cannot open a shell, read files, forward
# ports, or touch anything on C00 except this one deploy path. The tag to
# deploy arrives in SSH_ORIGINAL_COMMAND; the image itself arrives gzipped on
# stdin, so no registry credential ever has to live on C00.
#
# C00 is not a build host (workspace topology: build on X99, deploy to C00).
# This script never builds — it only loads an image X99 already built.
set -euo pipefail

COMPOSE_DIR=/home/congvc/projects/oss/actual-budget-bot
LOCK=/tmp/actual-budget-bot-deploy.lock

# SSH_ORIGINAL_COMMAND must be exactly: deploy <tag>
read -r -a argv <<<"${SSH_ORIGINAL_COMMAND:-}"
if [ "${#argv[@]}" -ne 2 ] || [ "${argv[0]}" != "deploy" ]; then
  echo "refused: expected 'deploy <tag>', got '${SSH_ORIGINAL_COMMAND:-}'" >&2
  exit 64
fi

TAG="${argv[1]}"
# Tag is interpolated into docker commands: allow only a git-sha-ish token.
if ! printf '%s' "$TAG" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'; then
  echo "refused: tag '$TAG' is not a safe docker tag" >&2
  exit 64
fi

exec 9>"$LOCK"
if ! flock -w 300 9; then
  echo "refused: another deploy holds the lock" >&2
  exit 75
fi

echo "==> loading actual-budget-bot:${TAG} from stdin"
gunzip -c | docker load

if ! docker image inspect "actual-budget-bot:${TAG}" >/dev/null 2>&1; then
  echo "failed: actual-budget-bot:${TAG} absent after load" >&2
  exit 1
fi

PREVIOUS="$(docker inspect actual-budget-bot --format '{{.Image}}' 2>/dev/null || true)"
echo "==> previous image id: ${PREVIOUS:-none}"
TARGET="$(docker image inspect "actual-budget-bot:${TAG}" --format '{{.Id}}')"

cd "$COMPOSE_DIR"
docker tag "actual-budget-bot:${TAG}" actual-budget-bot:deployed
docker compose up -d --no-build

# Health must be judged against THIS container's own start time, not a
# wall-clock window: when the running container is already on the target
# image compose makes it a no-op, the container keeps its original start
# time, and a fixed `--since 2m` window sees no new bot_started and would
# roll a perfectly healthy deploy back.
started_at() { docker inspect actual-budget-bot --format '{{.State.StartedAt}}' 2>/dev/null || true; }

echo "==> waiting for bot_started"
for _ in $(seq 1 30); do
  since="$(started_at)"
  running_image="$(docker inspect actual-budget-bot --format '{{.Image}}' 2>/dev/null || true)"
  if [ "$running_image" = "$TARGET" ] && [ -n "$since" ] \
     && docker logs --since "$since" actual-budget-bot 2>&1 | grep -q '"event":"bot_started"'; then
    echo "==> healthy: bot_started observed on ${TAG}"
    docker ps --filter name=actual-budget-bot --format '{{.Names}} {{.Image}} {{.Status}}'
    exit 0
  fi
  sleep 2
done

echo "failed: bot_started not observed on ${TAG} within 60s — rolling back" >&2
docker logs --tail 40 actual-budget-bot >&2 2>&1 || true
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TARGET" ]; then
  docker tag "$PREVIOUS" actual-budget-bot:deployed
  docker compose up -d --no-build
  echo "rolled back to ${PREVIOUS}" >&2
else
  echo "no distinct previous image to roll back to" >&2
fi
exit 1
