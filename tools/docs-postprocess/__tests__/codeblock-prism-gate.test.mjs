/**
 * Regression gate for #1318 — codeblock.js was running Prism over
 * TypeDoc-baked `.hl-N` tokens, producing a sparser tokenization
 * (e.g. bare identifiers like `myObject` / `Error` are not wrapped in
 * any .token.* span by Prism's JS grammar) that the reader perceives
 * as broken syntax highlighting on every API documentation page.
 *
 * The fix: when textSpan already contains TypeDoc syntax tokens, skip
 * Prism. The tokens are already correct and styled by TypeDoc's own
 * highlight.css.
 *
 * These tests pin the behavior on both code paths:
 *
 *   1. API-style page (TypeDoc `.hl-N` tokens already in DOM) →
 *      Prism MUST NOT run; .hl-N tokens MUST be preserved post-mount.
 *
 *   2. Tutorial-style page (raw text, no pre-baked tokens) →
 *      Prism MUST run; .token.* spans MUST be produced.
 *
 * No internals are inspected — only the observable DOM after mount.
 *
 * Why node:test instead of vitest: this test lives outside the
 * `packages/*` workspace tree (it gates a static-site asset under
 * `causl-org/`), so the existing `pnpm test:run` pattern doesn't reach
 * it. Mirrors `tools/audit/__tests__/*.test.ts`'s approach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const siteRoot = resolve(repoRoot, 'causl-org');

const codeblockJs = readFileSync(resolve(siteRoot, 'js/codeblock.js'), 'utf8');
const prismCore = readFileSync(resolve(siteRoot, 'vendor/prismjs/prism-core.min.js'), 'utf8');
const prismClike = readFileSync(resolve(siteRoot, 'vendor/prismjs/prism-clike.min.js'), 'utf8');
const prismJs = readFileSync(resolve(siteRoot, 'vendor/prismjs/prism-javascript.min.js'), 'utf8');
const prismBash = readFileSync(resolve(siteRoot, 'vendor/prismjs/prism-bash.min.js'), 'utf8');

/**
 * Build a JSDOM window with the given <code class="codeblock-source">
 * snippet inside <body>, then load Prism + codeblock.js and dispatch
 * DOMContentLoaded. Returns the `<code>` element post-mount.
 */
function mountFixture(codeHtml) {
  const html = `<!doctype html><html><body>${codeHtml}</body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  // Prism FIRST (page order: prism scripts then codeblock.js).
  window.eval(prismCore);
  window.eval(prismClike);
  window.eval(prismJs);
  window.eval(prismBash);
  window.eval(codeblockJs);
  // codeblock.js attaches a DOMContentLoaded listener since
  // readyState === 'loading' under outside-only scripts; fire it.
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return window.document.querySelector('code.codeblock-source');
}

test('API page: TypeDoc .hl-N tokens are preserved when Prism is loaded (regression #1318)', () => {
  // This is the exact shape TypeDoc emits for a JS @example block —
  // `data-lang="js"` + pre-baked `.hl-N` token spans as children.
  const fixture = `
    <code class="codeblock-source" data-lang="js"><span class="hl-2">const</span><span class="hl-1"> </span><span class="hl-4">myObject</span><span class="hl-1"> = {};</span>
<span class="hl-5">Error</span><span class="hl-1">.</span><span class="hl-0">captureStackTrace</span><span class="hl-1">(</span><span class="hl-5">myObject</span><span class="hl-1">);</span></code>
  `;
  const code = mountFixture(fixture);
  assert.equal(code.dataset.codeblockMounted, 'true');
  const textSpan = code.querySelector('.codeblock-text');
  assert.ok(textSpan, 'textSpan should be created by mount');
  // The fix: .hl-N tokens survive (NOT clobbered by Prism).
  const hlTokens = textSpan.querySelectorAll('[class^="hl-"]');
  assert.ok(hlTokens.length >= 5, `expected TypeDoc .hl-N tokens preserved, got ${hlTokens.length}`);
  // No Prism .token.* spans should have been produced over the top.
  const prismTokens = textSpan.querySelectorAll('.token');
  assert.equal(prismTokens.length, 0, 'Prism must NOT run when .hl-N tokens are already present');
  // The text span should NOT have been given a language-X class —
  // adding it would only matter if we intended Prism to run.
  assert.equal(
    textSpan.classList.contains('language-js'),
    false,
    'language-X class should not be added when we skip Prism',
  );
});

test('Tutorial page: raw source IS tokenized by Prism into .token.* spans', () => {
  // Tutorial pages emit raw source text — no .hl-N children, just text.
  const fixture = `<code class="codeblock-source" data-lang="js">const x = 1;
function foo() { return x; }</code>`;
  const code = mountFixture(fixture);
  assert.equal(code.dataset.codeblockMounted, 'true');
  const textSpan = code.querySelector('.codeblock-text');
  assert.ok(textSpan, 'textSpan should be created by mount');
  // No pre-baked .hl-N tokens here, so Prism SHOULD run.
  assert.equal(textSpan.querySelectorAll('[class^="hl-"]').length, 0);
  // After Prism: .token.* spans are produced for keywords / functions.
  const prismTokens = textSpan.querySelectorAll('.token');
  assert.ok(prismTokens.length > 0, `Prism should have tokenized the raw source, got ${prismTokens.length} tokens`);
  // language-X class IS added when Prism runs.
  assert.equal(
    textSpan.classList.contains('language-js'),
    true,
    'language-js class should be added when Prism runs',
  );
});

test('Bash tutorial: raw source → Prism .token.* spans (no false TypeDoc detection)', () => {
  const fixture = `<code class="codeblock-source" data-lang="bash">pnpm add @causljs/core
pnpm install</code>`;
  const code = mountFixture(fixture);
  const textSpan = code.querySelector('.codeblock-text');
  const prismTokens = textSpan.querySelectorAll('.token');
  assert.ok(prismTokens.length > 0, 'Prism should tokenize bash source');
});

test('Without Prism loaded: pre-baked .hl-N tokens still survive mount', () => {
  // Sanity: even if Prism isn't on the page (e.g. JS bundle changes
  // in the future), mount must never strip TypeDoc tokens.
  const html = `<!doctype html><html><body><code class="codeblock-source" data-lang="js"><span class="hl-2">const</span><span class="hl-1"> x = 1;</span></code></body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.eval(codeblockJs);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  const textSpan = window.document.querySelector('.codeblock-text');
  assert.ok(textSpan.querySelectorAll('[class^="hl-"]').length >= 2);
});
