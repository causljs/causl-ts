/**
 * Regression test: every TypeDoc `.hl-N` syntax-token color in
 * `causl-org/pages/documentation/api/assets/highlight.css` MUST clear
 * the WCAG AA-large contrast threshold (3.0:1) against the codeblock
 * background, in both light and dark themes.
 *
 * Why 3.0:1, not 4.5:1: the project's design choice (codeblock.js
 * audit, #1295) treats syntax tokens as "decorative" — intentional
 * colors that signal structural meaning. WCAG AA-large (3:1) is the
 * documented project threshold for this class. If TypeDoc ships a
 * theme update or a brand-token change drops a color below 3:1, the
 * codeblock.js runtime audit would log warnings and this test fails
 * loudly so the regression doesn't ship.
 *
 * Surface: `pre, code { background: var(--code-background); }` in the
 * same file resolves --code-background to `--light-code-background`
 * (#FFFFFF) under light theme and `--dark-code-background` (#1E1E1E)
 * under dark theme. Those are the actual rendered backgrounds for
 * `<code class="codeblock-source">` on API pages — the syntax.css
 * `code[class*="language-"]` rule does NOT apply because the outer
 * <code> only carries `.codeblock-source` + `data-lang`, never
 * `.language-X` (that class lives on the inner runtime-mounted span).
 *
 * Refs: #1295 (codeblock contrast audit), #1318 (Prism gate that
 * keeps these tokens intact on API pages), commit 698d0c36
 * (isSyntaxToken guard in codeblock.js).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HIGHLIGHT_CSS = resolve(
  __dirname,
  '../../../causl-org/pages/documentation/api/assets/highlight.css',
);

const WCAG_AA_LARGE = 3.0;

// ----- WCAG contrast (sRGB → relative luminance → ratio) -----

function hexToRgb(hex) {
  let h = hex.replace(/^#/, '');
  // Strip 8-digit (alpha) suffix — we audit the RGB channels only.
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) throw new Error(`unrecognized hex: ${hex}`);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fgHex, bgHex) {
  let l1 = relativeLuminance(hexToRgb(fgHex));
  let l2 = relativeLuminance(hexToRgb(bgHex));
  if (l1 < l2) [l1, l2] = [l2, l1];
  return (l1 + 0.05) / (l2 + 0.05);
}

// ----- highlight.css parsing -----

function parseTokens(css) {
  // The :root block declares both --light-hl-N and --dark-hl-N for every
  // slot, plus --light-code-background and --dark-code-background.
  const tokens = {};
  let lightBg = null;
  let darkBg = null;
  const re = /--((?:light|dark)-(?:hl-\d+|code-background))\s*:\s*(#[0-9A-Fa-f]+)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const name = m[1];
    const value = m[2];
    if (name === 'light-code-background') {
      lightBg = value;
    } else if (name === 'dark-code-background') {
      darkBg = value;
    } else {
      const theme = name.startsWith('light-') ? 'light' : 'dark';
      const slot = name.replace(/^(light|dark)-/, '');
      tokens[slot] ??= { light: null, dark: null };
      tokens[slot][theme] = value;
    }
  }
  if (!lightBg || !darkBg) {
    throw new Error('highlight.css is missing --{light,dark}-code-background');
  }
  return { tokens, lightBg, darkBg };
}

// ----- Tests -----

const css = readFileSync(HIGHLIGHT_CSS, 'utf8');
const { tokens, lightBg, darkBg } = parseTokens(css);

test('highlight.css declares both themes for every hl-N slot', () => {
  const slots = Object.keys(tokens);
  assert.ok(slots.length >= 14, `expected ≥14 hl-N slots, got ${slots.length}`);
  for (const slot of slots) {
    assert.ok(tokens[slot].light, `${slot} missing light color`);
    assert.ok(tokens[slot].dark, `${slot} missing dark color`);
  }
});

test('every hl-N token clears 3.0:1 against the LIGHT codeblock background', () => {
  const failures = [];
  for (const slot of Object.keys(tokens).sort()) {
    const fg = tokens[slot].light;
    const ratio = contrastRatio(fg, lightBg);
    if (ratio < WCAG_AA_LARGE) {
      failures.push(`${slot}: ${fg} on ${lightBg} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.equal(
    failures.length, 0,
    `light-theme contrast failures (< ${WCAG_AA_LARGE}:1):\n  ${failures.join('\n  ')}`,
  );
});

test('every hl-N token clears 3.0:1 against the DARK codeblock background', () => {
  const failures = [];
  for (const slot of Object.keys(tokens).sort()) {
    const fg = tokens[slot].dark;
    const ratio = contrastRatio(fg, darkBg);
    if (ratio < WCAG_AA_LARGE) {
      failures.push(`${slot}: ${fg} on ${darkBg} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.equal(
    failures.length, 0,
    `dark-theme contrast failures (< ${WCAG_AA_LARGE}:1):\n  ${failures.join('\n  ')}`,
  );
});

test('contrast table — diagnostic output even on pass', () => {
  // Always-passing test that prints the full ratio matrix on stdout so
  // a CI log shows the current state for future audits. Useful when
  // looking at history.
  const rows = [];
  rows.push(['slot', `light fg`, `vs ${lightBg}`, `dark fg`, `vs ${darkBg}`].join('\t'));
  for (const slot of Object.keys(tokens).sort((a, b) => {
    const an = parseInt(a.replace('hl-', ''), 10);
    const bn = parseInt(b.replace('hl-', ''), 10);
    return an - bn;
  })) {
    const lfg = tokens[slot].light;
    const dfg = tokens[slot].dark;
    const lr = contrastRatio(lfg, lightBg).toFixed(2);
    const dr = contrastRatio(dfg, darkBg).toFixed(2);
    rows.push([slot, lfg, lr, dfg, dr].join('\t'));
  }
  // eslint-disable-next-line no-console
  console.log('\n' + rows.join('\n') + '\n');
  assert.ok(true);
});
