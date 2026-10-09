#!/usr/bin/env bash
# The whole gate, one line per step. Exits 1 if any step fails and prints that step's output.
#
#   scripts/gate.sh            everything
#   scripts/gate.sh bridge     only the bridge steps
#   scripts/gate.sh mobile     only the app steps
#   scripts/gate.sh supervisor only the supervisor steps
set -u
# Give each background check its own process group so cancellation includes descendants.
set -m
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export EXPO_NO_TELEMETRY=1
# The share policy test compiles Java; mise installs a JDK without a global default here.
if [ -z "${JAVA_HOME:-}" ] && java_home=$(mise where java@temurin-17 2>/dev/null); then export JAVA_HOME=$java_home; fi
only=${1:-all}
failed=0
report_dir=$(mktemp -d)
export_dir=
pids=()
reports=()
trap 'rm -rf "$report_dir"; [ -z "$export_dir" ] || rm -rf "$export_dir"' EXIT

cancel() {
  local status=$1
  trap '' INT TERM
  # Bash already tracks a spawned group even before start_step records its PID.
  local groups=( $(jobs -p) )
  for pid in "${groups[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
  for pid in "${groups[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  exit "$status"
}
trap 'cancel 130' INT
trap 'cancel 143' TERM

step() {
  local name=$1 dir=$2; shift 2
  local out rc started=$SECONDS
  out=$(cd "$ROOT/$dir" && "$@" 2>&1); rc=$?
  local counts
  counts=$(printf '%s\n' "$out" | grep -E '^ℹ (tests|pass|fail) ' | tr '\n' ' ')
  if [ $rc -eq 0 ]; then
    printf 'PASS  %-18s %3ss  %s\n' "$name" "$((SECONDS - started))" "$counts"
  else
    printf 'FAIL  %-18s %3ss  %s\n' "$name" "$((SECONDS - started))" "$counts"
    printf '%s\n' "$out" | tail -60
    failed=1
  fi
  return "$rc"
}

# Isolated tests, type checks, lint and export have no dependency on one another.
# Capture reports separately and print in the documented order after collecting every status.
start_step() {
  local report="$report_dir/${#pids[@]}"
  step "$@" >"$report" &
  pids+=("$!")
  reports+=("$report")
}

need() {
  [ -d "$ROOT/$1/node_modules" ] && return 0
  printf 'FAIL  %-18s        run "npm ci" in %s first (supervisor: "npm run setup")\n' "$1" "$1"
  failed=1
  return 1
}

if [ "$only" = all ] || [ "$only" = bridge ]; then
  if need bridge; then
    start_step bridge:test bridge npm test
    start_step bridge:typecheck bridge npm run typecheck
  fi
fi

if [ "$only" = all ] || [ "$only" = supervisor ]; then
  if need supervisor; then
    # Its real-process tests skip with the reason where there is no systemd user manager.
    start_step supervisor:test supervisor npm test
    start_step supervisor:typecheck supervisor npm run typecheck
  fi
fi

if [ "$only" = all ] || [ "$only" = mobile ]; then
  if need mobile; then
    # Expo writes this ignored file on `expo start`; a fresh worktree lacks it and tsc fails on CSS imports.
    [ -f "$ROOT/mobile/expo-env.d.ts" ] ||
      printf '/// <reference types="expo/types" />\n\n// NOTE: This file should not be edited and should be in your git ignore\n' >"$ROOT/mobile/expo-env.d.ts"
    start_step mobile:test mobile npm test
    start_step mobile:components mobile npm run test:components
    start_step mobile:typecheck mobile npm run typecheck
    start_step mobile:lint mobile npm run lint
    export_dir=$(mktemp -d)
    start_step mobile:web-export mobile npx expo export --platform web --output-dir "$export_dir"
  fi
fi

for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || failed=1
  cat "${reports[$i]}"
done

exit $failed
