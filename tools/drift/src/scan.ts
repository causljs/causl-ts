/**
 * Source-text scanner for drift patterns (#161 v0).
 *
 * Implementation strategy: regex-on-tokenized-source. The full
 * compiler-API version handles JSX edge cases (e.g., `{...spread}`
 * obscuring an `atom` reference); v0 uses focused regexes that catch
 * the common 80% — false positives are recoverable via the report's
 * per-finding suggestion text.
 */

import type { DriftCategory, DriftFinding } from './ir.js'

interface Pattern {
  readonly category: DriftCategory
  readonly regex: RegExp
  readonly token: (match: RegExpExecArray) => string
  readonly suggestion: string
}

const PATTERNS: readonly Pattern[] = [
  {
    category: 'jotai-import',
    regex: /from\s+['"]jotai['"]/g,
    token: () => 'jotai',
    suggestion: 'See docs/migration/from-jotai.md.',
  },
  {
    category: 'mobx-import',
    regex: /from\s+['"]mobx['"]/g,
    token: () => 'mobx',
    suggestion: 'See docs/migration/from-mobx.md.',
  },
  {
    category: 'redux-import',
    regex: /from\s+['"]@reduxjs\/toolkit['"]|from\s+['"]react-redux['"]/g,
    token: (m) => m[0],
    suggestion: 'See docs/migration/from-redux.md.',
  },
  {
    category: 'jotai-hook',
    regex: /\b(useAtom|useAtomValue|useSetAtom|atomFamily|atomWithStorage|atomWithReducer)\b/g,
    token: (m) => m[1] ?? m[0],
    suggestion:
      'Replace with useCausl / useDispatch / useCauslFamily / persistedInput.',
  },
  {
    category: 'redux-hook',
    regex: /\b(useSelector|useDispatch|useStore)\s*\(/g,
    token: (m) => m[1] ?? m[0],
    suggestion: 'Replace with useCausl / useDispatch (typed) from @causljs/react.',
  },
  {
    category: 'mobx-observer',
    regex: /\b(observer)\s*\(|@observer\b/g,
    token: () => 'observer',
    suggestion: 'Causl components do not need observer; useCausl handles tracking.',
  },
]

export function scanFile(file: string, source: string): DriftFinding[] {
  const findings: DriftFinding[] = []
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.regex.exec(source)) !== null) {
      const { line, column } = positionOf(source, m.index)
      findings.push({
        category: p.category,
        file,
        line,
        column,
        token: p.token(m),
        suggestion: p.suggestion,
      })
    }
  }
  return findings
}

function positionOf(source: string, index: number): { line: number; column: number } {
  let line = 1
  let column = 1
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}
