/**
 * Tests for check-apalache-mapping (#574 / Phase 8 wave 24).
 *
 * The script gates the apalache differential runner on a structural
 * precondition: every `(model, invariant)` row in
 * `tools/apalache-diff/mapping.toml` must resolve to a real INVARIANT
 * / PROPERTY clause in the matching `.tla` file. The tests below
 * exercise the pure parser/validator predicates against synthetic
 * inputs (so the regression witness is independent of any future
 * corpus growth) AND a happy-path against the real seed mapping (so
 * the gate cannot silently drift away from the on-disk corpus).
 *
 * The negative cases — bogus invariant name, missing tracking_issue
 * — are the two failure modes the runner cares about: they map
 * 1:1 to "apalache-mc would be invoked with a non-existent symbol"
 * and "an exception silently became permanent allow-list".
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  parseMappingToml,
  tlaDeclaresInvariant,
  validateMapping,
} from '../check-apalache-mapping.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const scriptPath = resolve(__dirname, '../check-apalache-mapping.ts')
const realMappingPath = resolve(repoRoot, 'tools/apalache-diff/mapping.toml')

describe('parseMappingToml', () => {
  test('parses the real seed mapping into 10 scenarios + 1 exception', () => {
    const text = readFileSync(realMappingPath, 'utf8')
    const doc = parseMappingToml(text)
    // EPIC-7 corpus floor: ten scenarios, one named exception. If the
    // seed grows or shrinks, this floor is the canary — the seed is
    // frozen per the mapping.toml header doctrine.
    assert.equal(doc.scenarios.length, 10)
    assert.equal(doc.exceptions.length, 1)

    // Spot-check a row to confirm field extraction.
    const dispose = doc.scenarios.find((s) => s.name === 'dispose_then_read')
    assert.ok(dispose, 'expected dispose_then_read scenario')
    assert.equal(dispose!.invariant, 'UseAfterDisposeFree')
    assert.equal(
      dispose!.tla_path,
      'tools/enumerator/corpus/apalache/dispose_then_read.tla',
    )

    // Exception row must carry tracking_issue (the precondition the
    // script enforces).
    assert.equal(doc.exceptions[0]!.tracking_issue, 'iasbuilt/causl#574')
  })

  test('handles single-line and multi-line triple-quoted strings', () => {
    const toml = `
[[exceptions]]
scenario = "x"
reason = """one-line"""
tracking_issue = "#1"

[[exceptions]]
scenario = "y"
reason = """
multi
line
"""
tracking_issue = "#2"
`
    const doc = parseMappingToml(toml)
    assert.equal(doc.exceptions[0]!.reason, 'one-line')
    assert.equal(doc.exceptions[1]!.reason, '\nmulti\nline\n')
  })
})

describe('tlaDeclaresInvariant', () => {
  test('matches a top-level `Name ==` definition (canonical corpus shape)', () => {
    const tla = `
EXTENDS Integers
VARIABLES x
Init == x = 0
Monotonic == [][x' >= x]_<<x>>
`
    assert.equal(tlaDeclaresInvariant(tla, 'Monotonic'), true)
    assert.equal(tlaDeclaresInvariant(tla, 'Init'), true)
  })

  test('matches an `INVARIANT Name` directive', () => {
    const tla = 'INVARIANT MyInv\n'
    assert.equal(tlaDeclaresInvariant(tla, 'MyInv'), true)
  })

  test('matches an `INVARIANTS == { Foo, Bar }` apalache-cfg list', () => {
    const tla = 'INVARIANTS == { Foo, Bar }\n'
    assert.equal(tlaDeclaresInvariant(tla, 'Foo'), true)
    assert.equal(tlaDeclaresInvariant(tla, 'Bar'), true)
  })

  test('does NOT match a substring that is not an actual definition', () => {
    const tla = '\\* this comment mentions Bogus but does not define it\n'
    assert.equal(tlaDeclaresInvariant(tla, 'Bogus'), false)
  })

  test('does NOT match a similarly-prefixed identifier', () => {
    const tla = 'MonotonicPlus == TRUE\n'
    // Word-boundary discipline: Monotonic must not match MonotonicPlus.
    assert.equal(tlaDeclaresInvariant(tla, 'MonotonicPlus'), true)
    // ...but the `Name ==` shape is a substring; `Monotonic` is also
    // a substring of `MonotonicPlus`. Confirm the regex is anchored
    // enough to refuse this.
    assert.equal(tlaDeclaresInvariant(tla, 'Monotonic'), false)
  })
})

describe('validateMapping (happy path against real corpus)', () => {
  test('zero violations against the real mapping + on-disk corpus', () => {
    const text = readFileSync(realMappingPath, 'utf8')
    const doc = parseMappingToml(text)
    const violations = validateMapping(doc, (relPath) => {
      const abs = resolve(repoRoot, relPath)
      try {
        return readFileSync(abs, 'utf8')
      } catch {
        return null
      }
    })
    assert.deepEqual(
      violations,
      [],
      `expected zero violations; got ${JSON.stringify(violations, null, 2)}`,
    )
  })
})

describe('validateMapping (negative cases)', () => {
  test('bogus invariant name fails the check with `invariant-missing`', () => {
    const doc = {
      scenarios: [
        {
          name: 'synth',
          tla_path: 'fake/path.tla',
          invariant: 'DoesNotExist',
        },
      ],
      exceptions: [],
    }
    // readTla returns a tla file that defines `RealInvariant` but not
    // `DoesNotExist` — the exact "typo / stale reference" failure mode
    // the audit is designed to catch.
    const violations = validateMapping(doc, () => 'RealInvariant == TRUE\n')
    assert.equal(violations.length, 1)
    assert.equal(violations[0]!.kind, 'invariant-missing')
    if (violations[0]!.kind === 'invariant-missing') {
      assert.equal(violations[0]!.invariant, 'DoesNotExist')
      assert.equal(violations[0]!.reason, 'invariant not found in tla file')
    }
  })

  test('missing tla file fails the check with `tla-file-missing`', () => {
    const doc = {
      scenarios: [
        {
          name: 'synth',
          tla_path: 'absent/path.tla',
          invariant: 'X',
        },
      ],
      exceptions: [],
    }
    const violations = validateMapping(doc, () => null)
    assert.equal(violations.length, 1)
    assert.equal(violations[0]!.kind, 'tla-file-missing')
  })

  test('exception row missing `tracking_issue` fails the check', () => {
    const doc = {
      scenarios: [],
      exceptions: [
        {
          scenario: 'foo',
          kind: 'encoding-asymmetric',
          reason: 'because',
          // tracking_issue intentionally absent — the audit must
          // refuse to allow-list silently.
        },
      ],
    }
    const violations = validateMapping(doc, () => '')
    assert.equal(violations.length, 1)
    assert.equal(violations[0]!.kind, 'exception-missing-tracking-issue')
    if (violations[0]!.kind === 'exception-missing-tracking-issue') {
      assert.equal(violations[0]!.scenario, 'foo')
    }
  })

  test('exception row with empty/whitespace `tracking_issue` fails the check', () => {
    const doc = {
      scenarios: [],
      exceptions: [
        { scenario: 'bar', tracking_issue: '   ' },
      ],
    }
    const violations = validateMapping(doc, () => '')
    assert.equal(violations.length, 1)
    assert.equal(violations[0]!.kind, 'exception-missing-tracking-issue')
  })
})

describe('check-apalache-mapping script integration', () => {
  test('end-to-end script exits 0 against the real seed mapping', () => {
    // Invoke from a non-root cwd to confirm the script is cwd-resilient
    // (same #565 lesson the other audit scripts learned the hard way).
    const result = spawnSync('node', ['--import', 'tsx', scriptPath], {
      cwd: resolve(repoRoot, 'tools'),
      encoding: 'utf8',
    })
    assert.equal(
      result.status,
      0,
      `script exited ${result.status}; ` +
        `stdout=${result.stdout} stderr=${result.stderr}`,
    )
    assert.match(
      result.stdout,
      /PASS — 10 scenario\(s\) \+ 1 exception\(s\) all resolve/,
    )
  })
})
