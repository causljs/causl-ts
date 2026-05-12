#!/usr/bin/env python3
"""Unwrap pre-rendered codeblock markup back to plain
<code class="codeblock-source"> (#1295).

Previous direction (#1294) baked the full component into static HTML:

    <code class="codeblock" data-lang="X" data-enhanced="true">
      <span class="codeblock-gutter" aria-hidden="true">...</span>
      <span class="codeblock-source">RAW SOURCE</span>
      <button class="codeblock-btn codeblock-copy">...</button>
    </code>

That conflated authoring + presentation. The new direction (#1295) keeps
the HTML minimal:

    <code class="codeblock-source" data-lang="X">RAW SOURCE</code>

A runtime module (causl-org/js/codeblock.js) adds the gutter, the copy
button, and a contrast audit on top.

This sweep walks every causl-org/**/*.html, finds every
<code class="codeblock" ...> root, strips the gutter + copy button, and
rewrites the root as <code class="codeblock-source" ...>.

Idempotent:
  * Blocks already in the plain form (`<code class="codeblock-source">`
    with no nested gutter/button) are skipped.
  * Files with no `codeblock"` class token are skipped without writing.

Usage:
    python3 tools/docs-postprocess/unwrap-codeblocks.py [--root path] [--verbose]
"""

import argparse
import os
import re
import sys
from pathlib import Path


# Match the WHOLE flat block.
#   group 1: attribute string on the outer <code class="codeblock" ...>
#            (we use this to recover data-lang).
#   group 2: inner HTML (gutter, source span, button — all of it).
# Non-greedy on inner; relies on no nested `<code class="codeblock"`
# (HTML5 forbids nested <code>, and prerender never produces nested
# blocks).
BLOCK_RE = re.compile(
    r'<code\b([^>]*\bclass="[^"]*\bcodeblock\b[^"]*"[^>]*)>(.*?)</code>',
    re.DOTALL | re.IGNORECASE,
)

# Inside the matched block, the source span carries the actual code
# (and any syntax-highlight tokens inside it). We pull just its INNER
# content out — the gutter + button are dropped.
SOURCE_SPAN_RE = re.compile(
    r'<span\b[^>]*\bclass="[^"]*\bcodeblock-source\b[^"]*"[^>]*>(.*?)</span>\s*(?=<button|</code>|<span\s+class="codeblock-btn|$)',
    re.DOTALL | re.IGNORECASE,
)

# Pull the data-lang="X" off the outer <code> if present.
LANG_RE = re.compile(r'\bdata-lang="([^"]*)"', re.IGNORECASE)

# Pull the language-X class off the outer <code> (Prism convention) so
# we can carry it forward onto the new plain <code class="codeblock-source">.
# Tutorial pages use this; TypeDoc API and homepage do not.
LANGUAGE_CLASS_RE = re.compile(r'\blanguage-[\w-]+\b', re.IGNORECASE)

# Quick file-level pre-filter: skip files that obviously have no
# pre-rendered blocks to convert.
HAS_CODEBLOCK_CLASS = re.compile(r'class="[^"]*\bcodeblock\b[^"]*"', re.IGNORECASE)


def find_source_inner(block_inner: str) -> str:
    """Return the inner HTML of the <span class="codeblock-source"> inside
    a matched block. Falls back to the whole block_inner if no source
    span is found (defensive; in practice every block has one)."""
    # The lookahead in SOURCE_SPAN_RE makes the regex stop at the
    # closing </span> that immediately precedes the copy button, the
    # </code>, or end-of-string. We need a slightly different strategy
    # because <span class="codeblock-source"> contains nested <span>s
    # (token highlights). Walk balanced spans manually.
    return _extract_source_span(block_inner)


def _extract_source_span(s: str) -> str:
    """Find <span ...codeblock-source...> ... </span> with proper
    nesting and return only the inner content. Returns the original
    string if nothing matches (defensive)."""
    open_re = re.compile(
        r'<span\b[^>]*\bclass="[^"]*\bcodeblock-source\b[^"]*"[^>]*>',
        re.IGNORECASE,
    )
    m = open_re.search(s)
    if not m:
        return s
    start = m.end()
    # Walk forward, tracking nested <span> depth.
    depth = 1
    pos = start
    tag_re = re.compile(r'<(/?)(\w+)\b[^>]*>', re.IGNORECASE)
    while pos < len(s):
        m2 = tag_re.search(s, pos)
        if not m2:
            break
        is_close = m2.group(1) == '/'
        tag = m2.group(2).lower()
        if tag == 'span':
            if is_close:
                depth -= 1
                if depth == 0:
                    return s[start:m2.start()]
            else:
                depth += 1
        pos = m2.end()
    # Unbalanced — return everything from `start` to end (best-effort).
    return s[start:]


def extract_lang(attrs: str) -> str:
    """Return the data-lang hint to carry onto the new
    <code class="codeblock-source">. Prefers `data-lang="X"`, else any
    `language-X` class token."""
    m = LANG_RE.search(attrs)
    if m:
        return m.group(1)
    m2 = LANGUAGE_CLASS_RE.search(attrs)
    if m2:
        return m2.group(0).split('-', 1)[1]
    return ''


def convert_one(match: re.Match) -> str:
    attrs = match.group(1) or ''
    inner = match.group(2) or ''

    # Defensive: if the block is already in the plain form (no nested
    # gutter or button), don't rewrite. The outer regex matches both
    # `class="codeblock"` and `class="codeblock-source"`, but the
    # `\bcodeblock\b` token also matches `codeblock-source` because
    # they share the prefix. So we explicitly skip cases where the
    # class list IS `codeblock-source` (not `codeblock`).
    class_match = re.search(r'\bclass="([^"]*)"', attrs)
    if class_match:
        classes = class_match.group(1).split()
        if 'codeblock' not in classes and 'codeblock-source' in classes:
            # Already plain — skip.
            return match.group(0)

    source_inner = find_source_inner(inner)
    lang = extract_lang(attrs)
    lang_attr = f' data-lang="{lang}"' if lang else ''
    return f'<code class="codeblock-source"{lang_attr}>{source_inner}</code>'


def process_file(path: Path) -> int:
    """Process one HTML file in place. Returns the number of blocks
    rewritten."""
    src = path.read_text(encoding='utf-8')
    if not HAS_CODEBLOCK_CLASS.search(src):
        return 0

    converted = 0

    def replace(m: re.Match) -> str:
        nonlocal converted
        attrs = m.group(1) or ''
        # Distinguish: is this `class="codeblock"` (pre-rendered) or
        # `class="codeblock-source"` (already plain)? The regex catches
        # both because `\bcodeblock\b` matches the prefix of the
        # hyphenated variant under \b boundaries.
        class_match = re.search(r'\bclass="([^"]*)"', attrs)
        if not class_match:
            return m.group(0)
        classes = class_match.group(1).split()
        if 'codeblock' not in classes:
            # Pure `codeblock-source` already — leave it alone.
            return m.group(0)
        new = convert_one(m)
        if new != m.group(0):
            converted += 1
        return new

    new_src = BLOCK_RE.sub(replace, src)
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

    total_files = 0
    total_blocks = 0
    for path in sorted(root.rglob('*.html')):
        n = process_file(path)
        if n > 0:
            total_files += 1
            total_blocks += n
            if args.verbose:
                print(f'  {path.relative_to(root)}  ({n} blocks)')

    print(f'unwrapped {total_blocks} codeblock(s) across {total_files} file(s) under {root}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
