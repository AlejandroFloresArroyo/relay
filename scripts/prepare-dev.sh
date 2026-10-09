#!/usr/bin/env bash
# Prepare an existing Linux checkout; all prerequisite checks precede either installation.
set -euo pipefail

help() {
  printf '%s\n' \
    'Uso: scripts/prepare-dev.sh [--check|--help]' \
    'Sin opciones: comprueba requisitos y ejecuta npm ci en bridge y mobile, en ese orden.' \
    '--check: solo comprueba requisitos, sin instalar paquetes ni crear archivos.' \
    'Requisitos: Linux con /proc, Node >=26 con SQLite, npm y Python 3 con fcntl/PyYAML.' \
    'No instala el sistema, Node, Python ni el SDK; no configura Hermes, Tailscale o servicios.' \
    'Después: scripts/gate.sh o, desde mobile, npm run demo. Guía: docs/development.md.'
}
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
mode=prepare
if (( $# > 1 )); then help >&2; exit 2; fi
case "${1:-}" in
  '') ;;
  --check) mode=check ;;
  --help|-h) help; exit 0 ;;
  *) help >&2; exit 2 ;;
esac
REPO_ROOT=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd -P)
for program in uname node npm python3; do
  command -v "$program" >/dev/null 2>&1 || fail "Falta $program en PATH; prepáralo antes de continuar."
done
[[ $(uname -s) == Linux ]] || fail 'Esta preparación requiere Linux; consulta la matriz de plataformas en docs/development.md.'
[[ -d /proc/self/fd ]] || fail 'Se necesita /proc/self/fd accesible para las pruebas del Puente.'
node_version=$(node --version 2>/dev/null) || fail 'No se pudo ejecutar Node.'
[[ $node_version =~ ^v([0-9]+)\.[0-9]+\.[0-9]+$ ]] && (( BASH_REMATCH[1] >= 26 )) || fail 'Se necesita Node 26 o superior; comprueba la versión activa en PATH.'
node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:", { limits: { length: 1024 } });
  try { if (process.platform !== "linux" || db.limits.length !== 1024) process.exitCode = 1; }
  finally { db.close(); }
' >/dev/null 2>&1 || fail 'Node necesita soporte SQLite y sus límites; usa una instalación compatible de Node 26 o superior.'
python3 -I -B -c 'import sys, os, fcntl, yaml; from yaml.tokens import AliasToken, AnchorToken; assert sys.version_info.major == 3; assert hasattr(os, "O_NOFOLLOW") and hasattr(fcntl, "flock")' >/dev/null 2>&1 || fail 'Se necesita Python 3 con fcntl y PyYAML accesibles con -I. Este comando no los instala.'
for package in bridge mobile; do
  for file in package.json package-lock.json; do
    [[ -r "$REPO_ROOT/$package/$file" && -s "$REPO_ROOT/$package/$file" ]] || fail "Falta un archivo legible y no vacío: $package/$file. Usa un checkout completo."
  done
done
if [[ $mode == check ]]; then
  printf 'Requisitos correctos. No se instalaron paquetes ni se crearon archivos.\n'
  exit 0
fi
for package in bridge mobile; do
  printf 'Preparando %s: npm ci\n' "$package"
  if ! (cd -- "$REPO_ROOT/$package" && npm ci); then
    fail "Falló npm ci en $package; se detuvo la preparación. Revisa su salida y vuelve a ejecutar el comando."
  fi
done
printf 'Checkout preparado. Ejecuta scripts/gate.sh o abre la demo con (cd mobile && npm run demo).\n'
