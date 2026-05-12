#!/usr/bin/env bash
# check-vendor-manifest.sh — CI gate for causl-org/vendor/.
#
# Reads causl-org/vendor/MANIFEST.json, recomputes the SHA-256 of every file
# listed in it, and fails (exit 1) if any actual SHA does not match the
# manifest entry. The error message tells the contributor how to refresh.
#
# Has no runtime dependency beyond bash + shasum + a JSON parser (jq if
# available, otherwise a constrained pure-bash parser).
#
# Usage:
#   scripts/check-vendor-manifest.sh
#
# Exit codes:
#   0  every vendored file matches its manifest SHA
#   1  at least one mismatch, or the manifest itself could not be parsed
#
# Issue #1264

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate inputs

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd)"
VENDOR_DIR="${REPO_ROOT}/causl-org/vendor"
MANIFEST_PATH="${VENDOR_DIR}/MANIFEST.json"

[[ -f "${MANIFEST_PATH}" ]] \
  || { printf 'check-vendor-manifest: manifest not found at %s\n' "${MANIFEST_PATH}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Helpers

# Compute lowercase hex SHA256 for a file.
sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# Map vendor package key -> directory on disk.
#   @causl/core     -> causl-org/vendor/@causl/core
#   @causl/devtools -> causl-org/vendor/@causl/devtools
#   @causl/formula  -> causl-org/vendor/@causl/formula
#   prismjs         -> causl-org/vendor/prismjs
dir_for_pkg() {
  case "$1" in
    "@causl/core"|"@causl/devtools"|"@causl/formula") printf '%s/%s' "${VENDOR_DIR}" "$1" ;;
    prismjs)                                          printf '%s/prismjs' "${VENDOR_DIR}" ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Manifest parser
#
# Output format (one record per line):
#   <pkg>\t<file>\t<expected_sha>
# Reads via jq if present, otherwise a constrained pure-bash JSON parser that
# handles the exact shape of MANIFEST.json (no nested objects beyond sha256,
# no escapes in keys, no unicode escapes).

parse_with_jq() {
  jq -r '
    to_entries[]
    | .key as $pkg
    | .value.sha256
    | to_entries[]
    | [$pkg, .key, .value]
    | @tsv
  ' "${MANIFEST_PATH}"
}

# Pure-bash fallback parser. Strategy:
#   1. Read MANIFEST.json into memory.
#   2. Walk top-level "<pkg>": { ... } blocks; for each, find the "sha256"
#      object and emit one record per "<file>": "<sha>" pair.
#
# Tradeoff: this is *not* a general JSON parser; it relies on the layout
# emitted by refresh-vendor.sh. If you hand-edit the manifest into a layout
# that breaks this parser, install jq instead — the script will pick it up
# automatically.
parse_pure_bash() {
  python3 - "${MANIFEST_PATH}" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
for pkg, entry in data.items():
    sha = entry.get("sha256") or {}
    for fname, expected in sha.items():
        print(f"{pkg}\t{fname}\t{expected}")
PY
}

if command -v jq >/dev/null 2>&1; then
  RECORDS="$(parse_with_jq)"
elif command -v python3 >/dev/null 2>&1; then
  RECORDS="$(parse_pure_bash)"
else
  printf 'check-vendor-manifest: need jq or python3 to parse %s\n' "${MANIFEST_PATH}" >&2
  exit 1
fi

[[ -n "${RECORDS}" ]] \
  || { printf 'check-vendor-manifest: manifest %s has no sha256 entries\n' "${MANIFEST_PATH}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Walk the manifest, compare each SHA

mismatches=0
missing=0
checked=0

while IFS=$'\t' read -r pkg file expected; do
  [[ -z "${pkg}" ]] && continue

  dir="$(dir_for_pkg "${pkg}")" || {
    printf 'check-vendor-manifest: manifest references unknown package %s\n' "${pkg}" >&2
    mismatches=$((mismatches + 1))
    continue
  }

  path="${dir}/${file}"
  if [[ ! -f "${path}" ]]; then
    printf '  MISSING  %s/%s\n' "${pkg}" "${file}" >&2
    missing=$((missing + 1))
    continue
  fi

  actual="$(sha256_of "${path}")"
  checked=$((checked + 1))

  if [[ "${actual}" != "${expected}" ]]; then
    printf '  MISMATCH %s/%s\n' "${pkg}" "${file}" >&2
    printf '           expected %s\n' "${expected}" >&2
    printf '           actual   %s\n' "${actual}"   >&2
    mismatches=$((mismatches + 1))
  fi
done <<< "${RECORDS}"

# ---------------------------------------------------------------------------
# Verdict

if [[ ${mismatches} -gt 0 || ${missing} -gt 0 ]]; then
  printf '\n' >&2
  printf 'check-vendor-manifest: FAILED — %d mismatched, %d missing, %d checked\n' \
    "${mismatches}" "${missing}" "${checked}" >&2
  printf '\n' >&2
  printf '  One or more vendor files have changed (or are absent) relative\n' >&2
  printf '  to causl-org/vendor/MANIFEST.json. Run\n' >&2
  printf '\n' >&2
  printf '      scripts/refresh-vendor.sh\n' >&2
  printf '\n' >&2
  printf '  to rebuild the vendored bundles and re-pin MANIFEST.json, then\n' >&2
  printf '  commit both the regenerated vendor files and the updated manifest.\n' >&2
  exit 1
fi

printf 'check-vendor-manifest: OK — %d files match MANIFEST.json\n' "${checked}"
