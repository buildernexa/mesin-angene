#!/usr/bin/env bash
# Stream a long-running worker command through one rolling Release asset.
# The dashboard tracks line ranges; the Actions job log remains the full fallback.
set -Eeuo pipefail

BUILD_ID="${1:?build id required}"
PREFIX="${2:?chunk prefix required}"
shift 2
[[ "$BUILD_ID" =~ ^[A-Za-z0-9_-]{4,64}$ ]] || { echo "Invalid build id" >&2; exit 2; }
[[ "$PREFIX" =~ ^[a-z][a-z0-9_-]{1,16}$ ]] || { echo "Invalid stream prefix" >&2; exit 2; }
[[ $# -gt 0 ]] || { echo "Command required" >&2; exit 2; }
: "${GH_REPO:?GH_REPO is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

LOG_FILE="${RUNNER_TEMP:-/tmp}/nexabuild-${BUILD_ID}-${PREFIX}.log"
CHUNK_DIR="${RUNNER_TEMP:-/tmp}/nexabuild-${BUILD_ID}-${PREFIX}-chunks"
mkdir -p "$CHUNK_DIR"
: > "$LOG_FILE"
LAST_LINE=0

publish_chunk() {
  local current start slice asset_name
  current=$(wc -l < "$LOG_FILE")
  (( current > LAST_LINE )) || return 0
  start=$(( current > 500 ? current - 499 : 1 ))
  slice="$CHUNK_DIR/${PREFIX}-live.txt"
  asset_name="${PREFIX}-live.txt"
  {
    printf '#NEXA-STREAM start=%s end=%s\n' "$start" "$current"
    tail -n 500 "$LOG_FILE"
  } > "$slice"
  if gh release upload "build-$BUILD_ID" "$slice#$asset_name" --clobber --repo "$GH_REPO" >/dev/null 2>&1; then
    LAST_LINE="$current"
  else
    printf '[stream] could not publish %s live log; will retry\n' "$PREFIX" >&2
  fi
}

printf '[%s] Memulai: ' "$PREFIX" | tee -a "$LOG_FILE"
printf '%q ' "$@" | tee -a "$LOG_FILE"
printf '\n' | tee -a "$LOG_FILE"

"$@" 2>&1 | tee -a "$LOG_FILE" &
COMMAND_PID=$!
while kill -0 "$COMMAND_PID" 2>/dev/null; do
  sleep 6
  if kill -0 "$COMMAND_PID" 2>/dev/null; then publish_chunk; fi
done
STATUS=0
wait "$COMMAND_PID" || STATUS=$?
printf '[%s] Selesai dengan kode keluar %s\n' "$PREFIX" "$STATUS" | tee -a "$LOG_FILE"
publish_chunk
exit "$STATUS"
