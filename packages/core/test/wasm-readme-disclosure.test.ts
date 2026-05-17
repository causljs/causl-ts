/**
 * Phase-1 wrapper-not-Rust disclosure gate (#1126).
 *
 * Per Beck/Metz ship-verdict panel: the load-bearing risk in shipping
 * `@causljs/core` 0.9.0 is adopters reading "WASM substrate" as "WASM
 * perf" and shipping `causl-wasm` into a hot path expecting the
 * Rust-engine win that isn't there yet. The mitigation lives at the
 * top of `packages/core/wasm/README.md` as a Phase-1 callout block
 * above the host-tier table.
 *
 * This test is brittle by design. It exists to prevent a future PR
 * from silently weakening (or removing) the disclosure to mollify
 * adopters. If the disclosure is reworded, the rewording must keep
 * every load-bearing phrase intact:
 *
 *   - "Phase-1 state"           — version anchor; identifies the
 *                                 wrapper era explicitly.
 *   - "wrapper"                 — the actual shape adopters get;
 *                                 generic enough to survive editing
 *                                 the surrounding sentence.
 *   - "NOT a Rust engine"       — the headline mis-expectation the
 *                                 callout exists to defuse.
 *   - "~0% runtime delta"       — the concrete number adopters need
 *                                 to plan capacity against; mollifying
 *                                 this number is exactly the failure
 *                                 mode the test guards.
 *
 * If a SPEC editor or release manager genuinely needs to reword the
 * callout, they update both the README AND this assertion list in
 * the same PR — that is the explicit review gate this test enforces.
 *
 * The callout must also appear *above* the host-tier table (the
 * "## Host requirements" heading) so adopters see the disclosure
 * before they reach the host-compatibility matrix. A disclosure
 * tucked below the table is invisible to skim-readers — exactly the
 * adopter persona the panel identified as at-risk.
 */

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const readmePath = resolve(__dirname, '../wasm/README.md')
const readmeText = readFileSync(readmePath, 'utf8')

/**
 * Load-bearing phrases the callout must contain. Each entry is the
 * literal substring the README must hold; the failure message names
 * the phrase so a regressing PR sees the exact gate it tripped.
 */
const REQUIRED_PHRASES = [
  'Phase-1 state',
  'wrapper',
  'NOT a Rust engine',
  '~0% runtime delta',
] as const

describe('packages/core/wasm/README.md — Phase-1 wrapper disclosure (#1126)', () => {
  test.each(REQUIRED_PHRASES)(
    'README contains the load-bearing phrase %j',
    (phrase) => {
      expect(
        readmeText.includes(phrase),
        `packages/core/wasm/README.md is missing the Phase-1 disclosure phrase ${JSON.stringify(
          phrase,
        )}. ` +
          `Per #1126, the wrapper-not-Rust callout above the host-tier ` +
          `table must keep this phrase intact — adopters who skim release ` +
          `notes still see this README and need the disclosure verbatim. ` +
          `If the rewording is genuinely needed, update both the README ` +
          `and the REQUIRED_PHRASES list in this test in the same PR.`,
      ).toBe(true)
    },
  )

  test('disclosure callout lands above the host-tier table', () => {
    // The callout is a blockquote (lines starting with "> ") near the
    // top of the file. Pin the ordering: every required phrase must
    // appear in the README *before* the "## Host requirements"
    // heading. A disclosure tucked below the matrix is invisible to
    // the skim-reader persona the panel flagged.
    const hostHeadingIdx = readmeText.indexOf('## Host requirements')
    expect(
      hostHeadingIdx,
      'packages/core/wasm/README.md no longer has a "## Host requirements" ' +
        'section — this test assumes that heading is the host-tier table ' +
        'anchor. Update the test if the heading was renamed.',
    ).toBeGreaterThan(-1)

    for (const phrase of REQUIRED_PHRASES) {
      const phraseIdx = readmeText.indexOf(phrase)
      expect(
        phraseIdx,
        `Phrase ${JSON.stringify(phrase)} is not in the README at all — ` +
          `see the per-phrase test above.`,
      ).toBeGreaterThan(-1)
      expect(
        phraseIdx,
        `Phrase ${JSON.stringify(phrase)} appears at offset ${phraseIdx}, ` +
          `which is *after* the "## Host requirements" heading at offset ` +
          `${hostHeadingIdx}. Per #1126 the disclosure callout must land ` +
          `above the host-tier table so skim-readers see it before the ` +
          `host-compatibility matrix.`,
      ).toBeLessThan(hostHeadingIdx)
    }
  })

  test('disclosure callout is rendered as a Markdown blockquote', () => {
    // A regression mode worth pinning: a future PR could keep the
    // phrases but downgrade the visual weight (e.g., delete the
    // blockquote markers so the text renders as a normal paragraph).
    // The callout being a blockquote with the ⚠️ glyph is what makes
    // it eye-catching in the GitHub rendered view.
    const calloutLine = readmeText
      .split('\n')
      .find((line) => line.includes('Phase-1 state'))
    expect(
      calloutLine,
      'Could not find the Phase-1 callout line in the README.',
    ).toBeDefined()
    expect(
      calloutLine!.startsWith('>'),
      `The Phase-1 disclosure line ${JSON.stringify(
        calloutLine,
      )} is no longer a Markdown blockquote. Per #1126 the callout ` +
        `must render as a blockquote so it stays visually prominent in ` +
        `GitHub / npm rendered views.`,
    ).toBe(true)
  })
})
