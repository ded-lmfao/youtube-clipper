#!/usr/bin/env bash

set -Eeuo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required but was not found. Install it from https://bun.sh/." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PID=""

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Stopping backend..."
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo "Starting backend..."
(
  cd "$ROOT_DIR/backend"
  exec bun --watch run src/index.ts
) &
BACKEND_PID=$!

echo "Waiting for backend at http://localhost:3001..."
for _ in {1..30}; do
  if curl --silent --fail http://localhost:3001/api/ping >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Backend stopped before it became ready." >&2
    exit 1
  fi

  sleep 1
done

if ! curl --silent --fail http://localhost:3001/api/ping >/dev/null 2>&1; then
  echo "Backend did not become ready within 30 seconds." >&2
  exit 1
fi

echo "Starting frontend..."
cd "$ROOT_DIR/frontend"
bun run dev
