#!/bin/bash
# Main process of a real test environment. It leaves work that escapes a session or a process group,
# which only the cgroup still holds, and optionally work that leaves the cgroup through systemd.
# It runs in the folder the test chose, and writes there.
out=$PWD
echo $$ > "$out/main"
nohup sleep 300 >/dev/null 2>&1 < /dev/null &
echo $! > "$out/nohup"
setsid sleep 300 >/dev/null 2>&1 < /dev/null &
echo $! > "$out/setsid"
( sleep 300 >/dev/null 2>&1 < /dev/null & echo $! > "$out/double" ) &
wait $!
# Ignores SIGHUP and SIGTERM: only cgroup.kill ends it.
bash -c 'trap "" HUP TERM; while :; do sleep 0.2; done' >/dev/null 2>&1 < /dev/null &
echo $! > "$out/stubborn"
# Ignores SIGHUP and leaves cleanly on SIGTERM, recording that it got it before any cgroup.kill.
bash -c 'trap "" HUP; trap "touch \"$0/term\"; exit 0" TERM; while :; do sleep 0.2; done' "$out" >/dev/null 2>&1 < /dev/null &
echo $! > "$out/polite"
if [ -f "$out/escape" ]; then
  systemd-run --user --quiet --collect --unit="$(cat "$out/escape")" sleep 300
fi
touch "$out/ready"
exec sleep 300
