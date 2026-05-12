#!/usr/bin/env python3
"""Flatten the 4-level codeblock-wrapper structure into a single <code>
root (#1294).

Before (4 levels — produced by prerender-codeblocks.py from #1280/#1292):

    <div class="codeblock-wrapper">                         (1)
      <pre class="... has-gutter" data-enhanced="true">      (2)
        <aside class="codeblock-gutter">...</aside>
        <code class="LANG">...source...</code>              (3)
      </pre>
      <button class="codeblock-btn codeblock-copy">...</button>
    </div>

After (2 levels — owned entirely by a single <code class="codeblock">):

    <code class="codeblock" data-lang="LANG" data-enhanced="true">
      <span class="codeblock-gutter" aria-hidden="true">
        <span class="codeblock-gutter-line">1</span>...
      </span>
      <span class="codeblock-source">...source...</span>
      <button class="codeblock-btn codeblock-copy">...</button>
    </code>

The <code> element holds the BOTH the background and color contrast
contract for itself + its descendants. The old <pre> wrapper is dropped
entirely — TypeDoc paints <pre> with --color-code-background (dark even
in light mode) and was winning the cascade fight on API pages.

Idempotency:
  * Skips any block that already contains a <code class="codeblock">
    marker.
  * Skips raw <pre> blocks not inside a codeblock-wrapper (the
    pre-render sweep handles those).

Usage:
    python3 tools/docs-postprocess/flatten-codeblocks.py [--root path] [--verbose]
"""

import argparse
import os
import re
import sys
from pathlib import Path

# Matches the full 4-level structure end-to-end. The wrapper opens with
# <div class="codeblock-wrapper"> on its own line, then a <pre>...</pre>
# with the gutter <aside> + <code>, then a <button>, then closes with
# </div>. We capture each piece by group:
#   1: attribute string on the inner <code>
#   2: inner HTML of the <code>
#   3: full copy <button>...</button> (preserved verbatim)
# Indentation and surrounding whitespace before <pre>, <button>, </div>
# vary across emitters (homepage hand-authored vs. TypeDoc minified)
# so the regex is permissive about whitespace.
WRAPPER_RE = re.compile(
    r'<div\s+class="codeblock-wrapper"\s*>'      # 1. wrapper open
    r'\s*<pre\b[^>]*>'                            # 2. <pre ...>
    r'\s*<aside\b[^>]*class="codeblock-gutter"[^>]*>'  # 3. gutter open
    r'.*?</aside>'                                # 4. gutter close (lazy)
    r'\s*<code\b([^>]*)>'                         # 5. <code attrs> -> group 1
    r'(.*?)'                                      # 6. code inner -> group 2
    r'</code>'                                    # 7. </code>
    r'\s*</pre>'                                  # 8. </pre>
    r'\s*(<button\b[^>]*class="[^"]*codeblock-copy[^"]*"[^>]*>.*?</button>)'  # 9. copy button -> group 3
    r'\s*</div>',                                 # 10. wrapper close
    re.DOTALL | re.IGNORECASE,
)

# Pull the gutter line spans out of the <aside> so we can re-emit them
# inside the new <span class="codeblock-gutter">.
GUTTER_LINE_RE = re.compile(
    r'<span\s+class="codeblock-gutter-line"[^>]*>([^<]*)</span>',
    re.DOTALL | re.IGNORECASE,
)

# Used to extract the language hint from a <code class="..."> attribute
# string. Sources we see:
#   class="language-bash"   (Prism)
#   class="ts" / class="js" (TypeDoc)
#   no class                (homepage hand-coded)
LANG_FROM_LANGUAGE_PREFIX = re.compile(r'\blanguage-([\w-]+)\b')

# Already-converted marker: skip these blocks for idempotency.
ALREADY_FLAT_MARKER = re.compile(
    r'<code\b[^>]*class="[^"]*\bcodeblock\b[^"]*"', re.IGNORECASE
)


def extract_lang(code_attrs: str) -> str:
    """Return the language hint for the data-lang attribute on the new
    <code class="codeblock">. Falls back to the first non-empty class
    token, then to empty string."""
    m = LANG_FROM_LANGUAGE_PREFIX.search(code_attrs)
    if m:
        return m.group(1)
    class_match = re.search(r'\bclass\s*=\s*"([^"]*)"', code_attrs)
    if class_match:
        # TypeDoc emits class="ts" / class="js" — take the first token.
        tokens = [t for t in class_match.group(1).split() if t]
        if tokens:
            return tokens[0]
    return ''


def build_new_gutter(aside_html_segment: str) -> str:
    """Re-emit the gutter as a flat <span class="codeblock-gutter">.
    Pulls the per-line span text out of the original <aside> so we keep
    the exact line count even when the source had trailing whitespace.
    """
    line_texts = GUTTER_LINE_RE.findall(aside_html_segment)
    # Defensive fallback: if for some reason no lines matched, emit
    # nothing — the source span still renders correctly without a gutter.
    inner = ''.join(
        f'<span class="codeblock-gutter-line">{txt}</span>'
        for txt in line_texts
    )
    return f'<span class="codeblock-gutter" aria-hidden="true">{inner}</span>'


def convert_one(match: re.Match) -> str:
    """Build the replacement string for one matched wrapper block."""
    code_attrs = match.group(1)
    code_inner = match.group(2)
    copy_button = match.group(3)

    # Pull the gutter spans out of the original wrapper text. We need
    # the full match text because the gutter sits between <pre> and
    # <code>, both captured implicitly.
    full = match.group(0)
    aside_match = re.search(
        r'<aside\b[^>]*class="codeblock-gutter"[^>]*>(.*?)</aside>',
        full,
        re.DOTALL | re.IGNORECASE,
    )
    aside_inner = aside_match.group(1) if aside_match else ''
    new_gutter = build_new_gutter(aside_inner)

    lang = extract_lang(code_attrs)
    lang_attr = f' data-lang="{lang}"' if lang else ''

    # The original `language-X` class moves from the outer <code> to the
    # inner <span class="codeblock-source"> for tutorial-style blocks.
    # Why: Prism's auto-highlight selector is `code[class*="language-"]`
    # — if we kept that class on the outer <code>, Prism would tokenize
    # the entire textContent (gutter line numbers concatenated with the
    # source) and overwrite our gutter + source children via innerHTML.
    # By putting language-X on the inner span only, Prism's auto-pass
    # skips the block; codeblock-enhance.js then manually invokes
    # Prism.highlightElement() on the source span, where it tokenizes
    # ONLY the actual source.
    #
    # TypeDoc blocks (`class="ts"`/`class="js"`, no "language-" prefix)
    # never used Prism — TypeDoc bakes <span class="hl-N"> tokens at
    # build time — so we don't propagate their class here.
    lang_class_match = re.search(r'\blanguage-[\w-]+\b', code_attrs or '')
    source_class = 'codeblock-source'
    if lang_class_match:
        source_class = f'codeblock-source {lang_class_match.group(0)}'

    # Build the new flat structure. Single line for the open tag, gutter,
    # source span, and copy button — keeps the diff small and matches
    # the prerender output style.
    return (
        f'<code class="codeblock"{lang_attr} data-enhanced="true">'
        f'{new_gutter}'
        f'<span class="{source_class}">{code_inner}</span>'
        f'{copy_button}'
        f'</code>'
    )


def process_file(path: Path) -> int:
    """Process one HTML file in place. Returns the number of wrapper
    blocks flattened."""
    src = path.read_text(encoding='utf-8')

    # Idempotency: if the file already contains the new flat marker AND
    # no remaining codeblock-wrapper blocks, skip without writing.
    has_old = 'codeblock-wrapper' in src
    if not has_old:
        return 0

    converted = 0

    def replace(m: re.Match) -> str:
        nonlocal converted
        # Skip if this block was already flattened (defence-in-depth;
        # the outer regex wouldn't match a flat block anyway).
        if ALREADY_FLAT_MARKER.search(m.group(0)):
            return m.group(0)
        converted += 1
        return convert_one(m)

    new_src = WRAPPER_RE.sub(replace, src)
    if new_src != src:
        path.write_text(new_src, encoding='utf-8')
    return converted


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        '--root',
        default=os.path.join(
            os.path.dirname(os.path.abspath(__file__)), '..', '..', 'causl-org'
        ),
        help='Root directory to scan for *.html files.',
    )
    ap.add_argument(
        '--verbose', action='store_true', help='Print every modified file.'
    )
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f'error: not a directory: {root}', file=sys.stderr)
        return 2

    total_files_changed = 0
    total_blocks_flattened = 0
    for path in sorted(root.rglob('*.html')):
        n = process_file(path)
        if n > 0:
            total_files_changed += 1
            total_blocks_flattened += n
            if args.verbose:
                print(f'  {path.relative_to(root)}  ({n} blocks)')

    print(
        f'flattened {total_blocks_flattened} codeblock(s) across '
        f'{total_files_changed} file(s) under {root}'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
