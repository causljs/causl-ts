#!/usr/bin/env python3
"""Pre-render the codeblock-wrapper structure into static HTML files
under causl-org/. This pushes the work that codeblock-enhance.js was
doing at runtime back to the static site so the wrapper, gutter, and
copy button are present before any JS executes.

Idempotent:
  * Skips <pre> elements that already carry data-enhanced="true".
  * Skips <pre> elements whose parent is already a
    <div class="codeblock-wrapper">.
  * Skips <pre class="... is-playground"> blocks — those are migrated
    to the new <div class="playground-wrapper"> component instead.

TypeDoc quirks handled:
  * <br/> inside <code> is converted to a real newline. TypeDoc emits
    <br/> separators for multi-line code; without conversion every
    TypeDoc example reads as one line and the gutter renders only "1".
  * TypeDoc inserts <button type="button">Copy</button> as a sibling
    of <code> inside <pre>. Those are stripped so the wrapper's own
    copy button is the only one.

Usage:
    python3 tools/docs-postprocess/prerender-codeblocks.py [--root path]

Prints a per-file summary plus a grand total.
"""

import argparse
import html
import os
import re
import sys
from pathlib import Path

# Matches <pre ...> ... </pre>. Non-greedy so it won't span multiple
# blocks; relies on no nested <pre> (HTML5 forbids it).
PRE_RE = re.compile(r'<pre\b([^>]*)>(.*?)</pre>', re.DOTALL | re.IGNORECASE)

# Matches the <code> child inside a <pre>. There is at most one in
# practice; we keep the attributes verbatim so language classes survive.
CODE_RE = re.compile(r'<code\b([^>]*)>(.*?)</code>', re.DOTALL | re.IGNORECASE)

# Matches any <button>...</button> sibling that TypeDoc emits next to
# <code>. We always drop these; the wrapper's own copy button replaces
# them.
SIBLING_BUTTON_RE = re.compile(
    r'<button\b[^>]*>.*?</button>', re.DOTALL | re.IGNORECASE
)

# <br>, <br/>, <br /> — TypeDoc emits these inside <code>.
BR_RE = re.compile(r'<br\s*/?>', re.IGNORECASE)

# Strip HTML tags (Prism's <span> highlights, etc.) to recover the raw
# source text used for line counting only. The HTML that ends up in
# the final markup keeps the spans untouched.
TAG_RE = re.compile(r'<[^>]+>')

COPY_SVG = (
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" '
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" '
    'stroke-linejoin="round" aria-hidden="true">'
    '<rect x="4" y="4" width="9" height="10" rx="1.5"/>'
    '<path d="M3 12V3a1 1 0 0 1 1-1h7"/></svg>'
)


def text_for_line_count(code_inner_html: str) -> str:
    """Reduce the (already-br-normalized) inner HTML of a <code> to its
    visible text so we can count lines. Mirrors what textContent
    returns at runtime, which is also what the JS path used."""
    # Remove all tags first; what remains is text + HTML entities.
    stripped = TAG_RE.sub('', code_inner_html)
    # Decode entities so &lt; becomes < — irrelevant for newline counts
    # but consistent with textContent.
    return html.unescape(stripped)


def count_lines(text: str) -> int:
    """Count source lines, handling the trailing-newline convention.
    Matches the JS addLineNumbers() heuristic verbatim: split on \\n,
    drop a single empty final element if present, treat empty input as
    one line."""
    lines = text.split('\n')
    if lines and lines[-1] == '':
        lines.pop()
    if not lines:
        return 1
    return len(lines)


def build_gutter(num_lines: int) -> str:
    """Build the static gutter <aside>. Spans are joined with newlines
    to keep the output readable when someone views source."""
    spans = '\n      '.join(
        f'<span class="codeblock-gutter-line">{i + 1}</span>'
        for i in range(num_lines)
    )
    return (
        '<aside class="codeblock-gutter" aria-hidden="true">\n      '
        f'{spans}\n    </aside>'
    )


def build_copy_button() -> str:
    return (
        '<button type="button" class="codeblock-btn codeblock-copy" '
        'aria-label="Copy code to clipboard">'
        f'{COPY_SVG}'
        '<span class="codeblock-btn-tooltip">Copy</span>'
        '</button>'
    )


def ensure_has_gutter_class(pre_attrs: str) -> str:
    """Make sure the <pre> attribute string contains class="... has-gutter".
    Returns the new attribute string and a boolean (modified or not)."""
    class_match = re.search(r'\bclass\s*=\s*"([^"]*)"', pre_attrs)
    if class_match:
        classes = class_match.group(1).split()
        if 'has-gutter' not in classes:
            classes.append('has-gutter')
        new_class = ' '.join(classes)
        pre_attrs = (
            pre_attrs[: class_match.start(1)]
            + new_class
            + pre_attrs[class_match.end(1) :]
        )
    else:
        pre_attrs = pre_attrs.rstrip() + ' class="has-gutter"'
    return pre_attrs


def ensure_data_enhanced(pre_attrs: str) -> str:
    """Append data-enhanced="true" to <pre> attrs unless it's already there."""
    if re.search(r'\bdata-enhanced\s*=', pre_attrs):
        return pre_attrs
    return pre_attrs.rstrip() + ' data-enhanced="true"'


def has_class(attrs: str, name: str) -> bool:
    m = re.search(r'\bclass\s*=\s*"([^"]*)"', attrs)
    if not m:
        return False
    return name in m.group(1).split()


def process_pre(match: re.Match, surrounding: str) -> str:
    """Transform a single <pre>...</pre> match if eligible. Returns the
    replacement string (or the original if skipped)."""
    full = match.group(0)
    pre_attrs = match.group(1)
    pre_inner = match.group(2)

    # Skip rules.
    if 'data-enhanced' in pre_attrs:
        return full
    if has_class(pre_attrs, 'is-playground'):
        return full

    # Find <code> child. If there is no <code> (rare; raw <pre>) we
    # leave it alone — the existing behaviour was JS-only too.
    code_match = CODE_RE.search(pre_inner)
    if not code_match:
        return full

    # If parent is already a codeblock-wrapper, skip. We look at the
    # surrounding text just before the <pre> opening tag.
    start = match.start()
    # Walk back over whitespace to inspect the immediate predecessor.
    j = start - 1
    while j >= 0 and surrounding[j] in ' \t\n\r':
        j -= 1
    if j >= 0:
        # If the preceding non-whitespace ends with the wrapper opening
        # tag, we're already wrapped.
        prefix_window = surrounding[max(0, j - 60) : j + 1]
        if re.search(r'<div\s+class="codeblock-wrapper"\s*>\s*$', prefix_window):
            return full

    code_attrs = code_match.group(1)
    code_inner = code_match.group(2)

    # Normalize <br> -> \n inside <code>, both for counting and for
    # the final markup (so textContent in the browser yields newlines).
    code_inner_norm = BR_RE.sub('\n', code_inner)
    raw_text = text_for_line_count(code_inner_norm)
    num_lines = count_lines(raw_text)

    # Strip any sibling buttons (TypeDoc emits its own Copy) between
    # </code> and </pre>. Anything before <code> we leave alone (the
    # JS path also did not touch it).
    pre_after_code = pre_inner[code_match.end() :]
    pre_after_code = SIBLING_BUTTON_RE.sub('', pre_after_code)
    pre_before_code = pre_inner[: code_match.start()]

    new_pre_attrs = ensure_has_gutter_class(pre_attrs)
    new_pre_attrs = ensure_data_enhanced(new_pre_attrs)

    gutter = build_gutter(num_lines)
    copy_button = build_copy_button()

    new_code = f'<code{code_attrs}>{code_inner_norm}</code>'

    # Assemble. The gutter is the first <pre> child so it sits to the
    # left of <code>; the copy button lives in the wrapper, not in the
    # <pre>, so absolute positioning works.
    new_pre = (
        f'<pre{new_pre_attrs}>\n      '
        f'{gutter}\n      '
        f'{new_code}'
        f'{pre_after_code}'
        f'</pre>'
    )
    if pre_before_code.strip():
        # Edge case: stray text/markup before <code> inside <pre>. Keep
        # it — should never happen in our sources but don't lose data.
        new_pre = (
            f'<pre{new_pre_attrs}>{pre_before_code}\n      '
            f'{gutter}\n      '
            f'{new_code}{pre_after_code}</pre>'
        )

    return f'<div class="codeblock-wrapper">\n    {new_pre}\n    {copy_button}\n  </div>'


def process_file(path: Path) -> int:
    """Process one HTML file in place. Returns the number of <pre>
    blocks wrapped."""
    src = path.read_text(encoding='utf-8')
    wrapped = 0

    def replace(m: re.Match) -> str:
        nonlocal wrapped
        new = process_pre(m, src)
        if new != m.group(0):
            wrapped += 1
        return new

    new_src = PRE_RE.sub(replace, src)
    if new_src != src:
        path.write_text(new_src, encoding='utf-8')
    return wrapped


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
    total_blocks_wrapped = 0
    for path in sorted(root.rglob('*.html')):
        n = process_file(path)
        if n > 0:
            total_files_changed += 1
            total_blocks_wrapped += n
            if args.verbose:
                print(f'  {path.relative_to(root)}  ({n} blocks)')

    print(
        f'pre-rendered {total_blocks_wrapped} codeblock(s) across '
        f'{total_files_changed} file(s) under {root}'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
