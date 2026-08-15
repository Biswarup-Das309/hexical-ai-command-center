#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${HEXICAL_ENV_FILE:-/mnt/c/Users/Biswa/Downloads/hexical-ai-command-center (2)/hexical-ai-command-center/.env.local}"

if [[ ! -r "$env_file" ]]; then
  echo "Missing worker environment file: $env_file" >&2
  exit 1
fi

cd "$repo_dir"
set -a
# The Windows checkout is CRLF-formatted; normalize it without copying
# secrets into the Linux checkout or the repository.
source <(tr -d '\r' < "$env_file")
set +a

: "${NEXT_PUBLIC_SUPABASE_URL:?Missing NEXT_PUBLIC_SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Missing SUPABASE_SERVICE_ROLE_KEY}"
: "${TTY_WORKER_AUTH_SECRET:?Missing TTY_WORKER_AUTH_SECRET}"

export TTY_EXECUTION_WORKER_ID="${TTY_EXECUTION_WORKER_ID:-hexical-wsl-1}"
export TTY_PERSISTENT_PTY_ENABLED="${TTY_PERSISTENT_PTY_ENABLED:-true}"
export TTY_RUNTIME_BACKEND="${TTY_RUNTIME_BACKEND:-tmux}"
export TTY_PTY_PATH="${TTY_PTY_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
export TTY_PTY_WORKSPACE_ROOT="${TTY_PTY_WORKSPACE_ROOT:-/opt/hexical-runtime-workspaces}"
export TTY_PTY_TELEMETRY_INTERVAL_MS="${TTY_PTY_TELEMETRY_INTERVAL_MS:-5000}"
export TTY_PTY_LEASE_TTL_MS="${TTY_PTY_LEASE_TTL_MS:-30000}"
export TTY_PTY_HEARTBEAT_INTERVAL_MS="${TTY_PTY_HEARTBEAT_INTERVAL_MS:-5000}"
export TTY_PTY_JOURNAL_POLL_INTERVAL_MS="${TTY_PTY_JOURNAL_POLL_INTERVAL_MS:-100}"
export TTY_WORKER_POLL_INTERVAL_MS="${TTY_WORKER_POLL_INTERVAL_MS:-1000}"
export TTY_WORKER_MAX_POLL_INTERVAL_MS="${TTY_WORKER_MAX_POLL_INTERVAL_MS:-15000}"
export TTY_PERSISTENT_RECOVERY_SCAN_INTERVAL_MS="${TTY_PERSISTENT_RECOVERY_SCAN_INTERVAL_MS:-5000}"

mkdir -p "$TTY_PTY_WORKSPACE_ROOT"
exec node --experimental-transform-types --import ./scripts/register-alias.mjs scripts/tty-worker.ts
