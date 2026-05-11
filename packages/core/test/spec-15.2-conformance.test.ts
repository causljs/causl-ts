/**
 * @packageDocumentation
 *
 * Property-suite trial-floor conformance meta-test (EPIC #285
 * sub-issue #292).
 *
 * Property-based tests are the race-detection layer for everything
 * the type system and API shape don't catch. The bounds and seeds
 * commitment is concrete: 1000+ random graphs, 1000+ random commit
 * sequences per property on every CI run; failing inputs are shrunk
 * and committed as regression cases; seeds are deterministic and
 * logged so a CI failure is reproducible. The 1000-trial floor must
 * hold across every property suite in the workspace — wherever it
 * lives — or the contract is silently broken.
 *
 * This meta-test walks every property-test file in the workspace
 * and rejects:
 *
 * 1. Any `fc.assert(...)` call NOT routed through `propertyOptions()`
 *    or `propertyTrials()`.
 * 2. Any `propertyOptions({ numRuns: N })` where `N < 1000`.
 * 3. Any raw `{ numRuns: N }` second argument to `fc.assert` where
 *    `N < 1000`.
 *
 * The walker discovers property suites in three places (see
 * {@link findPropertySuites}): under `test/properties/`, under any
 * `*.property.test.{ts,tsx}` filename, and any other test file that
 * calls `fc.assert(`. The catch-all closes #397: a contributor
 * dropping `numRuns: 100` into a property suite that lives next to
 * its feature tests no longer slips past CI.
 *
 * Rejecting at the test layer (rather than relying on convention)
 * means future contributors who copy-paste the wrong pattern get a
 * red CI before the suite ships.
 *
 * @see EPIC #285 sub-issue #292
 * @see #397 — broaden the walker beyond `test/properties/`
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

/**
 * Absolute path of this meta-test, normalised so the walker excludes
 * itself. Without the exclusion the walker would scan the literal
 * `fc.assert(...)` strings the self-checks build inline and double-
 * count the meta-test as a property suite.
 */
const SELF_PATH = resolve(__dirname, 'spec-15.2-conformance.test.ts')

/**
 * Discover every property-test suite in the workspace.
 *
 * The §15.2 trial floor must hold across every property suite, not
 * just the ones that happen to live in `test/properties/`. The walker
 * picks up three classes of files under `packages/<pkg>/test/`:
 *
 * 1. Anything under a `test/properties/` directory (the canonical
 *    race-detection layer).
 * 2. Any `*.property.test.{ts,tsx}` file at any depth (the naming
 *    convention adopted for property suites that live next to their
 *    feature tests).
 * 3. Any other `*.test.{ts,tsx}` file that calls `fc.assert(` —
 *    the cleanest catch-all, because a file that asserts via
 *    fast-check is a property suite by definition and must honour
 *    the floor regardless of where it lives.
 *
 * @returns absolute paths.
 */
function findPropertySuites(): readonly string[] {
  const root = resolve(__dirname, '../../..')
  const out: string[] = []
  const seen = new Set<string>()
  const packagesDir = join(root, 'packages')
  for (const pkg of readdirSync(packagesDir)) {
    const testDir = join(packagesDir, pkg, 'test')
    try {
      const stat = statSync(testDir)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }
    walk(testDir, out, seen)
  }
  return out
}

function walk(dir: string, out: string[], seen: Set<string>): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const stat = statSync(p)
    if (stat.isDirectory()) {
      walk(p, out, seen)
      continue
    }
    if (!entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      continue
    }
    // Exclude the meta-test itself — its self-checks contain literal
    // `fc.assert(` strings that would otherwise be parsed as live calls.
    if (p === SELF_PATH) continue
    if (seen.has(p)) continue
    if (isPropertySuite(p, entry)) {
      out.push(p)
      seen.add(p)
    }
  }
}

/**
 * Decide whether a test file participates in the §15.2 trial-floor
 * gate. Returns `true` if the file is under a `test/properties/`
 * directory, OR matches `*.property.test.{ts,tsx}`, OR contains a
 * literal `fc.assert(` call.
 */
function isPropertySuite(absPath: string, basename: string): boolean {
  // 1. Under a `test/properties/` directory at any depth.
  if (absPath.includes(`${sep}test${sep}properties${sep}`)) return true
  // 2. Naming convention: `*.property.test.ts` / `*.property.test.tsx`.
  if (
    basename.endsWith('.property.test.ts') ||
    basename.endsWith('.property.test.tsx')
  ) {
    return true
  }
  // 3. Catch-all: any test file that calls `fc.assert(` anywhere.
  //    Reading the file is fine here — the walker runs once per
  //    suite invocation and the test-tree is small.
  try {
    const src = readFileSync(absPath, 'utf8')
    if (src.includes('fc.assert(')) return true
  } catch {
    // Unreadable files are not property suites for our purposes.
  }
  return false
}

/** Trial floor — every property suite runs 1000+ random graphs and 1000+ random commit sequences per property on every CI run. */
const FLOOR = 1000

/**
 * Find every `fc.assert(...)` call in a source string and return
 * the start indices. Naive but sufficient — the meta-test rejects
 * a file if any `fc.assert(` token appears whose nearest closing
 * paren isn't preceded by a `propertyOptions(...)` or
 * `propertyTrials(...)` argument.
 */
function findFcAsserts(src: string): readonly number[] {
  const indices: number[] = []
  let i = 0
  while (true) {
    const next = src.indexOf('fc.assert(', i)
    if (next < 0) break
    indices.push(next)
    i = next + 'fc.assert('.length
  }
  return indices
}

/**
 * Strip leading whitespace and line/block comments from the head of
 * an argument substring. Without this, an inline comment
 * preceding `propertyOptions(...)` would defeat the `^propertyOptions`
 * regex check below and falsely flag a compliant call as a violation.
 */
function stripLeadingComments(s: string): string {
  let i = 0
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (s.startsWith('//', i)) {
      const eol = s.indexOf('\n', i)
      i = eol < 0 ? s.length : eol + 1
      continue
    }
    if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2)
      i = end < 0 ? s.length : end + 2
      continue
    }
    break
  }
  return s.slice(i)
}

/**
 * Extract the second argument (the parameters object) of an
 * `fc.assert(prop, params)` call by counting parens. Returns the
 * substring of `params`, or `null` if no second argument was
 * supplied. Trailing commas (e.g. `fc.assert(prop, opts,)`) are
 * tolerated — the second argument is captured between the first
 * comma and either the next top-level comma OR the closing paren.
 */
function extractFcAssertParams(src: string, startIdx: number): string | null {
  // Step past `fc.assert(`
  let i = startIdx + 'fc.assert('.length
  let depth = 1
  let firstCommaIdx = -1
  let secondCommaIdx = -1
  let closeIdx = -1
  while (i < src.length && depth > 0) {
    // Skip line comments — a comma in the comment text must not
    // count as a top-level argument separator.
    if (src.startsWith('//', i)) {
      const eol = src.indexOf('\n', i)
      i = eol < 0 ? src.length : eol + 1
      continue
    }
    // Skip block comments for the same reason.
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    const c = src[i]!
    // Skip string literals (single, double, template) so commas /
    // parens inside them don't perturb depth tracking.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
        } else if (src[i] === quote) {
          i++
          break
        } else {
          i++
        }
      }
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) {
        closeIdx = i
        break
      }
    } else if (c === ',' && depth === 1) {
      if (firstCommaIdx < 0) firstCommaIdx = i
      else if (secondCommaIdx < 0) secondCommaIdx = i
    }
    i++
  }
  if (firstCommaIdx < 0 || closeIdx < 0) return null
  const end = secondCommaIdx > 0 ? secondCommaIdx : closeIdx
  const slice = src.slice(firstCommaIdx + 1, end).trim()
  // A bare trailing comma `fc.assert(prop,)` yields an empty slice
  // — treat that as "no second argument".
  return slice.length === 0 ? null : slice
}

describe('SPEC §15.2 conformance — every property suite honours the 1000-trial floor (EPIC #285 / #292)', () => {
  /**
   * The walker discovers at least the well-known suites. Without
   * this the meta-test could silently no-op if the directory layout
   * changes.
   */
  it('discovers the canonical property-test suites', () => {
    const suites = findPropertySuites()
    expect(suites.length).toBeGreaterThan(0)
    // Sanity: the canonical race-detection family set must be present
    // — under `test/properties/` (atomicity, determinism, dynamic-deps,
    // glitch-freedom), under the `*.property.test.{ts,tsx}` naming
    // convention (family.property, cross-tree.property), and under
    // the `fc.assert`-anywhere catch-all (persistedInput, ssr-property,
    // useSyncExternalStore, family-grid, readAt, conflict-statechart).
    // If the directory layout shifts, this assertion fails loudly
    // before the suite ships under-trialled.
    const baseNames = suites.map((p) => p.split('/').slice(-1)[0])
    expect(baseNames).toEqual(
      expect.arrayContaining([
        // test/properties/ canonical race-detection set
        'atomicity.test.ts',
        'determinism.test.ts',
        'dynamic-deps.test.ts',
        'glitch-freedom.test.ts',
        // *.property.test.{ts,tsx} convention
        'family.property.test.tsx',
        'cross-tree.property.test.tsx',
        // fc.assert catch-all in non-properties/ directories
        'persistedInput.test.ts',
        'ssr-property.test.tsx',
        'useSyncExternalStore.test.tsx',
        'family-grid.test.tsx',
        'readAt.test.ts',
        'conflict-statechart.test.ts',
      ]),
    )
  })

  /**
   * Every `fc.assert` call in every property suite must pass its
   * parameters through `propertyOptions(...)` or `propertyTrials(...)`.
   * Raw `{ numRuns: N }` literals are forbidden because they bypass
   * the seam helpers' floor enforcement.
   */
  it('rejects raw fc.assert(prop, { numRuns: N }) literal arguments', () => {
    const suites = findPropertySuites()
    const violations: string[] = []
    for (const path of suites) {
      const src = readFileSync(path, 'utf8')
      const indices = findFcAsserts(src)
      for (const idx of indices) {
        const rawParams = extractFcAssertParams(src, idx)
        if (rawParams === null) continue
        // Strip leading comments so `// note\npropertyOptions(...)`
        // is recognised as routed through the seam helper.
        const params = stripLeadingComments(rawParams)
        // Allowed wrappers: propertyOptions(...), propertyTrials(...),
        // and their tier-aware siblings tieredPropertyOptions(...) /
        // tieredPropertyTrials(...) (issue #1153 — those wrappers route
        // numRuns through the fuzz-tier resolver while preserving the
        // SPEC §15.2 ≥1000 floor by construction). Anything else is a
        // violation.
        if (
          /^propertyOptions\b/.test(params) ||
          /^propertyTrials\b/.test(params) ||
          /^tieredPropertyOptions\b/.test(params) ||
          /^tieredPropertyTrials\b/.test(params)
        ) {
          continue
        }
        // Raw literal `{ numRuns: ... }` or any other shape — flag.
        violations.push(`${path}: ${params.slice(0, 80)}`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  /**
   * `propertyOptions({ numRuns: N })` calls anywhere in the property
   * suites must satisfy `N >= 1000` — the documented trial floor for
   * every property on every CI run.
   */
  it('rejects propertyOptions({ numRuns: N }) where N < 1000', () => {
    const suites = findPropertySuites()
    const violations: string[] = []
    const pattern = /propertyOptions\(\s*\{\s*numRuns\s*:\s*(\d[\d_]*)\s*\}\s*\)/g
    for (const path of suites) {
      const src = readFileSync(path, 'utf8')
      let m: RegExpExecArray | null
      while ((m = pattern.exec(src)) !== null) {
        const n = Number(m[1]!.replace(/_/g, ''))
        if (n < FLOOR) {
          violations.push(`${path}: numRuns=${n}`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  /**
   * `propertyTrials({ runs: N })` calls (the seam-helper sibling)
   * also must satisfy `N >= 1000`.
   */
  it('rejects propertyTrials({ runs: N }) where N < 1000', () => {
    const suites = findPropertySuites()
    const violations: string[] = []
    const pattern = /propertyTrials\(\s*[^)]*\{\s*runs\s*:\s*(\d[\d_]*)\s*\}\s*\)/g
    for (const path of suites) {
      const src = readFileSync(path, 'utf8')
      let m: RegExpExecArray | null
      while ((m = pattern.exec(src)) !== null) {
        const n = Number(m[1]!.replace(/_/g, ''))
        if (n < FLOOR) {
          violations.push(`${path}: runs=${n}`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  /**
   * Self-checks for the meta-test's own pattern matchers. Without
   * these, a regression in the regex could silently allow violations
   * to slip through.
   */
  describe('self-checks on the conformance matchers', () => {
    it('catches a literal { numRuns: 200 } as a violation', () => {
      // Synthesise a propertyOptions call inline against the regex.
      const fixture = 'propertyOptions({ numRuns: 200 })'
      const pattern = /propertyOptions\(\s*\{\s*numRuns\s*:\s*(\d[\d_]*)\s*\}\s*\)/
      const match = pattern.exec(fixture)
      expect(match).not.toBeNull()
      expect(Number(match![1])).toBe(200)
    })

    it('accepts propertyOptions() with no args', () => {
      const fixture = 'propertyOptions()'
      const pattern = /propertyOptions\(\s*\{\s*numRuns\s*:\s*(\d[\d_]*)\s*\}\s*\)/
      expect(pattern.exec(fixture)).toBeNull()
    })

    it('accepts propertyOptions({ numRuns: 1000 }) at the floor', () => {
      const fixture = 'propertyOptions({ numRuns: 1000 })'
      const pattern = /propertyOptions\(\s*\{\s*numRuns\s*:\s*(\d[\d_]*)\s*\}\s*\)/
      const match = pattern.exec(fixture)
      expect(match).not.toBeNull()
      const n = Number(match![1]!.replace(/_/g, ''))
      expect(n >= FLOOR).toBe(true)
    })

    it('extractFcAssertParams returns the second argument', () => {
      const src = 'fc.assert(fc.property(arb, () => {}), propertyOptions())'
      const idx = src.indexOf('fc.assert(')
      const params = extractFcAssertParams(src, idx)
      expect(params).toBe('propertyOptions()')
    })

    it('extractFcAssertParams returns null when no second arg', () => {
      const src = 'fc.assert(fc.property(arb, () => {}))'
      const idx = src.indexOf('fc.assert(')
      expect(extractFcAssertParams(src, idx)).toBeNull()
    })

    it('extractFcAssertParams tolerates a trailing comma after the params', () => {
      // Common formatter output: `fc.assert(prop, opts,)`. The
      // earlier (broken) implementation reset argStart on every
      // top-level comma and returned an empty string; the regression
      // surfaced as every multi-line fc.assert in the workspace
      // showing up as a violation.
      const src = `fc.assert(
        fc.property(arb, () => {}),
        propertyOptions(),
      )`
      const idx = src.indexOf('fc.assert(')
      expect(extractFcAssertParams(src, idx)).toBe('propertyOptions()')
    })

    it('stripLeadingComments removes // and /* */ runs before code', () => {
      // Mirrors the call-sites that put a `// Trial budget: …` line
      // immediately above `propertyOptions(...)`. Without comment-
      // stripping the regex check rejected those as raw literals.
      expect(stripLeadingComments('// hi\npropertyOptions()')).toBe(
        'propertyOptions()',
      )
      expect(stripLeadingComments('/* hi */\n  propertyOptions()')).toBe(
        'propertyOptions()',
      )
      expect(stripLeadingComments('   propertyOptions()')).toBe(
        'propertyOptions()',
      )
    })

    it('extractFcAssertParams ignores commas inside leading line comments', () => {
      // Regression: an agent rewriting a property-test comment to read
      // "Trial budget: 1000 trials, matching the floor" inserted a
      // comma INSIDE the line comment that the original parser
      // treated as a top-level argument separator, truncating the
      // extraction at the comment text.
      const src = `fc.assert(
        fc.property(arb, () => {}),
        // Trial budget: 1000 trials, matching the floor
        propertyOptions({ numRuns: 1000 }),
      )`
      const idx = src.indexOf('fc.assert(')
      const params = extractFcAssertParams(src, idx)
      expect(params).not.toBeNull()
      expect(stripLeadingComments(params!)).toBe('propertyOptions({ numRuns: 1000 })')
    })

    it('extractFcAssertParams ignores commas inside string literals', () => {
      const src = `fc.assert(fc.property(arb, () => {}), propertyOptions({ label: 'a, b, c' }),)`
      const idx = src.indexOf('fc.assert(')
      const params = extractFcAssertParams(src, idx)
      expect(params).toBe(`propertyOptions({ label: 'a, b, c' })`)
    })

    it('extractFcAssertParams returns null on a bare trailing comma', () => {
      // Pathological but valid TS: `fc.assert(prop,)`. There is no
      // second argument; the helper must NOT report empty-string as
      // a violation.
      const src = 'fc.assert(fc.property(arb, () => {}),)'
      const idx = src.indexOf('fc.assert(')
      expect(extractFcAssertParams(src, idx)).toBeNull()
    })
  })
})
