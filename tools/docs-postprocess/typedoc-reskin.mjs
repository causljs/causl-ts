#!/usr/bin/env node
/*
 * Post-process TypeDoc-generated HTML to wear causl-org chrome.
 *
 * Rationale (#1261): TypeDoc emits ~290 HTML files under
 * `causl-org/pages/documentation/api/**`. Out of the box every one of
 * those files wears its own `<header class="tsd-page-toolbar">` and a
 * "Generated using TypeDoc" footer. Result: roughly half the site is
 * visually a different website from the rest of causl-org. PR #1269
 * (closes #1275) bridged the colour tokens so the typedoc body matches
 * the brand palette, but the chrome (topbar + footer) was left alone.
 *
 * This script runs after `pnpm docs:api` and swaps the typedoc chrome
 * for the same inline topbar + footer markup that every other
 * causl-org page uses. It is intentionally textual (regex + indexOf
 * splicing) rather than DOM-based so it has zero runtime dependencies
 * and survives across typedoc 0.27.x patch bumps that touch attribute
 * order or whitespace inside the toolbar.
 *
 * Idempotent — re-running on already-processed HTML is a no-op because
 * each transform's pre-condition (the typedoc marker) is consumed.
 *
 * When issue #1260 lands (JS-injected topbar with a single source of
 * truth), the inline `<header id="topbar">` block here gets replaced
 * by `<div id="topbar-host" data-current="api" data-depth="N">` and
 * the inline footer by `<div id="footer-host" data-depth="N">`.
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const API_ROOT = join(REPO_ROOT, 'causl-org', 'pages', 'documentation', 'api');
const CAUSL_ORG_ROOT = join(REPO_ROOT, 'causl-org');

/**
 * Recursively yield every `*.html` file under `dir`.
 */
async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      yield full;
    }
  }
}

/**
 * Number of "../" segments to reach `causl-org/` from the directory
 * that contains `filePath`.
 *
 * Example:
 *   causl-org/pages/documentation/api/index.html       → 3 (../../../)
 *   causl-org/pages/documentation/api/types/Foo.html   → 4 (../../../../)
 *
 * `relative(causl-org, file)` produces a path whose segment count
 * equals `dirs above causl-org + 1` (the +1 is the file itself), so
 * the answer is `segments - 1`.
 */
function depthToCauslOrg(filePath) {
  const rel = relative(CAUSL_ORG_ROOT, filePath);
  return rel.split(sep).length - 1;
}

function repeat(s, n) {
  return new Array(n + 1).join(s);
}

/**
 * Inline topbar block — the same one that lives in every hand-edited
 * causl-org page. Links are absolute (start with `/`) so they survive
 * page depth unchanged. The brand image src is the one piece that
 * needs a depth-aware prefix.
 *
 * The `data-current="api"` and `data-depth` attributes on the wrapping
 * `<header>` are added so that, if/when #1260 lands and `topbar.js`
 * gains JS-injection, the same DOM survives the migration unchanged
 * (the injection layer reads `data-current` to set `is-current`).
 */
function topbarHtml(prefix) {
  const depth = prefix === '' ? 0 : prefix.split('../').length - 1;
  return `<header id="topbar" class="topbar" data-current="api" data-depth="${depth}">
    <div class="topbar-content">
      <a href="/" class="topbar-brand" aria-label="Causl home">
        <img class="topbar-brand-img" src="${prefix}img/causl-mark.svg" alt="" aria-hidden="true" width="80" height="80">
        <span class="brand-name">caus<span class="accent">l</span></span>
      </a>
      <div class="pronunciation"><span lang="en-fonipa">/&#712;k&#596;&#720;.z&#601;l/</span> &mdash; like &ldquo;causal&rdquo;</div>
      <p class="tagline">Transactional state for tangled dependency graphs.</p>
    </div>

    <button id="topbarBurger" class="topbar-burger"
            aria-label="Open navigation menu" aria-expanded="false"
            aria-controls="topbar-menu">
      <span class="burger-icon"></span>
    </button>

    <nav id="topbar-menu" class="topbar-menu" aria-hidden="true"
         aria-label="Site navigation">
      <div class="topbar-menu-inner">
        <a href="/">Home</a>
        <a href="/pages/documentation/">Documentation</a>
        <a href="/pages/documentation/getting-started/">Getting Started</a>
        <a href="/pages/documentation/tutorial/">Tutorial</a>
        <a href="/pages/documentation/usage/">Usage Guide</a>
        <a href="/pages/documentation/api/" class="is-current" aria-current="page">API</a>
        <a href="/pages/documentation/faq/">FAQ</a>
        <a href="/pages/documentation/best-practices/">Best Practices</a>
        <a href="/pages/benchmarks/">Benchmarks</a>
        <a href="/pages/playground/">Playground</a>
        <a href="/pages/spreadsheet/">Spreadsheet</a>
        <a href="https://github.com/iasbuilt/causl" rel="noopener">GitHub</a>
        <hr class="menu-divider" />
        <button id="themeToggle" type="button"
                class="topbar-theme-toggle" role="switch" aria-checked="false">
          <span class="theme-glyph">&#9790;</span>
          <span class="theme-label">Dark</span>
        </button>
      </div>
    </nav>
  </header>`;
}

/**
 * Inline footer block — same shape as every other causl-org page.
 */
function footerHtml() {
  return `<footer class="site-footer">
    <div class="page">
      <p>&copy; 2026 Causl contributors &middot; MIT License &middot; State with cause and effect.</p>
      <div class="footer-links">
        <a href="/">Home</a>
        <a href="/pages/documentation/">Documentation</a>
        <a href="/pages/benchmarks/">Benchmarks</a>
        <a href="https://github.com/iasbuilt/causl" rel="noopener">GitHub</a>
      </div>
    </div>
  </footer>`;
}

/**
 * Replace one substring delimited by `startMarker` and `endMarker`
 * (inclusive on both ends) with `replacement`. Returns the new string
 * and a boolean indicating whether the replacement happened.
 *
 * Marker-anchored splicing (instead of regex) keeps us robust to the
 * fact that the typedoc toolbar HTML contains nested `<header>`-like
 * substrings (`<svg>`, `<input>`, etc.) — we can't naively regex on
 * `</header>` because there's exactly one such tag and it's the one
 * we want, but doing it by hand makes the intent obvious.
 */
function spliceBetween(html, startMarker, endMarker, replacement) {
  const start = html.indexOf(startMarker);
  if (start === -1) return { html, changed: false };
  const after = html.indexOf(endMarker, start);
  if (after === -1) return { html, changed: false };
  const end = after + endMarker.length;
  return {
    html: html.slice(0, start) + replacement + html.slice(end),
    changed: true,
  };
}

function processOne(html, prefix) {
  let out = html;
  const changes = [];

  // 1. Add topbar.css link before </head> if not already present.
  //    (#1275 already added site.css; we add topbar.css the same way.)
  const topbarCssLink =
    `<link rel="stylesheet" href="${prefix}css/topbar.css" data-causl-bridge="topbar-css"/>`;
  if (!out.includes('data-causl-bridge="topbar-css"')) {
    const headClose = out.indexOf('</head>');
    if (headClose !== -1) {
      out = out.slice(0, headClose) + topbarCssLink + out.slice(headClose);
      changes.push('add-topbar-css');
    }
  }

  // 2. Replace the typedoc toolbar header with the causl-org topbar.
  {
    const r = spliceBetween(
      out,
      '<header class="tsd-page-toolbar">',
      '</header>',
      topbarHtml(prefix),
    );
    out = r.html;
    if (r.changed) changes.push('replace-toolbar');
  }

  // 3. Drop the typedoc theme-toggle in the right sidebar.
  //    The causl-org topbar's #themeToggle button is the single source
  //    of truth; both write to localStorage("causl-theme") and the
  //    bridge in style.css mirrors it back into TypeDoc's tsd-theme
  //    key on page load (added in #1275).
  {
    const r = spliceBetween(
      out,
      '<div class="tsd-theme-toggle">',
      '</select></div>',
      '',
    );
    out = r.html;
    if (r.changed) changes.push('drop-tsd-theme-toggle');
  }

  // 4. Replace the "Generated using TypeDoc" footer.
  {
    const r = spliceBetween(
      out,
      '<footer><p class="tsd-generator">',
      '</footer>',
      footerHtml(),
    );
    out = r.html;
    if (r.changed) changes.push('replace-footer');
  }

  // 5. Append <script src="…/js/topbar.js" defer> before </body> if
  //    not already present. (Without this, the burger + theme toggle
  //    in the injected topbar are inert.)
  const topbarScriptTag =
    `<script src="${prefix}js/topbar.js" defer data-causl-bridge="topbar-js"></script>`;
  if (!out.includes('data-causl-bridge="topbar-js"')) {
    const bodyClose = out.lastIndexOf('</body>');
    if (bodyClose !== -1) {
      out = out.slice(0, bodyClose) + topbarScriptTag + out.slice(bodyClose);
      changes.push('add-topbar-js');
    }
  }

  return { html: out, changes };
}

async function main() {
  // Sanity: API_ROOT must exist (typedoc must have run first).
  try {
    await stat(API_ROOT);
  } catch {
    console.error(
      `[typedoc-reskin] ${API_ROOT} not found — run \`pnpm docs:api\` first.`,
    );
    process.exit(1);
  }

  let touched = 0;
  let scanned = 0;
  const tally = Object.create(null);
  for await (const file of walk(API_ROOT)) {
    scanned += 1;
    const prefix = repeat('../', depthToCauslOrg(file));
    const html = await readFile(file, 'utf8');
    const { html: out, changes } = processOne(html, prefix);
    if (changes.length > 0 && out !== html) {
      await writeFile(file, out, 'utf8');
      touched += 1;
      for (const c of changes) tally[c] = (tally[c] || 0) + 1;
    }
  }

  console.log(
    `[typedoc-reskin] scanned ${scanned} file(s), modified ${touched}.`,
  );
  for (const [k, v] of Object.entries(tally)) {
    console.log(`  ${k}: ${v}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
