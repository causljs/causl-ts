/**
 * @packageDocumentation
 *
 * Source for the 1000-cell React viewport fixture (#869, extending the
 * causl-only #765 / PR #800 gate to all four canonical libraries).
 * This module is bundled by the e2e `build` script (`pnpm --filter
 * @causljs/react test:e2e:build`) into a single browser ESM file that
 * the harness HTML page imports. React, react-dom/client, and the
 * four state libraries (`@causljs/core` + `@causljs/react`, `jotai`,
 * `@reduxjs/toolkit` + `react-redux`, `mobx` + `mobx-react-lite`)
 * are all baked into the bundle so the harness runs from a static
 * `python3 -m http.server` with no importmap or UMD shim plumbing.
 *
 * The fixture is parameterized on the `?lib=causl|jotai|redux|mobx`
 * URL query param. Each library variant implements the same three
 * plug-points (per A12 §2):
 *
 *   1. **buildGraph()** — constructs the 1000-cell store. For causl
 *      that's `createCausl()` + 1000 `graph.input(...)` nodes; for
 *      jotai a `createStore()` plus 1000 primitive atoms; for redux a
 *      single `configureStore` slice with a 1000-element array; for
 *      mobx 1000 `observable.box(...)`.
 *   2. **<Cell>** leaf hook — re-renders ONLY when its cell's value
 *      changes. Each library uses its idiomatic per-cell subscription
 *      primitive (`useCauslNode`, `useAtomValue`, `useSelector`,
 *      `observer`).
 *   3. **runHarness mutator** — issues one cell bump per frame in
 *      round-robin order. Translates to `graph.commit`, `store.set`,
 *      `store.dispatch`, or `runInAction` per library.
 *
 * Why a 1000-cell grid: that's the viewport the §14 perceptual-perf
 * cell of the SPEC names ("≤ 5% dropped frames over 30s on a 1000-cell
 * viewport at 60Hz"). One commit per frame mutates exactly one cell, so
 * each library's per-cell subscription path is the hot loop measured.
 *
 * The harness exposes `window.runHarness(durationMs, frequencyHz)` that
 * the Playwright spec drives. Each frame:
 *   1. records `performance.now()` at the rAF callback boundary,
 *   2. issues one commit that bumps the next cell in round-robin order,
 *   3. records `performance.now()` again after `requestAnimationFrame`
 *      next-tick (the commit-to-paint observation; the next rAF
 *      represents the frame in which the commit's React work + layout
 *      + paint finished and the compositor presented to the screen).
 *
 * The Playwright spec computes:
 *   - dropped-frame ratio (frames whose inter-rAF delta exceeds the
 *     16.6ms vsync budget × tolerance multiplier),
 *   - p95 commit-to-paint (the 95th percentile of the per-frame
 *     commit-issue → next-rAF observation).
 */

import { createCausl, type Graph, type InputNode } from '@causljs/core'
import { CauslProvider, useCauslNode } from '@causljs/react'
import {
  configureStore,
  createSlice,
  Tuple,
  type PayloadAction,
} from '@reduxjs/toolkit'
import {
  atom,
  createStore as createJotaiStore,
  Provider as JotaiProvider,
  useAtomValue,
  type PrimitiveAtom,
} from 'jotai'
import { observable, runInAction, type IObservableValue } from 'mobx'
import { observer } from 'mobx-react-lite'
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider as ReduxProvider, useSelector } from 'react-redux'

/**
 * Number of cells in the viewport. The §14.4 perceptual-perf cell pins
 * this to 1000 — the viewport size where adopters reported the
 * selector-fan-out path of `useCausl` started missing 60fps on a
 * MacBook Air M1, which is the regression `useCauslNode` exists to
 * fix. The gate must fail if a future change reintroduces the same
 * fan-out cost.
 */
const CELL_COUNT = 1000

interface HarnessSamples {
  /** rAF timestamps in milliseconds — one per recorded frame. */
  readonly frameTimes: number[]
  /**
   * Per-frame commit-to-paint observations in milliseconds. Index `i`
   * is the time between commit-issue at frame `i` and the next rAF
   * callback (frame `i + 1`), which is the closest proxy a headless
   * Chromium harness has for "user saw the change on screen".
   */
  readonly commitToPaint: number[]
  /** Number of commits issued during the run. */
  readonly committed: number
  /** Library variant the harness was driving. */
  readonly lib: LibName
}

declare global {
  interface Window {
    /**
     * Drive the harness for `durationMs` milliseconds at a target
     * `frequencyHz` (60Hz unless overridden by the test). Returns the
     * raw samples; the Playwright spec is responsible for computing the
     * ratios and percentiles so the gate logic lives next to the
     * threshold constants in the spec file rather than in the fixture.
     */
    runHarness(durationMs: number, frequencyHz?: number): Promise<HarnessSamples>
  }
}

/**
 * Library variants the fixture supports. Selected via the `?lib=...`
 * URL query parameter; defaults to `causl` (matches the pre-#869 single-
 * library behaviour so existing harness URLs keep working).
 */
type LibName = 'causl' | 'jotai' | 'redux' | 'mobx'

const LIB_NAMES: readonly LibName[] = ['causl', 'jotai', 'redux', 'mobx']

function resolveLib(): LibName {
  const params = new URLSearchParams(window.location.search)
  const requested = params.get('lib')
  if (requested && (LIB_NAMES as readonly string[]).includes(requested)) {
    return requested as LibName
  }
  return 'causl'
}

/**
 * A library-agnostic "world" handle. Mounting picks one of these per
 * variant; the harness loop knows nothing about the library beyond the
 * `bump` mutator, which advances cell `idx` to `value` using whatever
 * commit boundary the library exposes.
 */
interface World {
  /**
   * Render the 1000-cell viewport into the supplied container. The
   * mutator returned mutates cell `idx` to `value` per frame, using
   * the library-idiomatic transactional boundary.
   */
  render(container: HTMLElement): { bump(idx: number, value: number): void }
}

// -----------------------------------------------------------------------------
// causl variant
// -----------------------------------------------------------------------------

function CauslCell({ node }: { node: InputNode<number> }): JSX.Element {
  const value = useCauslNode(node)
  return <span>{value}</span>
}

function CauslViewport({ inputs }: { inputs: InputNode<number>[] }): JSX.Element {
  return (
    <div>
      {inputs.map((node, i) => (
        <CauslCell key={i} node={node} />
      ))}
    </div>
  )
}

function buildCauslWorld(): World {
  const graph: Graph = createCausl()
  const inputs: InputNode<number>[] = []
  for (let i = 0; i < CELL_COUNT; i++) {
    inputs.push(graph.input(`cell:${i}`, 0))
  }
  return {
    render(container) {
      const root = createRoot(container)
      root.render(
        <StrictMode>
          <CauslProvider graph={graph}>
            <CauslViewport inputs={inputs} />
          </CauslProvider>
        </StrictMode>,
      )
      return {
        bump(idx, value) {
          graph.commit('bump', (tx) => tx.set(inputs[idx]!, value))
        },
      }
    },
  }
}

// -----------------------------------------------------------------------------
// jotai variant
// -----------------------------------------------------------------------------

function JotaiCell({ atom }: { atom: PrimitiveAtom<number> }): JSX.Element {
  const value = useAtomValue(atom)
  return <span>{value}</span>
}

function JotaiViewport({
  atoms,
}: {
  atoms: PrimitiveAtom<number>[]
}): JSX.Element {
  return (
    <div>
      {atoms.map((a, i) => (
        <JotaiCell key={i} atom={a} />
      ))}
    </div>
  )
}

function buildJotaiWorld(): World {
  const store = createJotaiStore()
  const atoms: PrimitiveAtom<number>[] = []
  for (let i = 0; i < CELL_COUNT; i++) {
    atoms.push(atom(0))
  }
  return {
    render(container) {
      const root = createRoot(container)
      root.render(
        <StrictMode>
          <JotaiProvider store={store}>
            <JotaiViewport atoms={atoms} />
          </JotaiProvider>
        </StrictMode>,
      )
      return {
        bump(idx, value) {
          store.set(atoms[idx]!, value)
        },
      }
    },
  }
}

// -----------------------------------------------------------------------------
// redux variant — RTK slice + react-redux <Provider> + useSelector
// -----------------------------------------------------------------------------

interface ReduxState {
  readonly cells: number[]
}

const reduxSlice = createSlice({
  name: 'cells',
  initialState: {
    cells: Array.from({ length: CELL_COUNT }, () => 0),
  } as ReduxState,
  reducers: {
    bump(
      state,
      action: PayloadAction<{ idx: number; value: number }>,
    ) {
      state.cells[action.payload.idx] = action.payload.value
    },
  },
})

function ReduxCell({ idx }: { idx: number }): JSX.Element {
  const value = useSelector((state: ReduxState) => state.cells[idx]!)
  return <span>{value}</span>
}

function ReduxViewport(): JSX.Element {
  // Pre-flatten the index list so each <Cell> receives a stable prop
  // and React doesn't have to diff inline-allocated children. The
  // 1000-cell layout never changes after mount.
  const cells: JSX.Element[] = []
  for (let i = 0; i < CELL_COUNT; i++) {
    cells.push(<ReduxCell key={i} idx={i} />)
  }
  return <div>{cells}</div>
}

function buildReduxWorld(): World {
  // Disable RTK's default development middleware (Immer's
  // serializability check, action-immutability check, thunks). This
  // matches the production-parity decision documented in
  // `packages/bench/src/libraries/redux.ts` — the §14 gate is the
  // production cost an adopter shipping RTK actually pays.
  const store = configureStore({
    reducer: reduxSlice.reducer,
    middleware: () => new Tuple(),
  })
  return {
    render(container) {
      const root = createRoot(container)
      root.render(
        <StrictMode>
          <ReduxProvider store={store}>
            <ReduxViewport />
          </ReduxProvider>
        </StrictMode>,
      )
      return {
        bump(idx, value) {
          store.dispatch(reduxSlice.actions.bump({ idx, value }))
        },
      }
    },
  }
}

// -----------------------------------------------------------------------------
// mobx variant — observable.box + mobx-react-lite observer
// -----------------------------------------------------------------------------

interface MobxStore {
  readonly cells: IObservableValue<number>[]
}

const MobxCell = observer(function MobxCell({
  store,
  idx,
}: {
  store: MobxStore
  idx: number
}): JSX.Element {
  return <span>{store.cells[idx]!.get()}</span>
})

function MobxViewport({ store }: { store: MobxStore }): JSX.Element {
  const cells: JSX.Element[] = []
  for (let i = 0; i < CELL_COUNT; i++) {
    cells.push(<MobxCell key={i} store={store} idx={i} />)
  }
  return <div>{cells}</div>
}

function buildMobxWorld(): World {
  const cells: IObservableValue<number>[] = Array.from(
    { length: CELL_COUNT },
    () => observable.box(0),
  )
  const store: MobxStore = { cells }
  return {
    render(container) {
      const root = createRoot(container)
      root.render(
        <StrictMode>
          <MobxViewport store={store} />
        </StrictMode>,
      )
      return {
        bump(idx, value) {
          runInAction(() => {
            cells[idx]!.set(value)
          })
        },
      }
    },
  }
}

// -----------------------------------------------------------------------------
// Mount + harness wiring
// -----------------------------------------------------------------------------

function buildWorld(lib: LibName): World {
  switch (lib) {
    case 'causl':
      return buildCauslWorld()
    case 'jotai':
      return buildJotaiWorld()
    case 'redux':
      return buildReduxWorld()
    case 'mobx':
      return buildMobxWorld()
  }
}

const lib = resolveLib()
let mutator: { bump(idx: number, value: number): void } | null = null
// Mark the active library on the document so debugging can confirm
// the URL param survived the navigation and the right bundle path ran.
document.documentElement.dataset['lib'] = lib

/**
 * Mount once on module load. Subsequent `runHarness` calls reuse the
 * same React root + store — that matches the steady-state cell the
 * gate measures (the cost an adopter sees AFTER the first paint, not
 * the cold-start cost). The Playwright spec runs a discard warmup
 * before the timed run so JIT compile + first-render cost is excluded.
 */
function mount(): void {
  const container = document.getElementById('app')
  if (!container) {
    throw new Error('viewport-1000 fixture: #app container missing')
  }
  // We need to ensure ALL 4 library variants share an unused
  // `Root | null` reference for the GC. The actual `createRoot` and
  // any provider plumbing happens inside `world.render`.
  const world = buildWorld(lib)
  mutator = world.render(container)
}

mount()
// Suppress the unused-import lint for `Root`: declared so future
// variants that need direct root access have a typed handle without
// re-importing react-dom/client.
void (null as unknown as Root | null)

window.runHarness = function runHarness(
  durationMs: number,
  frequencyHz = 60,
): Promise<HarnessSamples> {
  if (!mutator) {
    return Promise.reject(new Error('viewport-1000 fixture: not mounted'))
  }
  const localBump = mutator.bump
  return new Promise<HarnessSamples>((resolve) => {
    const frameTimes: number[] = []
    const commitToPaint: number[] = []
    let committed = 0
    let lastCommitAt: number | null = null
    let nextCellIndex = 0
    const startedAt = performance.now()
    const targetFrameMs = 1000 / frequencyHz

    function tick(t: number): void {
      frameTimes.push(t)
      // If we recorded a commit-issue timestamp on the previous tick,
      // the time between then and now is the commit-to-paint sample
      // for that prior frame. The browser's compositor pipelines the
      // rAF callback after layout + paint of the previous commit, so
      // "time to next rAF" is the right proxy for "frame presented".
      if (lastCommitAt !== null) {
        commitToPaint.push(t - lastCommitAt)
      }

      const elapsed = t - startedAt
      if (elapsed >= durationMs) {
        resolve({ frameTimes, commitToPaint, committed, lib })
        return
      }

      // Issue exactly one commit per frame, bumping the next cell in
      // round-robin order. Mutating one input per frame matches the
      // §14 invariant the gate defends (a commit producing N
      // recomputations runs in O(N), not O(graph size)) and exercises
      // the per-cell-subscription path: only one cell's React
      // component re-renders per commit.
      const idx = nextCellIndex % CELL_COUNT
      const value = committed
      const commitAt = performance.now()
      localBump(idx, value)
      lastCommitAt = commitAt
      committed += 1
      nextCellIndex += 1

      // Use `requestAnimationFrame` directly — pinned to vsync. The
      // `targetFrameMs` parameter is kept in scope for future
      // sub-vsync pacing experiments but does not gate the loop today.
      void targetFrameMs
      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  })
}
