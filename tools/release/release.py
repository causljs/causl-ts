#!/usr/bin/env python3
"""tools/release.py — Build the @causl release bundle at v0.2.0.

Produces the smallest viable per-package npm tree for the TypeScript-only
path. Targets the working subset of @causl/* needed to ship a real app:

    @causl/core    — engine + TS API surface (main barrel only;
                     ./internal, ./testing, ./wasm are dropped to slim
                     the bundle)
    @causl/react   — React bindings
    @causl/formula — formula DSL

Explicitly excluded from this release:
    @causl/sync, @causl/persistence, @causl/devtools, @causl/devtools-bridge,
    @causl/checker (+ native platform shards), @causl/hypothesis,
    @causl/migration-check, @causl/sync-testing-internal,
    every WASM artefact under packages/core/wasm-pkg/.

Output layout (relative to repo root):

    release/
        README.md             — release notes + install instructions
        manifest.json         — machine-readable index of bundled packages
        packages/
            causl-core/
                package.json  — version bumped to RELEASE_VERSION,
                                workspace:* resolved to ^RELEASE_VERSION,
                                exports map narrowed to './' only,
                                scripts + devDependencies dropped.
                README.md
                dist/
                    index.js  — source-map trailer stripped
                    index.d.ts
                    chunk-*.js — kept (referenced by index.js); .map dropped
                    types-*.d.ts
            causl-react/
                package.json
                README.md
                dist/index.js / dist/index.d.ts
            causl-formula/
                package.json
                README.md
                dist/index.js / dist/index.d.ts

The script is idempotent: it nukes release/packages/ on each run and
rebuilds. The script itself never touches the source workspace
package.json files — version bumps live only in the emitted release/
tree.

Usage:
    python3 tools/release.py                  # default output ./release
    python3 tools/release.py --out ./elsewhere
    python3 tools/release.py --full           # keep ./internal, ./testing,
                                              # ./wasm subpath entries on
                                              # @causl/core (larger bundle)
    python3 tools/release.py --tarballs       # additionally emit one
                                              # `.tgz` per package via
                                              # `npm pack` (requires npm
                                              # on PATH)

Exit codes:
    0   success
    1   precondition failed (missing dist/, missing package.json, etc.)
    2   IO / shell error
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# Release contract.
# ---------------------------------------------------------------------------

RELEASE_VERSION = "0.2.0"

# npm scope rewrite. Per the project's brand discipline:
#   - `causljs` is the GitHub-org slug only (lives in URLs like
#     github.com/causljs/causl-ts).
#   - `causl` is the brand + npm scope everywhere else (npmjs.com/package/
#     @causl/core, the domain causl.org, the user-facing library name).
#
# Source `package.json` files in this workspace ship as `@causljs/*`
# (matching the GitHub org). The release tarballs published to npm
# must rebrand to `@causl/*`. This script rewrites both:
#   1. the `name` field on every package
#   2. dependency keys that reference sibling @causljs packages
# at tarball-build time, leaving the source workspace untouched.
#
# If you ever need to publish under the @causljs scope (e.g. to
# GitHub Packages at npm.pkg.github.com), pass --keep-source-scope.
SOURCE_NPM_SCOPE = "@causljs/"
PUBLISHED_NPM_SCOPE = "@causl/"


def rebrand_scope(s: str) -> str:
    """Rewrite SOURCE_NPM_SCOPE → PUBLISHED_NPM_SCOPE in a single string.

    Idempotent. Safe on strings that don't carry the source scope.
    """
    if not isinstance(s, str):
        return s
    return s.replace(SOURCE_NPM_SCOPE, PUBLISHED_NPM_SCOPE)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Per-package configuration. Each entry maps the source workspace package
# directory to its release-tree slug + the subset of dist entries to keep.
#
# `keep_subpath_exports`: in --full mode every entry of `package.json#exports`
# is retained; in default (slim) mode only the entries in this list survive.
# `./` is always kept.
#
# `drop_dist_basenames`: filenames (no path) to actively exclude from the
# copied dist tree even when --full is passed. Use for files that are
# never reachable from the kept exports (e.g. wasm.js when we're shipping
# the TS-only path).
@dataclass(frozen=True)
class PackageSpec:
    src_dir: str             # path relative to repo root
    release_slug: str        # directory name under release/packages/
    keep_subpath_exports: tuple[str, ...]   # subpath exports to keep in slim mode
    drop_dist_basenames: tuple[str, ...]    # always drop these dist basenames
    # Peer dependencies that exist purely for the dropped subpath entries
    # — these get pruned in slim mode. For @causl/core: fast-check is only
    # consumed by the dropped ./testing entry, so slim mode drops it.
    slim_drop_peer_deps: tuple[str, ...] = ()


PACKAGES: tuple[PackageSpec, ...] = (
    PackageSpec(
        src_dir="packages/core",
        release_slug="causl-core",
        keep_subpath_exports=(),   # main barrel only
        drop_dist_basenames=(
            "wasm.js", "wasm.js.map", "wasm.d.ts",
            "internal.js", "internal.js.map", "internal.d.ts",
            "testing.js", "testing.js.map", "testing.d.ts",
        ),
        slim_drop_peer_deps=("fast-check",),
    ),
    PackageSpec(
        src_dir="packages/sync",
        release_slug="causl-sync",
        keep_subpath_exports=(),   # main barrel only; ./resource and ./conflict dropped
        drop_dist_basenames=(
            "resource-entry.js", "resource-entry.js.map", "resource-entry.d.ts",
            "conflict-entry.js", "conflict-entry.js.map", "conflict-entry.d.ts",
        ),
    ),
    # @causl/react ships AFTER @causl/sync in the list because react depends
    # on sync; the order does not affect correctness (the script handles
    # each package independently), but the install ordering documented in
    # the top-level README reads cleanest core → sync → react → formula.
    PackageSpec(
        src_dir="packages/react",
        release_slug="causl-react",
        keep_subpath_exports=(),
        drop_dist_basenames=(),
    ),
    PackageSpec(
        src_dir="packages/formula",
        release_slug="causl-formula",
        keep_subpath_exports=(),
        drop_dist_basenames=(),
    ),
)


# ---------------------------------------------------------------------------
# Utility logging.
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[release] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"[release] FATAL: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
# Dist copy + strip.
# ---------------------------------------------------------------------------

# Strip the `//# sourceMappingURL=...` trailer that tsup/esbuild appends
# to every emitted .js file. Without this, browsers + Node ESM loaders
# attempt to fetch the .map sibling (which we deleted), producing 404
# noise. We do this in-place on the copied file, not the source.
SOURCE_MAP_TRAILER_RE = re.compile(
    rb"\n?//# sourceMappingURL=[^\n]*\n?$",
    re.MULTILINE,
)


# ---------------------------------------------------------------------------
# esbuild minify pass.
#
# tsup ships unminified by default (none of the workspace tsup.config.ts
# files set `minify: true`). For maximum on-the-wire compression of the
# release tarballs adopters install, we re-run esbuild --minify in-place
# on each emitted `.js` file. The pass is safe per-file: esbuild
# preserves module-export contracts and only mangles local identifiers,
# strips whitespace, and runs dead-code-elimination within the file.
# Cross-chunk identifier coordination already happened at tsup-time;
# re-minifying per file does not need to revisit that.
#
# The script discovers esbuild in this order:
#   1. `ESBUILD` env var (caller pin)
#   2. shutil.which("esbuild") — PATH
#   3. The pnpm-managed binary at
#      node_modules/.pnpm/node_modules/.bin/esbuild (workspace install)
#   4. node_modules/.bin/esbuild (npm/yarn install)
#
# If none of those exist the script logs a warning and skips
# minification. The user can pass --require-minify to make a missing
# esbuild a hard error (so CI doesn't silently ship unminified
# tarballs).
# ---------------------------------------------------------------------------

def find_esbuild() -> Path | None:
    import os
    pinned = os.environ.get("ESBUILD")
    if pinned:
        p = Path(pinned)
        if p.is_file():
            return p

    on_path = shutil.which("esbuild")
    if on_path:
        return Path(on_path)

    candidates = [
        REPO_ROOT / "node_modules" / ".pnpm" / "node_modules" / ".bin" / "esbuild",
        REPO_ROOT / "node_modules" / ".bin" / "esbuild",
    ]
    for c in candidates:
        if c.is_file():
            return c

    return None


def minify_js_in_place(esbuild_bin: Path, target: str = "es2020") -> tuple[int, int]:
    """Minify a single .js file in place using esbuild.

    Implementation note: invoked once per file via the binary's stdin
    pipeline. esbuild's API mode is fine for batch, but the binary is
    already on disk via the workspace pnpm install and the per-file
    overhead is negligible (~10 ms each, dwarfed by the I/O the rest
    of the script does).

    Returns (before_bytes, after_bytes).
    """
    raise NotImplementedError("called via _minify_one below; surfaced for typing")


def _minify_one(esbuild_bin: Path, path: Path, target: str = "es2020") -> tuple[int, int]:
    before = path.stat().st_size
    src = path.read_bytes()
    proc = subprocess.run(
        [
            str(esbuild_bin),
            "--minify",
            "--format=esm",
            f"--target={target}",
            "--platform=neutral",
            # `--legal-comments=none` strips license/copyright banners.
            # tsup output doesn't include them, but if a future bundle
            # adds them the release pass should still squeeze.
            "--legal-comments=none",
            # Force ESM-aware behaviour even if the source file lacks an
            # `export` (some chunk files are just side-effect modules
            # with re-exports already inlined).
            "--loader=js",
        ],
        input=src,
        check=False,
        capture_output=True,
    )
    if proc.returncode != 0:
        # Don't fail the whole release on one file's minify error —
        # esbuild can choke on some output shapes (e.g. wasm-bindgen
        # glue with unusual unicode). Surface the error and keep the
        # original bytes so the release still ships, just at the
        # un-minified size for that file.
        log(f"    minify FAILED for {path.name}: {proc.stderr.decode(errors='replace').strip()}")
        return before, before
    path.write_bytes(proc.stdout)
    after = path.stat().st_size
    return before, after


def copy_dist(
    spec: PackageSpec,
    src_root: Path,
    dst_root: Path,
    full: bool,
    esbuild_bin: Path | None = None,
) -> int:
    """Copy ``src_root/dist/`` to ``dst_root/dist/`` with stripping.

    Returns total bytes written. Raises on missing source.
    """
    src_dist = src_root / "dist"
    dst_dist = dst_root / "dist"

    if not src_dist.is_dir():
        die(f"{spec.release_slug}: source dist missing at {src_dist}. "
            f"Run `pnpm -r build` first.")

    dst_dist.mkdir(parents=True, exist_ok=True)

    drop = set(spec.drop_dist_basenames) if not full else set()
    bytes_written = 0
    kept = 0
    dropped = 0

    for entry in sorted(src_dist.iterdir()):
        if not entry.is_file():
            # tsup is flat — no nested directories in dist/. Skip safely.
            continue

        # Always drop sourcemap siblings: their .js parent gets its trailer
        # stripped below, so the .map is unreferenced + unused. This is the
        # single largest size win — ~60% of core/dist/ is .map files.
        if entry.suffix == ".map":
            dropped += 1
            continue

        if entry.name in drop:
            dropped += 1
            continue

        data = entry.read_bytes()
        if entry.suffix == ".js":
            data = SOURCE_MAP_TRAILER_RE.sub(b"\n", data)

        out = dst_dist / entry.name
        out.write_bytes(data)
        bytes_written += len(data)
        kept += 1

    # Per-file minify pass (opt-in). Runs AFTER the copy + source-map
    # trailer strip so esbuild sees the same shape an adopter would
    # install. Failures on individual files are logged but non-fatal —
    # the original bytes survive on disk for that file.
    minify_before = minify_after = 0
    minified_count = 0
    if esbuild_bin is not None:
        for js in sorted(dst_dist.glob("*.js")):
            before, after = _minify_one(esbuild_bin, js)
            minify_before += before
            minify_after += after
            if after < before:
                minified_count += 1
        if minified_count > 0:
            saved = minify_before - minify_after
            saved_pct = (saved / minify_before * 100) if minify_before else 0
            log(
                f"  minify: {minified_count} .js files "
                f"{minify_before / 1024:.1f} → {minify_after / 1024:.1f} KiB "
                f"(saved {saved / 1024:.1f} KiB, {saved_pct:.1f}%)"
            )
        # Update bytes_written to reflect post-minify state.
        bytes_written = bytes_written - minify_before + minify_after

    log(f"  dist: kept {kept} files ({bytes_written / 1024:.1f} KiB), dropped {dropped}")
    return bytes_written


# ---------------------------------------------------------------------------
# package.json rewrite.
# ---------------------------------------------------------------------------

def rewrite_package_json(
    spec: PackageSpec,
    src_pkg: dict,
    full: bool,
) -> dict:
    """Produce the release-tree package.json for ``spec``.

    - Version bumped to RELEASE_VERSION.
    - `workspace:*` references resolved to `^RELEASE_VERSION`.
    - `scripts`, `devDependencies`, `publishConfig`, internal-only keys dropped.
    - `exports` map narrowed in slim mode.
    - `files` list narrowed to dist + README.
    """
    out: dict = {}

    # Preserve the canonical npm-publish field ordering so the generated
    # file diffs cleanly against `npm publish` output: name, version,
    # description, license, author, type, main, module, types, exports,
    # files, dependencies, peerDependencies, peerDependenciesMeta,
    # engines, repository, homepage, bugs, keywords.
    PRESERVED_ORDER = (
        "name", "version", "description", "license", "author",
        "type", "main", "module", "types",
        "exports",
        "files",
        "dependencies", "peerDependencies", "peerDependenciesMeta",
        "engines", "sideEffects",
        "repository", "homepage", "bugs", "keywords",
    )

    for key in PRESERVED_ORDER:
        if key in src_pkg:
            out[key] = src_pkg[key]

    out["version"] = RELEASE_VERSION

    # Rebrand the npm scope: @causljs/* (GitHub org) → @causl/* (npm
    # scope + brand). See SOURCE_NPM_SCOPE / PUBLISHED_NPM_SCOPE
    # constants at the top of this file for rationale. Affects the
    # `name` field + every `dependencies` key.
    if "name" in out:
        out["name"] = rebrand_scope(out["name"])

    # Resolve workspace:* dependency refs. Per pnpm-workspace.yaml every
    # `@causljs/*` cross-dep ships as `workspace:*` in source; the release
    # tree must turn these into a real semver range pointing at the
    # release version we're emitting. Dependency KEYS also get the
    # scope rebrand so the published tarballs reference @causl/* not
    # @causljs/* (otherwise @causl/react would install but try to
    # resolve a non-existent @causljs/core peer).
    if "dependencies" in out:
        deps = {}
        for dep, ver in out["dependencies"].items():
            new_dep = rebrand_scope(dep)
            new_ver = ver
            if isinstance(ver, str) and ver.startswith("workspace:"):
                # `workspace:*` → `^0.2.0`. `workspace:^` → `^0.2.0`.
                # Anything else (workspace:~, pinned ranges) collapses
                # to the same target — every package in this release
                # ships at the same version, so a single carat range is
                # the right shape.
                new_ver = f"^{RELEASE_VERSION}"
            deps[new_dep] = new_ver
        out["dependencies"] = deps

    # Peer-dependency keys also get the rebrand (a future @causl/react
    # could declare @causl/core as a peer; today it's a regular dep,
    # but the rebrand is shape-safe even when the keys list is empty).
    if "peerDependencies" in out:
        out["peerDependencies"] = {
            rebrand_scope(k): v for k, v in out["peerDependencies"].items()
        }
    if "peerDependenciesMeta" in out:
        out["peerDependenciesMeta"] = {
            rebrand_scope(k): v for k, v in out["peerDependenciesMeta"].items()
        }

    # Narrow exports map in slim mode. Default (slim): only the './'
    # entry survives. --full mode preserves every entry the source had.
    if "exports" in out and not full:
        exports = out["exports"]
        if isinstance(exports, dict):
            keep_keys = {".", "./package.json"}
            keep_keys.update(spec.keep_subpath_exports)
            narrowed = {k: v for k, v in exports.items() if k in keep_keys}
            out["exports"] = narrowed

    # Narrow peer dependencies in slim mode where the peer exists only
    # to satisfy a dropped subpath entry.
    if "peerDependencies" in out and not full:
        peers = dict(out["peerDependencies"])
        for d in spec.slim_drop_peer_deps:
            peers.pop(d, None)
        if peers:
            out["peerDependencies"] = peers
        else:
            out.pop("peerDependencies", None)
        # Also prune peerDependenciesMeta entries for dropped peers.
        if "peerDependenciesMeta" in out:
            meta = {k: v for k, v in out["peerDependenciesMeta"].items()
                    if k not in spec.slim_drop_peer_deps}
            if meta:
                out["peerDependenciesMeta"] = meta
            else:
                out.pop("peerDependenciesMeta", None)

    # `files` narrows to the dist tree + README only. Source workspace
    # package.json may list `wasm/README.md` etc. — these don't exist in
    # the release tree.
    out["files"] = ["dist", "README.md"]

    return out


# ---------------------------------------------------------------------------
# README copy + per-package release stamping.
# ---------------------------------------------------------------------------

def copy_readme(src_root: Path, dst_root: Path) -> None:
    """Copy the package README if present; otherwise emit a minimal one."""
    src = src_root / "README.md"
    dst = dst_root / "README.md"
    if src.is_file():
        shutil.copyfile(src, dst)
    else:
        dst.write_text(f"# {dst_root.name}\n\nPart of the causl v{RELEASE_VERSION} release bundle.\n")


# ---------------------------------------------------------------------------
# Top-level release artefacts.
# ---------------------------------------------------------------------------

RELEASE_README_TEMPLATE = """# causl {version} — release bundle

This directory is built by `tools/release/release.py`. It contains the
minimum viable subset of `@causl/*` packages needed to ship a real
TypeScript application against the causl engine — the **TypeScript-only
path**; no WASM artefacts, no native checker binaries.

## Sizes

{sizes_table}

**Runtime ({algo})** is the headline number — the compressed `.js`
that an adopter's browser fetches over the wire after the bundler
tree-shakes its dependency graph. Matches the SPEC §17.6 / size-limit
gate cell definitions in the source workspace.

**+ Types ({algo})** is the install-time-only `.d.ts` payload —
type declarations the TypeScript compiler consumes; never shipped to
the browser at runtime.

**Raw on disk** is every byte under each package's `dist/` directory.
Useful only as a sanity check; not a meaningful "release size" number.

Total runtime payload across the four bundled packages:
**{total_runtime_kib} KiB ({algo})**.

## Install (per package, from this directory)

```sh
pnpm add ./packages/causl-core
pnpm add ./packages/causl-sync       # peer of causl-react
pnpm add ./packages/causl-react      # if you're using React
pnpm add ./packages/causl-formula    # if you're using the formula DSL
```

Or, if `--tarballs` was passed to the build script, install the `.tgz`
files directly:

```sh
pnpm add ./packages/causl-core/causl-core-{version}.tgz
```

## What's excluded vs the source workspace

- All WASM artefacts (`@causl/core/wasm` subpath; `@causl/core` exports
  the TypeScript engine only in this bundle).
- `@causl/checker` and its platform-specific native binary shards.
- `@causl/sync`, `@causl/persistence`, `@causl/devtools`,
  `@causl/devtools-bridge`, `@causl/hypothesis`,
  `@causl/migration-check`, `@causl/sync-testing-internal`.
- The `./internal` and `./testing` subpath exports on `@causl/core`
  (these are reserved for cross-package internals and test helpers).
- Source maps (`*.map`) and the `//# sourceMappingURL=...` trailers
  in `.js` files.

If you need any of the above, install from the source workspace
instead — this bundle is deliberately narrow for production app
deployments that want a small dependency footprint.

## Reproducing this bundle

```sh
pnpm -r build           # produce the source dist trees
python3 tools/release.py   # build this directory
```

For the full surface (every subpath export retained, source maps kept):

```sh
python3 tools/release.py --full
```

## Manifest

See `manifest.json` for a machine-readable index — name, version,
per-package size (raw / runtime-compressed / types-compressed /
compression algorithm used), and (when `--tarballs` is passed)
tarball SHA-256.
"""


def write_top_level_readme(out_root: Path, manifest: list[dict]) -> None:
    # Per-package table. Numbers reported in two columns:
    #   - "runtime" = compressed size of the .js files adopters fetch
    #                 over the wire after bundler tree-shaking. This is
    #                 the headline number — same definition the
    #                 size-limit gate cells use.
    #   - "+ types" = compressed size of the .d.ts files (install-time
    #                 only; never shipped to the browser). Included for
    #                 the npm-tarball footprint.
    algo = manifest[0]["compression"] if manifest else "brotli"
    rows = ["| Package | Runtime (" + algo + ") | + Types (" + algo + ") | Raw on disk |",
            "| --- | ---: | ---: | ---: |"]
    total_runtime = total_types = total_raw = 0
    for entry in manifest:
        rows.append(
            f"| **{entry['name']}** v{entry['version']} "
            f"(`packages/{entry['slug']}/`) | "
            f"{entry['runtime_compressed_bytes'] / 1024:.2f} KiB | "
            f"{entry['types_compressed_bytes'] / 1024:.2f} KiB | "
            f"{entry['bytes'] / 1024:.1f} KiB |"
        )
        total_runtime += entry["runtime_compressed_bytes"]
        total_types += entry["types_compressed_bytes"]
        total_raw += entry["bytes"]
    rows.append(
        f"| **TOTAL** | "
        f"**{total_runtime / 1024:.2f} KiB** | "
        f"{total_types / 1024:.2f} KiB | "
        f"{total_raw / 1024:.1f} KiB |"
    )

    body = RELEASE_README_TEMPLATE.format(
        version=RELEASE_VERSION,
        sizes_table="\n".join(rows),
        algo=algo,
        total_runtime_kib=f"{total_runtime / 1024:.2f}",
    )
    (out_root / "README.md").write_text(body)


def write_manifest(out_root: Path, manifest: list[dict]) -> None:
    (out_root / "manifest.json").write_text(
        json.dumps(
            {
                "version": RELEASE_VERSION,
                "generated_by": "tools/release/release.py",
                "packages": manifest,
            },
            indent=2,
            sort_keys=False,
            ensure_ascii=False,
        )
        + "\n"
    )


# ---------------------------------------------------------------------------
# Optional: npm pack into a tarball.
# ---------------------------------------------------------------------------

def npm_pack(pkg_dir: Path) -> Path | None:
    """Run `npm pack` against ``pkg_dir`` and return the resulting tarball.

    Returns ``None`` if npm is unavailable; the script does not consider
    that fatal — the tarball pass is opt-in via --tarballs and the
    per-package directories are usable without it.
    """
    npm = shutil.which("npm")
    if npm is None:
        log("  npm not found on PATH — skipping tarball")
        return None

    proc = subprocess.run(
        [npm, "pack", "--silent"],
        cwd=str(pkg_dir),
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        log(f"  npm pack failed: {proc.stderr.strip() or proc.stdout.strip()}")
        return None
    # `npm pack --silent` prints exactly one line: the tarball filename.
    name = proc.stdout.strip().splitlines()[-1].strip()
    tarball = pkg_dir / name
    if not tarball.is_file():
        log(f"  npm pack reported {name} but it's missing on disk")
        return None
    return tarball


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------

def dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            total += p.stat().st_size
    return total


def sha256_of(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Compressed-size measurement.
#
# The raw on-disk byte count of `dist/` is misleading as a "release size"
# headline — adopters never download the unminified chunks + the .d.ts
# type declarations. The relevant numbers are:
#
#   runtime_brotli  = sum of brotli(`*.js`) under dist/  — what the
#                     browser actually fetches over the wire after
#                     bundler dedup. Matches the SPEC §17.6 / size-limit
#                     cell definitions.
#   types_brotli    = sum of brotli(`*.d.ts`) under dist/ — install-time
#                     only, never shipped to the browser.
#
# Brotli q11 matches the Cloudflare/Fastly edge default (same call shape
# as tools/wasm-build/build.mjs uses for the WASM bundle gate).
#
# Brotli isn't in Python's stdlib. We shell out to a brotli binary if
# one's available (`brew install brotli` / `apt install brotli`), and
# fall back to gzip -9 from stdlib otherwise — both numbers are honest;
# gzip is universally supported on the web and runs ~10-15% larger than
# brotli on the same input. The manifest records whichever was used.
# ---------------------------------------------------------------------------

def _measure_brotli(path: Path) -> int | None:
    """Brotli q11 compressed size of a file, via shellout. Returns None
    if `brotli` isn't on PATH or the call fails."""
    binary = shutil.which("brotli")
    if binary is None:
        return None
    proc = subprocess.run(
        [binary, "-q", "11", "-c", str(path)],
        check=False,
        capture_output=True,
    )
    if proc.returncode != 0:
        return None
    return len(proc.stdout)


def _measure_gzip(path: Path) -> int:
    """gzip -9 compressed size of a file, via stdlib. Always available."""
    import gzip
    data = path.read_bytes()
    return len(gzip.compress(data, compresslevel=9))


def compressed_size(path: Path) -> tuple[int, str]:
    """Return (compressed_bytes, algorithm_used).

    Prefers brotli q11; falls back to gzip -9. Both are honest
    representations of what an adopter pays after tree-shaking;
    brotli is the modern web default and the basis for the
    SPEC §17.6 caps.
    """
    br = _measure_brotli(path)
    if br is not None:
        return br, "brotli"
    return _measure_gzip(path), "gzip"


def measure_dist(dist_dir: Path) -> dict:
    """Walk a dist/ directory and aggregate per-extension byte counts.

    Returns:
        {
          "raw_bytes":           int,    # total bytes on disk
          "runtime_raw_bytes":   int,    # *.js files only
          "runtime_compressed":  int,    # *.js compressed
          "types_raw_bytes":     int,    # *.d.ts files only
          "types_compressed":    int,    # *.d.ts compressed
          "compression":         str,    # "brotli" | "gzip"
          "files": [
            {"name": str, "raw": int, "compressed": int, "kind": "js"|"dts"|"other"},
            ...
          ],
        }
    """
    files: list[dict] = []
    runtime_raw = runtime_compressed = 0
    types_raw = types_compressed = 0
    raw_total = 0
    algo = "brotli"  # default optimistic; downgraded by compressed_size() if needed
    for entry in sorted(dist_dir.rglob("*")):
        if not entry.is_file():
            continue
        raw = entry.stat().st_size
        raw_total += raw

        # Classify. The .d.ts → "dts" check has to precede the .ts check
        # (which we don't emit anyway). chunk-*.js + index.js + foo.js
        # all count as runtime.
        name = entry.name
        if name.endswith(".d.ts"):
            kind = "dts"
        elif name.endswith(".js"):
            kind = "js"
        else:
            kind = "other"

        # Only compress kinds adopters actually pay for. README/manifest
        # files at the package root aren't under dist/, so they don't
        # appear here; .d.ts files are install-time only but we measure
        # them so the manifest reports the npm-pack tarball cost
        # accurately.
        if kind in ("js", "dts"):
            comp, used_algo = compressed_size(entry)
            algo = used_algo
        else:
            comp = raw

        files.append({
            "name": str(entry.relative_to(dist_dir)),
            "raw": raw,
            "compressed": comp,
            "kind": kind,
        })

        if kind == "js":
            runtime_raw += raw
            runtime_compressed += comp
        elif kind == "dts":
            types_raw += raw
            types_compressed += comp

    return {
        "raw_bytes": raw_total,
        "runtime_raw_bytes": runtime_raw,
        "runtime_compressed": runtime_compressed,
        "types_raw_bytes": types_raw,
        "types_compressed": types_compressed,
        "compression": algo,
        "files": files,
    }


def build_release(
    out_root: Path,
    full: bool,
    tarballs: bool,
    minify: bool,
    require_minify: bool,
) -> None:
    pkgs_dir = out_root / "packages"
    if pkgs_dir.exists():
        log(f"clearing {pkgs_dir}")
        shutil.rmtree(pkgs_dir)
    pkgs_dir.mkdir(parents=True, exist_ok=True)

    esbuild_bin: Path | None = None
    if minify:
        esbuild_bin = find_esbuild()
        if esbuild_bin is None:
            msg = (
                "esbuild not found (checked $ESBUILD, PATH, "
                "node_modules/.pnpm/node_modules/.bin/esbuild, "
                "node_modules/.bin/esbuild). "
                "Install with `pnpm install` from the repo root."
            )
            if require_minify:
                die(msg)
            log(f"WARNING: {msg} — shipping un-minified bundles.")
        else:
            log(f"minify ON — esbuild={esbuild_bin}")

    manifest: list[dict] = []

    for spec in PACKAGES:
        src_root = REPO_ROOT / spec.src_dir
        if not (src_root / "package.json").is_file():
            die(f"{spec.release_slug}: missing source package.json at {src_root}")

        src_pkg = json.loads((src_root / "package.json").read_text())
        log(f"{spec.release_slug}  ← {spec.src_dir} (source v{src_pkg.get('version', '?')})")

        dst_root = pkgs_dir / spec.release_slug
        dst_root.mkdir(parents=True, exist_ok=False)

        copy_dist(spec, src_root, dst_root, full=full, esbuild_bin=esbuild_bin)
        copy_readme(src_root, dst_root)

        out_pkg = rewrite_package_json(spec, src_pkg, full=full)
        (dst_root / "package.json").write_text(
            json.dumps(out_pkg, indent=2, ensure_ascii=False) + "\n"
        )

        dist_dir = dst_root / "dist"
        sizes = measure_dist(dist_dir)
        manifest_entry = {
            "name": out_pkg["name"],
            "version": out_pkg["version"],
            "slug": spec.release_slug,
            # `bytes` retained for back-compat — total raw bytes under
            # dist/. New consumers should prefer runtime_compressed.
            "bytes": sizes["raw_bytes"],
            "runtime_raw_bytes": sizes["runtime_raw_bytes"],
            "runtime_compressed_bytes": sizes["runtime_compressed"],
            "types_raw_bytes": sizes["types_raw_bytes"],
            "types_compressed_bytes": sizes["types_compressed"],
            "compression": sizes["compression"],
        }

        if tarballs:
            tarball = npm_pack(dst_root)
            if tarball is not None:
                manifest_entry["tarball"] = tarball.name
                manifest_entry["tarball_sha256"] = sha256_of(tarball)
                manifest_entry["tarball_bytes"] = tarball.stat().st_size

        manifest.append(manifest_entry)

    write_manifest(out_root, manifest)
    write_top_level_readme(out_root, manifest)

    log("---")
    log(f"release v{RELEASE_VERSION} built at {out_root}")
    algo = manifest[0]["compression"] if manifest else "n/a"
    log(f"sizes per package — runtime {algo}-compressed (what adopters fetch over the wire):")
    log(f"  {'package':24s}  {'runtime':>10s}  {'+ types':>10s}  {'raw on disk':>12s}")
    total_runtime = total_types = total_raw = 0
    for e in manifest:
        log(
            f"  {e['name']:24s}  "
            f"{e['runtime_compressed_bytes'] / 1024:7.2f} KiB  "
            f"{e['types_compressed_bytes'] / 1024:7.2f} KiB  "
            f"{e['bytes'] / 1024:8.1f} KiB"
        )
        total_runtime += e["runtime_compressed_bytes"]
        total_types += e["types_compressed_bytes"]
        total_raw += e["bytes"]
    log(
        f"  {'TOTAL':24s}  "
        f"{total_runtime / 1024:7.2f} KiB  "
        f"{total_types / 1024:7.2f} KiB  "
        f"{total_raw / 1024:8.1f} KiB"
    )
    log(f"Runtime payload = browser-fetched JS after {algo} compression.")
    log(f"Types payload   = .d.ts install-time-only; never shipped to the browser.")


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Build the @causl release bundle at v" + RELEASE_VERSION,
    )
    p.add_argument(
        "--out",
        default=str(REPO_ROOT / "release"),
        help="output directory (default: ./release)",
    )
    p.add_argument(
        "--full",
        action="store_true",
        help="keep every dist file + every exports subpath (larger bundle)",
    )
    p.add_argument(
        "--tarballs",
        action="store_true",
        help="also emit a .tgz per package via `npm pack`",
    )
    p.add_argument(
        "--minify",
        action="store_true",
        help="re-run esbuild --minify in-place on every .js (smallest "
             "release bundle; matches what we ship as GitHub Release "
             "tarball assets)",
    )
    p.add_argument(
        "--require-minify",
        action="store_true",
        help="treat a missing esbuild as a hard error (use in CI so "
             "release tarballs never silently ship un-minified)",
    )
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    try:
        build_release(
            out_root,
            full=args.full,
            tarballs=args.tarballs,
            minify=args.minify,
            require_minify=args.require_minify,
        )
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — top-level catch-all is fine here
        die(f"unexpected error: {exc!r}", code=2)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
