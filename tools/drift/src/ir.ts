/**
 * Drift IR — intermediate representation of "what we found in the
 * codebase that suggests an unmigrated pattern" (#160).
 *
 * The drift detector parses TypeScript/TSX with the TypeScript
 * compiler API (no jscodeshift), classifies AST patterns into one of
 * the categories below, and reports a `DriftReport` JSON document
 * (#163 dashboard contract).
 */

export type DriftCategory =
  /** import { atom } from 'jotai' (or atomFamily, atomWithStorage…) */
  | 'jotai-import'
  /** observable / computed / action / autorun import from 'mobx' */
  | 'mobx-import'
  /** createSlice / configureStore / createAsyncThunk import from RTK */
  | 'redux-import'
  /** useAtom hook call site */
  | 'jotai-hook'
  /** useSelector / useDispatch from react-redux */
  | 'redux-hook'
  /** mobx-react observer() or @observer decorator */
  | 'mobx-observer'
  /** sequential dispatch() pairs that may want a single commit */
  | 'sequential-dispatch'

export interface DriftFinding {
  readonly category: DriftCategory
  readonly file: string
  readonly line: number
  readonly column: number
  /** A short token from the source — the import name, hook name, etc. */
  readonly token: string
  /** Suggested migration: which docs page, which pattern. */
  readonly suggestion: string
}

/**
 * Top-level dashboard contract (#163). Schema-versioned; consumers
 * (CI dashboards, spreadsheets, blog posts) read this JSON and render.
 */
export interface DriftReport {
  readonly schema: 1
  readonly generatedAt: string // ISO 8601
  readonly stats: {
    readonly filesScanned: number
    readonly findings: number
    readonly byCategory: Readonly<Partial<Record<DriftCategory, number>>>
  }
  readonly findings: readonly DriftFinding[]
}
