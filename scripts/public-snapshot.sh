#!/usr/bin/env bash
# Writes a snapshot of <ref> (default dev) into a checkout of the public repository and commits it.
# The public repository gets one commit per release, never this repository's history.
#   scripts/public-snapshot.sh <public-checkout> [ref]
# It drops the AGENTS.md sections that grant access to the maintainer's machine and phone, then
# refuses to commit if the snapshot names this machine's tailnet, Tailscale IPs, tailnet device
# names or home folder. Without a working `tailscale` it publishes nothing.
# It does not push.
set -euo pipefail

dest=${1:?usage: scripts/public-snapshot.sh <public-checkout> [ref]}
ref=${2:-dev}
repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)

fail() { echo "$1; refusing to publish" >&2; exit 1; }
status=$(tailscale status --json) || fail "cannot read tailscale status"
ips=$(tailscale ip) || fail "cannot read tailscale ip"
suffix=$(sed -n 's/.*"MagicDNSSuffix": *"\([^"]*\)".*/\1/p' <<<"$status" | head -1)
[ -n "$suffix" ] || fail "tailscale status has no MagicDNSSuffix"
patterns=("$HOME" "${suffix%%.*}")
while read -r ip; do [ -n "$ip" ] && patterns+=("$ip"); done <<<"$ips"
# Device names on the tailnet (a phone called "S23 de Ana" is also "s23-de-ana"). Short ones like
# "arch" would match ordinary words, so only names of six characters or more are checked.
while read -r name; do
  [ "${#name}" -ge 6 ] && [ "$name" != localhost ] && patterns+=("$name")
done < <(grep -o '"\(HostName\|DNSName\)": *"[^"]*"' <<<"$status" | sed 's/.*: *"//; s/"$//; s/\..*//' | sort -u)

git -C "$dest" rev-parse --git-dir >/dev/null
[ -z "$(git -C "$dest" status --porcelain)" ] || { echo "public checkout has uncommitted changes: $dest" >&2; exit 1; }

git -C "$dest" ls-files -z | (cd "$dest" && xargs -0r rm -f)
git -C "$repo" archive "$ref" | tar -x -C "$dest"

awk '/^## /{skip = ($0 ~ /^## Production access/ || $0 ~ /^## Teléfono conectado/)} !skip' \
  "$dest/AGENTS.md" >"$dest/AGENTS.md.tmp"
mv "$dest/AGENTS.md.tmp" "$dest/AGENTS.md"

leaks=0
for p in "${patterns[@]}"; do
  if grep -rIlF -i --exclude-dir=.git -- "$p" "$dest"; then echo "snapshot names this machine or tailnet: $p" >&2; leaks=1; fi
done
[ "$leaks" = 0 ] || exit 1

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$dest/mobile/package.json" | head -1)
git -C "$dest" add -A
git -C "$dest" commit -q -m "Relay $version" -m "Snapshot of $(git -C "$repo" rev-parse --short "$ref")."
git -C "$dest" log --oneline -1
