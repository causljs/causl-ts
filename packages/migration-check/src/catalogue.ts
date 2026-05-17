/**
 * Rule catalogue — declarative table of all drift rules consumed by
 * the IR-driven scanner. Mirrors `docs/migration/RULE_CATALOGUE.md`.
 *
 * Adding a rule:
 * 1. Append a row to `docs/migration/RULE_CATALOGUE.md`.
 * 2. Allocate the next sequential ID for the source (`J`/`M`/`R`/`S`).
 * 3. Add an entry to `RULES` below with `severity`, `predicate`
 *    description, `spec_ref`, `guide_section`, and a `detect()`
 *    implementation in `src/scan.ts`.
 * 4. Add a dedicated test to `test/rule-<id>.test.ts`.
 *
 * The catalogue is versioned. Bumping `CATALOGUE_VERSION` is a
 * breaking change to the JSON `DriftReport.catalogueVersion`
 * consumers depend on — coordinate with #197 (guides) and #199
 * (validation procedure) before changing it.
 */

/**
 * Catalogue schema version. Stamped into every emitted
 * `DriftReport`. Bump on any breaking change to the rule schema.
 */
export const CATALOGUE_VERSION = '0.1' as const

/** Severity → CLI exit-code semantics (see RULE_CATALOGUE.md §Severity meanings). */
export type Severity = 'critical' | 'important' | 'nice-to-have'

/** Rule source (the library being migrated *from*). `S` = cross-source. */
export type RuleSource = 'jotai' | 'mobx' | 'redux' | 'cross'

/** Stable rule identifier — `<J|M|R|S>-NN`. Once allocated, permanent. */
export type RuleId =
  | `J-${string}`
  | `M-${string}`
  | `R-${string}`
  | `S-${string}`

/**
 * Declarative rule descriptor — the row of the catalogue, minus the
 * predicate implementation (which lives in `scan.ts`).
 */
export interface RuleDescriptor {
  readonly id: RuleId
  readonly source: RuleSource
  readonly severity: Severity
  readonly title: string
  /** One-sentence description of when the predicate fires. */
  readonly predicate: string
  /**
   * Anchor into the engine's design rationale (e.g. "§5", "§9.1 row N",
   * "§13"). Each rule earns its place by mapping to a load-bearing
   * design commitment — typically the §3 denotational foundation
   * (commits as the only way time advances, glitch-freedom as a
   * theorem), the §4 two-primitive surface (Inputs and Derivations,
   * everything else is composition), the §5 single-mutation API
   * (`graph.commit(intent, tx => …)`), the §7 model/controller/engine
   * layering, the §8 MVU front door (typed `Msg` union dispatched
   * through `update`), the §9 discriminated-union "make impossible
   * states impossible" discipline including the §9.1 race-class
   * catalogue, the §12.4 in-flight surface additions, or the §13
   * deferred-symbol list. Stamped into every emitted finding so
   * report consumers can trace a flagged pattern back to the design
   * decision that motivates the migration.
   */
  readonly specRef: string
  /** Migration-guide heading slug, or `'cross-source'`. */
  readonly guideSection: string
  /** Path to the dedicated detector test (relative to package root). */
  readonly detectorTest: string
}

/**
 * The full rule table. Order is significant: rules fire in this
 * order, and the report's `findings` are stable per-file in this
 * order. Every entry must have a corresponding `detect*` function in
 * `scan.ts`; `scan.ts` looks up rules by ID.
 */
export const RULES: readonly RuleDescriptor[] = [
  // Jotai — J-NN
  {
    id: 'J-01',
    source: 'jotai',
    severity: 'critical',
    title: 'atom(initial) → graph.input(id, initial)',
    predicate: 'An atom() call with a non-function argument.',
    specRef: '§4',
    guideSection: 'docs/migration/from-jotai.md#J-01',
    detectorTest: 'test/rule-jotai.test.ts',
  },
  {
    id: 'J-02',
    source: 'jotai',
    severity: 'critical',
    title: 'atom((get) => ...) → graph.derived(id, compute)',
    predicate: 'An atom() call with a single function argument.',
    specRef: '§4',
    guideSection: 'docs/migration/from-jotai.md#J-02',
    detectorTest: 'test/rule-jotai.test.ts',
  },
  {
    id: 'J-03',
    source: 'jotai',
    severity: 'critical',
    title: 'atomFamily(...) → useCauslFamily(...)',
    predicate: 'An atomFamily() import or call.',
    specRef: '§12.4',
    guideSection: 'docs/migration/from-jotai.md#J-03',
    detectorTest: 'test/rule-jotai.test.ts',
  },
  {
    id: 'J-04',
    source: 'jotai',
    severity: 'important',
    title: 'atomWithStorage(key, initial) → persistedInput(graph, key, initial, opts)',
    predicate: 'An atomWithStorage() import or call.',
    specRef: '§12.4',
    guideSection: 'docs/migration/from-jotai.md#J-04',
    detectorTest: 'test/rule-jotai.test.ts',
  },
  {
    id: 'J-05',
    source: 'jotai',
    severity: 'critical',
    title: 'useAtomValue(atom) → useCausl((g) => g.read(node))',
    predicate: 'A useAtomValue import or call.',
    specRef: '§8',
    guideSection: 'docs/migration/from-jotai.md#J-05',
    detectorTest: 'test/rule-jotai.test.ts',
  },
  {
    id: 'J-06',
    source: 'jotai',
    severity: 'critical',
    title: 'useSetAtom(atom) → typed useDispatch<Msg>() (no ambient setter)',
    predicate: 'A useSetAtom import or call.',
    specRef: '§8',
    guideSection: 'docs/migration/from-jotai.md#J-06',
    detectorTest: 'test/rule-jotai.test.ts',
  },
  {
    id: 'J-07',
    source: 'jotai',
    severity: 'important',
    title: 'loadable(atom) → useCauslSuspense or useCausl with tag narrowing',
    predicate: 'A loadable() import or call.',
    specRef: '§9.1',
    guideSection: 'docs/migration/from-jotai.md#J-07',
    detectorTest: 'test/rule-jotai.test.ts',
  },
  {
    id: 'J-08',
    source: 'jotai',
    severity: 'important',
    title: 'Provider scope → <CauslProvider graph={...} update={...}>',
    predicate: "A <Provider> element imported from 'jotai'.",
    specRef: '§7.2',
    guideSection: 'docs/migration/from-jotai.md#J-08',
    detectorTest: 'test/rule-jotai.test.ts',
  },
  {
    id: 'J-09',
    source: 'jotai',
    severity: 'nice-to-have',
    title: 'atom written to outside a React component',
    predicate: 'A useSetAtom ref captured in a closure invoked from an effect or timeout.',
    specRef: '§5',
    guideSection: 'docs/migration/from-jotai.md#J-09',
    detectorTest: 'test/rule-jotai.test.ts',
  },

  // MobX — M-NN
  {
    id: 'M-01',
    source: 'mobx',
    severity: 'critical',
    title: 'makeAutoObservable(this) → explicit graph.input registrations',
    predicate: 'A class constructor that calls makeAutoObservable.',
    specRef: '§4',
    guideSection: 'docs/migration/from-mobx.md#M-01',
    detectorTest: 'test/rule-mobx.test.ts',
  },
  {
    id: 'M-02',
    source: 'mobx',
    severity: 'critical',
    title: '@computed getter → graph.derived',
    predicate: 'A @computed-decorated getter or computed(() => ...) call.',
    specRef: '§4',
    guideSection: 'docs/migration/from-mobx.md#M-02',
    detectorTest: 'test/rule-mobx.test.ts',
  },
  {
    id: 'M-03',
    source: 'mobx',
    severity: 'critical',
    title: '@observable field → graph.input',
    predicate: 'An @observable-decorated class field.',
    specRef: '§4',
    guideSection: 'docs/migration/from-mobx.md#M-03',
    detectorTest: 'test/rule-mobx.test.ts',
  },
  {
    id: 'M-04',
    source: 'mobx',
    severity: 'important',
    title: 'runInAction → single graph.commit(intent, tx => { ... })',
    predicate: 'A runInAction block containing two or more property assignments.',
    specRef: '§5',
    guideSection: 'docs/migration/from-mobx.md#M-04',
    detectorTest: 'test/rule-mobx.test.ts',
  },
  {
    id: 'M-05',
    source: 'mobx',
    severity: 'important',
    title: 'reaction(track, effect) → graph.subscribe(node, observer)',
    predicate: 'A reaction import or call.',
    specRef: '§8',
    guideSection: 'docs/migration/from-mobx.md#M-05',
    detectorTest: 'test/rule-mobx.test.ts',
  },
  {
    id: 'M-06',
    source: 'mobx',
    severity: 'nice-to-have',
    title: 'autorun(() => ...) → graph.subscribe or a derived node observed once',
    predicate: 'An autorun import or call.',
    specRef: '§8',
    guideSection: 'docs/migration/from-mobx.md#M-06',
    detectorTest: 'test/rule-mobx.test.ts',
  },

  // Redux / RTK — R-NN
  {
    id: 'R-01',
    source: 'redux',
    severity: 'critical',
    title: 'createSlice → typed Msg union + Update',
    predicate: 'A createSlice call with a reducers object.',
    specRef: '§8',
    guideSection: 'docs/migration/from-redux.md#R-01',
    detectorTest: 'test/rule-redux.test.ts',
  },
  {
    id: 'R-02',
    source: 'redux',
    severity: 'critical',
    title: 'useSelector(state => ...) → useCausl((g) => g.read(node))',
    predicate: 'A useSelector import or call.',
    specRef: '§8',
    guideSection: 'docs/migration/from-redux.md#R-02',
    detectorTest: 'test/rule-redux.test.ts',
  },
  {
    id: 'R-03',
    source: 'redux',
    severity: 'critical',
    title: 'useDispatch() callback → typed useDispatch<Msg>()',
    predicate: "A useDispatch import or call from 'react-redux'.",
    specRef: '§8',
    guideSection: 'docs/migration/from-redux.md#R-03',
    detectorTest: 'test/rule-redux.test.ts',
  },
  {
    id: 'R-04',
    source: 'redux',
    severity: 'important',
    title: 'createAsyncThunk → @causljs/sync resource(graph, key, loader)',
    predicate: 'A createAsyncThunk import or call.',
    specRef: '§9.1',
    guideSection: 'docs/migration/from-redux.md#R-04',
    detectorTest: 'test/rule-redux.test.ts',
  },
  {
    id: 'R-05',
    source: 'redux',
    severity: 'important',
    title: 'createSelector(...) memoized → graph.derived (engine memoizes)',
    predicate: 'A createSelector import or call.',
    specRef: '§4',
    guideSection: 'docs/migration/from-redux.md#R-05',
    detectorTest: 'test/rule-redux.test.ts',
  },
  {
    id: 'R-06',
    source: 'redux',
    severity: 'nice-to-have',
    title: 'extraReducers pending|fulfilled|rejected → resource state-tag narrowing',
    predicate: 'An extraReducers builder containing addCase for *.pending.',
    specRef: '§9.1',
    guideSection: 'docs/migration/from-redux.md#R-06',
    detectorTest: 'test/rule-redux.test.ts',
  },

  // Cross-source / causl-idiomatic — S-NN
  {
    id: 'S-01',
    source: 'cross',
    severity: 'critical',
    title: 'Multiple sequential mutations where one commit would do',
    predicate: 'Two or more setX(); setY(); calls in immediate succession outside a commit.',
    specRef: '§5',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
  {
    id: 'S-02',
    source: 'cross',
    severity: 'critical',
    title: 'update returns the graph instead of a new model',
    predicate: 'An Update<Msg, Model> body that returns the graph argument.',
    specRef: '§8',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
  {
    id: 'S-03',
    source: 'cross',
    severity: 'critical',
    title: 'Asymmetric tx.set / g.read inside commit',
    predicate: "A g.read(...) call inside a commit callback's tx => { ... } body.",
    specRef: '§5',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
  {
    id: 'S-04',
    source: 'cross',
    severity: 'important',
    title: 'useEffect cascade where a derived would suffice',
    predicate: 'A useEffect whose dependency array is a causl read AND whose body sets a causl input.',
    specRef: '§8',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
  {
    id: 'S-05',
    source: 'cross',
    severity: 'important',
    title: 'Stale-closure dispatcher',
    predicate: 'A dispatch/setter reference captured in a closure not re-bound across renders.',
    specRef: '§8',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
  {
    id: 'S-06',
    source: 'cross',
    severity: 'important',
    title: 'Untyped Msg union (string-typed actions)',
    predicate: "A dispatch('foo') or dispatch({ type: 'foo' }) without a discriminated Msg union.",
    specRef: '§8',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
  {
    id: 'S-07',
    source: 'cross',
    severity: 'important',
    title: 'useState/useReducer for state that should be in the graph',
    predicate: 'A useState whose value is shared via context or prop-drilling.',
    specRef: '§7',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
  {
    id: 'S-08',
    source: 'cross',
    severity: 'nice-to-have',
    title: 'Imports from a deferred/non-existent symbol',
    predicate: 'Imports of phantom symbols from packages whose Adoption epic has not shipped.',
    specRef: '§12.4',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
  {
    id: 'S-09',
    source: 'cross',
    severity: 'critical',
    title: 'Codemod-style transformation comments',
    predicate: 'A // TODO(causl-migrate) or similar marker indicating an unfinished step.',
    specRef: '§13',
    guideSection: 'cross-source',
    detectorTest: 'test/rule-cross.test.ts',
  },
] as const

/** Lookup helper: find a rule descriptor by ID. */
export function getRule(id: RuleId): RuleDescriptor | undefined {
  return RULES.find((r) => r.id === id)
}

/**
 * Map a severity to the CLI exit code per the catalogue's binding
 * contract (RULE_CATALOGUE.md §Severity meanings).
 *
 * - `critical` → 1 (fails CI)
 * - `important` → 0 (warning summary only)
 * - `nice-to-have` → 0 (info note)
 *
 * The CLI takes the *max* across all findings: any critical → 1,
 * else 0.
 */
export function severityToExitCode(s: Severity): 0 | 1 {
  return s === 'critical' ? 1 : 0
}
