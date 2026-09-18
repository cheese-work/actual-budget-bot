#!/usr/bin/env bash
# congvc-c00 deploy — recreate the bot container on the pinned X99-built image.
# NOT a build host: this script never builds, it only recreates from a tag
# that already exists locally (docker load from X99).
set -euo pipefail

cd "$(dirname "$0")"

TAG="${1:?usage: deploy-c00.sh <image-tag>}"

if ! docker image inspect "actual-budget-bot:${TAG}" >/dev/null 2>&1; then
  echo "image actual-budget-bot:${TAG} not present on this host — load it from X99 first" >&2
  exit 1
fi

docker tag "actual-budget-bot:${TAG}" actual-budget-bot:deployed
docker compose up -d --no-build
