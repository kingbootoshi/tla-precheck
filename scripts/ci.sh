#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-pr}"
if [[ "$MODE" != "pr" && "$MODE" != "nightly" ]]; then
  echo "usage: scripts/ci.sh <pr|nightly>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

find_free_local_port() {
  local port="$1"
  while lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    port="$((port + 1))"
  done
  printf '%s\n' "$port"
}

if [[ -x /opt/homebrew/opt/openjdk/bin/java ]]; then
  export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "DATABASE_URL is not set and docker is unavailable" >&2
    exit 1
  fi

  CONTAINER_NAME="tla-precheck-ci-local"
  LOCAL_POSTGRES_PORT="${LOCAL_POSTGRES_PORT:-55432}"
  LOCAL_POSTGRES_PORT="$(find_free_local_port "$LOCAL_POSTGRES_PORT")"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run \
    --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_DB=tla_precheck \
    -p "${LOCAL_POSTGRES_PORT}:5432" \
    -d postgres:17 >/dev/null
  trap 'docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true; docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true' EXIT

  until docker exec "$CONTAINER_NAME" pg_isready -U postgres -d tla_precheck >/dev/null 2>&1; do
    sleep 1
  done

  export DATABASE_URL="postgresql://postgres:postgres@localhost:${LOCAL_POSTGRES_PORT}/tla_precheck"
fi

bun run lint:all
bun run test
bun run build
bun run generate:db

bun -e '
  const db = new Bun.SQL(process.env.DATABASE_URL);
  await db.unsafe(`DROP TABLE IF EXISTS public.agent_runs CASCADE;`);
  await db.unsafe(`CREATE TABLE public.agent_runs (id BIGSERIAL PRIMARY KEY, owner TEXT, status TEXT NOT NULL);`);
  await db.close();
  const [{ default: machine }, { applyPostgresStorageContract }] = await Promise.all([
    import("./dist/examples/agentRuns.machine.js"),
    import("./dist/db/postgres.js")
  ]);
  await applyPostgresStorageContract(machine, process.env.DATABASE_URL);
'

bun run verify:db
bun run test:db

if [[ -z "${TLA2TOOLS_JAR:-}" ]]; then
  export TLA2TOOLS_VERSION="${TLA2TOOLS_VERSION:-v1.8.0}"
  export TLA2TOOLS_SHA256="${TLA2TOOLS_SHA256:-a89d5ef05d1abddab6acfda1dbace14e2e45e7960527ac186dd19c170a955080}"
  mkdir -p .cache/tla
  curl -L "https://github.com/tlaplus/tlaplus/releases/download/${TLA2TOOLS_VERSION}/tla2tools.jar" -o .cache/tla/tla2tools.jar
  echo "${TLA2TOOLS_SHA256}  .cache/tla/tla2tools.jar" | shasum -a 256 -c -
  export TLA2TOOLS_JAR="$ROOT_DIR/.cache/tla/tla2tools.jar"
fi

bun run agent-build

if [[ "$MODE" == "nightly" ]]; then
  bun run verify:all:full
  bun run test:fuzz:nightly
else
  bun run verify
  bun run test:fuzz:smoke
fi
