#!/usr/bin/env bash
# refresh-vendor.sh — rebuild + re-pin every file in causl-org/vendor/.
#
# Run from the repo root after changing @causl/core, @causl/devtools, or
# @causl/formula sources, or after bumping the pinned Prism version.
# Regenerates causl-org/vendor/MANIFEST.json so the SHA-256 gate in
# scripts/check-vendor-manifest.sh stays green.
#
# Usage:
#   scripts/refresh-vendor.sh
#
# Exit codes:
#   0  manifest written successfully
#   1  build, download, or hash step failed
#
# Issue #1264

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration

PRISM_VERSION="1.30.0"
PRISM_BASE_URL="https://cdn.jsdelivr.net/npm/prismjs@${PRISM_VERSION}/components"
PRISM_FILES=(
  "prism-bash.min.js"
  "prism-clike.min.js"
  "prism-core.min.js"
  "prism-css.min.js"
  "prism-javascript.min.js"
  "prism-json.min.js"
  "prism-jsx.min.js"
  "prism-markup.min.js"
  "prism-rust.min.js"
  "prism-tsx.min.js"
  "prism-typescript.min.js"
)

CAUSL_PACKAGES=(core devtools formula)

# ---------------------------------------------------------------------------
# Helpers

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd)"
VENDOR_DIR="${REPO_ROOT}/causl-org/vendor"
MANIFEST_PATH="${VENDOR_DIR}/MANIFEST.json"

log() {
  printf '[refresh-vendor] %s\n' "$*" >&2
}

die() {
  printf '[refresh-vendor] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 \
    || die "required command '$1' not found in PATH"
}

# Compute lowercase hex SHA256 for a file. Uses shasum (BSD/macOS + GNU).
sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# Print a JSON-escaped string for an arbitrary input (handles \, ", control chars).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  # Tabs / CR / LF — defensive; should not occur in filenames/versions.
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# ---------------------------------------------------------------------------
# Pre-flight

require_cmd pnpm
require_cmd shasum
require_cmd curl
require_cmd git
require_cmd date

[[ -d "${REPO_ROOT}/causl-org/vendor" ]] \
  || die "expected causl-org/vendor at ${VENDOR_DIR}"

GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

log "repo root:  ${REPO_ROOT}"
log "vendor dir: ${VENDOR_DIR}"
log "git SHA:    ${GIT_SHA}"
log "timestamp:  ${GENERATED_AT}"

# ---------------------------------------------------------------------------
# 1. Build @causl/* packages

log "building @causl/core, @causl/devtools, @causl/formula ..."
(
  cd "${REPO_ROOT}"
  pnpm \
    --filter @causl/core \
    --filter @causl/devtools \
    --filter @causl/formula \
    run build
)

# ---------------------------------------------------------------------------
# 2. Copy each dist/ into causl-org/vendor/@causl/<pkg>/

for pkg in "${CAUSL_PACKAGES[@]}"; do
  src="${REPO_ROOT}/packages/${pkg}/dist"
  dst="${VENDOR_DIR}/@causl/${pkg}"

  [[ -d "${src}" ]] || die "missing build output: ${src}"

  log "copying ${src} -> ${dst}"
  rm -rf "${dst}"
  mkdir -p "${dst}"

  # Vendor only .js + .js.map. We do NOT ship .d.ts files — those are
  # consumed at the package boundary in the monorepo, not at the site
  # boundary in causl-org.
  find "${src}" -maxdepth 1 -type f \( -name '*.js' -o -name '*.js.map' \) -print0 \
    | xargs -0 -I{} cp {} "${dst}/"
done

# ---------------------------------------------------------------------------
# 3. Re-download Prism components

PRISM_DIR="${VENDOR_DIR}/prismjs"
mkdir -p "${PRISM_DIR}"

for f in "${PRISM_FILES[@]}"; do
  url="${PRISM_BASE_URL}/${f}"
  out="${PRISM_DIR}/${f}"
  log "fetching ${url}"
  curl -fsSL "${url}" -o "${out}"
done

# ---------------------------------------------------------------------------
# 4. Read @causl/<pkg> version from each package.json

read_pkg_version() {
  local pkg="$1"
  local pj="${REPO_ROOT}/packages/${pkg}/package.json"
  [[ -f "${pj}" ]] || die "missing package.json: ${pj}"
  # Cheap JSON read: grep the first "version": "..." occurrence.
  # Packages here never use nested "version" before the top-level one,
  # so this is sufficient and avoids a jq dependency.
  awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "${pj}"
}

CORE_VERSION="$(read_pkg_version core)"
DEVTOOLS_VERSION="$(read_pkg_version devtools)"
FORMULA_VERSION="$(read_pkg_version formula)"

[[ -n "${CORE_VERSION}" ]]     || die "could not read @causl/core version"
[[ -n "${DEVTOOLS_VERSION}" ]] || die "could not read @causl/devtools version"
[[ -n "${FORMULA_VERSION}" ]]  || die "could not read @causl/formula version"

# ---------------------------------------------------------------------------
# 5. Emit a per-package JSON object

emit_pkg_entry() {
  # $1: package key in JSON ("@causl/core", "prismjs", ...)
  # $2: version
  # $3: source string (filesystem path or URL)
  # $4: directory containing the vendored files (absolute)
  # The function emits a JSON object value (no trailing comma).
  local key="$1"
  local version="$2"
  local source="$3"
  local dir="$4"

  local files=()
  while IFS= read -r -d '' file; do
    files+=("$(basename "${file}")")
  done < <(find "${dir}" -maxdepth 1 -type f \
            ! -name 'README.md' \
            ! -name 'MANIFEST.json' \
            -print0 | sort -z)

  [[ ${#files[@]} -gt 0 ]] || die "no files found for ${key} in ${dir}"

  {
    printf '  "%s": {\n' "$(json_escape "${key}")"
    printf '    "version": "%s",\n' "$(json_escape "${version}")"
    printf '    "source": "%s",\n' "$(json_escape "${source}")"

    printf '    "files": [\n'
    local i
    for i in "${!files[@]}"; do
      local sep=","
      [[ $i -eq $((${#files[@]} - 1)) ]] && sep=""
      printf '      "%s"%s\n' "$(json_escape "${files[$i]}")" "${sep}"
    done
    printf '    ],\n'

    printf '    "sha256": {\n'
    for i in "${!files[@]}"; do
      local f="${files[$i]}"
      local hash
      hash="$(sha256_of "${dir}/${f}")"
      local sep=","
      [[ $i -eq $((${#files[@]} - 1)) ]] && sep=""
      printf '      "%s": "%s"%s\n' \
        "$(json_escape "${f}")" "$(json_escape "${hash}")" "${sep}"
    done
    printf '    },\n'

    printf '    "generatedAt": "%s",\n' "$(json_escape "${GENERATED_AT}")"
    printf '    "generatedFrom": "%s"\n'  "$(json_escape "${GIT_SHA}")"
    printf '  }'
  }
}

# ---------------------------------------------------------------------------
# 6. Compose the manifest

log "writing ${MANIFEST_PATH}"

{
  printf '{\n'
  emit_pkg_entry "@causl/core"     "${CORE_VERSION}"     "packages/core/dist/"     "${VENDOR_DIR}/@causl/core"
  printf ',\n'
  emit_pkg_entry "@causl/devtools" "${DEVTOOLS_VERSION}" "packages/devtools/dist/" "${VENDOR_DIR}/@causl/devtools"
  printf ',\n'
  emit_pkg_entry "@causl/formula"  "${FORMULA_VERSION}"  "packages/formula/dist/"  "${VENDOR_DIR}/@causl/formula"
  printf ',\n'
  emit_pkg_entry "prismjs"         "${PRISM_VERSION}"    "${PRISM_BASE_URL}/"      "${VENDOR_DIR}/prismjs"
  printf '\n}\n'
} > "${MANIFEST_PATH}"

log "done — re-run scripts/check-vendor-manifest.sh to confirm the gate passes"
