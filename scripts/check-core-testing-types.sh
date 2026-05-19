#!/usr/bin/env bash
# check-core-testing-types.sh — regression gate for #31.
#
# Packs @causl/core, installs the produced tarball into a throwaway
# directory, writes a tiny consumer that imports from
# `@causl/core/testing`, and runs `tsc --noEmit` against it.
#
# Why this gate exists: prior to #31 the published `dist/testing.d.ts`
# was a single line — `export * from '@causl/core-testing-internal'` —
# referencing a workspace package that is `private: true` and not on
# npm. Inside the monorepo the specifier resolved (via pnpm's
# workspace link) and the typecheck was green, so the regression was
# invisible from inside causl-ts itself. It only surfaced in
# downstream consumers (causljs/causl-bench PR #36) as an
# implicit-any cascade.
#
# This script reproduces a downstream consumer: it installs the
# tarball into a clean directory under `/tmp/` so pnpm's workspace
# resolution cannot help, then asserts that `tsc --noEmit` on the
# consumer file is clean. If `dist/testing.d.ts` ever again contains
# an unresolved external specifier, this gate fires.
#
# Usage:
#   scripts/check-core-testing-types.sh
#
# Exit codes:
#   0  consumer typecheck is green against the produced tarball
#   1  pack/install/typecheck failed — regression caught
#
# Issue #31

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd)"
CORE_DIR="${REPO_ROOT}/packages/core"

if [[ ! -f "${CORE_DIR}/dist/testing.d.ts" ]]; then
  echo "check-core-testing-types: ${CORE_DIR}/dist/testing.d.ts missing — run 'pnpm --filter @causl/core build' first" >&2
  exit 1
fi

# Static grep first — cheap pre-check that the .d.ts does not
# contain a bare `from '@causl/core-testing-internal'` import
# (JSDoc-comment mentions in usage examples are fine — those
# match `*   import {...} from '@causl/...'` with leading
# whitespace and a comment marker).
if grep -E "^(import|export) .* from '@causl/core-testing-internal'" "${CORE_DIR}/dist/testing.d.ts" > /dev/null; then
  echo "check-core-testing-types: dist/testing.d.ts contains a bare import/export from '@causl/core-testing-internal' — #31 regression" >&2
  echo "Offending lines:" >&2
  grep -nE "^(import|export) .* from '@causl/core-testing-internal'" "${CORE_DIR}/dist/testing.d.ts" >&2
  exit 1
fi

# Full pack + install + typecheck. Slower; gives the definitive
# downstream-consumer signal.
TMPDIR_ROOT="$(mktemp -d -t causl-core-testing-types-XXXXXX)"
trap 'rm -rf "${TMPDIR_ROOT}"' EXIT

echo "check-core-testing-types: packing @causl/core into ${TMPDIR_ROOT}"
(cd "${CORE_DIR}" && pnpm pack --pack-destination "${TMPDIR_ROOT}" > /dev/null)

TARBALL="$(ls "${TMPDIR_ROOT}"/causl-core-*.tgz | head -1)"
if [[ ! -f "${TARBALL}" ]]; then
  echo "check-core-testing-types: pnpm pack produced no tarball" >&2
  exit 1
fi

CONSUMER_DIR="${TMPDIR_ROOT}/consumer"
mkdir -p "${CONSUMER_DIR}"

cat > "${CONSUMER_DIR}/package.json" <<EOF
{
  "name": "causl-core-testing-types-consumer",
  "private": true,
  "version": "0.0.0",
  "type": "module"
}
EOF

cat > "${CONSUMER_DIR}/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitAny": true,
    "skipLibCheck": false,
    "esModuleInterop": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "types": []
  },
  "include": ["consumer.ts"]
}
EOF

# Exercise the symbols causl-bench's PR #36 ambient-shim covers —
# these are the actual blast radius of the regression.
cat > "${CONSUMER_DIR}/consumer.ts" <<'EOF'
import {
  recomputeCounter,
  glitchDetector,
  assertConsistentGraphTime,
  assertResultStability,
  propertyTrials,
  propertyDag,
  disposedTombstoneSize,
  commitLogConsumerCount,
  derivedDeps,
} from '@causl/core/testing'

// Touch each symbol so unused-import elision doesn't hide a missing type.
const symbols = {
  recomputeCounter,
  glitchDetector,
  assertConsistentGraphTime,
  assertResultStability,
  propertyTrials,
  propertyDag,
  disposedTombstoneSize,
  commitLogConsumerCount,
  derivedDeps,
}
export default symbols
EOF

echo "check-core-testing-types: installing tarball into consumer dir"
(cd "${CONSUMER_DIR}" \
  && npm install --no-save --no-audit --no-fund --silent "${TARBALL}" typescript@^5.9.3 fast-check@^3.20.0 > /dev/null)

echo "check-core-testing-types: running tsc --noEmit against consumer.ts"
(cd "${CONSUMER_DIR}" && npx --no-install tsc --noEmit)

echo "check-core-testing-types: green ✓"
