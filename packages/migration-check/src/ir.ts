/**
 * Drift IR — intermediate representation of "what we found in the
 * codebase that suggests an unmigrated pattern" (#160).
 *
 * The drift detector parses TypeScript/TSX with the TypeScript
 * compiler API (no jscodeshift), classifies AST patterns under a
 * stable rule ID from `docs/migration/RULE_CATALOGUE.md`, and reports
 * a `DriftReport` JSON document (#163 dashboard contract).
 *
 * Every finding carries:
 *   - `ruleId`     — `J-NN`/`M-NN`/`R-NN`/`S-NN`, never reused.
 *   - `severity`   — `critical`/`important`/`nice-to-have`, drives
 *                    CLI exit code (RULE_CATALOGUE.md §Severity).
 *   - `category`   — coarse class (kept for back-compat with v0
 *                    consumers that grouped findings before the
 *                    catalogue existed; new consumers should pivot
 *                    on `ruleId`).
 *
 * The top-level `DriftReport` carries a `catalogueVersion` matching
 * `CATALOGUE_VERSION` so a downstream dashboard can refuse a report
 * produced under a schema it does not recognise.
 */

import type { RuleId, Severity } from './catalogue.js'

/**
 * Coarse drift category — kept for back-compat with v0 consumers
 * that grouped findings by source library before the catalogue
 * shipped. `ruleId` is the canonical identifier.
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
  /** cross-source or causl-idiomatic finding (S-NN rules) */
  | 'cross-source'

export interface DriftFinding {
  /** Stable rule ID from `docs/migration/RULE_CATALOGUE.md`. */
  readonly ruleId: RuleId
  /** Catalogue severity — drives CLI exit code. */
  readonly severity: Severity
  /** Coarse category for back-compat dashboards. */
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
  /**
   * Wire-format version. Bumped on any breaking change to this
   * interface or `DriftFinding`.
   */
  readonly schema: 2
  /**
   * Rule-catalogue schema version (`CATALOGUE_VERSION`). Distinct
   * from `schema` because new rules can be added without breaking
   * the wire format.
   */
  readonly catalogueVersion: string
  readonly generatedAt: string // ISO 8601
  readonly stats: {
    readonly filesScanned: number
    readonly findings: number
    readonly byCategory: Readonly<Partial<Record<DriftCategory, number>>>
    readonly byRuleId: Readonly<Partial<Record<RuleId, number>>>
    readonly bySeverity: Readonly<Record<Severity, number>>
  }
  readonly findings: readonly DriftFinding[]
}
