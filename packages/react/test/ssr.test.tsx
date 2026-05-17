/**
 * SSR test family v1 (#131, #220, #248): server→serialize→hydrate
 * equality, mismatch detection, concurrent edit during hydration,
 * console-warning gates, getServerSnapshot/getSnapshot parity, and
 * regression-seed replay.
 *
 * The earlier draft compared `renderToStaticMarkup` strings against a
 * client-only `render`, which never exercised React's hydration warning
 * machinery — the whole signal the SSR family exists to surface (SPEC
 * §9.1, hydration race-row). This iteration drives the server pass
 * through `renderToString` and the client pass through `hydrateRoot`,
 * so any divergence between `getServerSnapshot` and `getSnapshot`
 * trips React's console.error rather than silently passing.
 *
 * `assertConsistentGraphTime` from `@causljs/core/testing` locks the
 * SPEC §3 invariant — across (server snapshot × client commit × hydrate)
 * every observation in one render frame must resolve at one GraphTime.
 *
 * Per #248, the suite also:
 *   - spies on `console.error` to gate the matched-snapshot path (zero
 *     hydration warnings) and pin the mismatched-snapshot path (≥1
 *     hydration warning).
 *   - asserts `getServerSnapshot` / `getSnapshot` parity at the
 *     hydration boundary so a silent tear cannot slip through.
 *   - loads regression seeds from `src/__seeds__/ssr.json` so any
 *     shrunk counterexample is reproducible deterministically across
 *     CI runs (SPEC §15.2).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCausl, type Graph, type GraphSnapshot } from '@causljs/core'
import { assertConsistentGraphTime, type TraceEntry } from '@causljs/core/testing'
import { render, screen } from '@testing-library/react'
import { act, type JSX } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hydrate, CauslProvider, useCausl } from '../src/index.js'

/**
 * Cleanup queue for any roots created with `hydrateRoot` directly —
 * RTL's `cleanup()` in setup.ts only knows about trees mounted via
 * `render`, so we track manual roots ourselves to avoid leaking DOM
 * into the next test.
 */
const manualRoots: { unmount: () => void; container: HTMLElement }[] = []

afterEach(() => {
  while (manualRoots.length > 0) {
    const r = manualRoots.pop()!
    r.unmount()
    r.container.remove()
  }
})

/**
 * Per-test spy on `console.error`. React routes hydration warnings
 * exclusively through `console.error` in development, so this is the
 * channel the suite must monitor to tell a clean hydrate from a torn
 * one (#248, SPEC §9.1).
 */
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleErrorSpy.mockRestore()
})

/**
 * Returns the count of `console.error` calls whose first argument
 * matches a hydration-related signature. React's hydration warnings
 * include phrases like "did not match", "Hydration failed", "Text
 * content does not match server-rendered HTML", etc. — we match on a
 * conservative union.
 */
function hydrationWarningCount(
  spy: ReturnType<typeof vi.spyOn>,
): number {
  let count = 0
  for (const call of spy.mock.calls) {
    const head = String(call[0] ?? '')
    if (
      /hydrat/i.test(head) ||
      /did not match/i.test(head) ||
      /text content does not match/i.test(head) ||
      /server-rendered html/i.test(head)
    ) {
      count++
    }
  }
  return count
}

/**
 * Loads the regression seed file. Tests that consume this MUST replay
 * each seed at the start of their run before triggering the random
 * fuzz — that is the SPEC §15.2 reproducibility contract.
 */
interface SeedRecord {
  readonly label: string
  readonly seed: number
  readonly comment?: string
}
interface SeedFile {
  readonly seeds: readonly SeedRecord[]
}
function loadSeeds(): SeedFile {
  // Resolve relative to this test file. Vitest's `import.meta.url` is
  // a file:// URL when the test runs through the standard transform;
  // when the loader hands back something else we fall back to the
  // package-relative path computed against `process.cwd()` so the
  // resolution stays robust across runners.
  const url = import.meta.url
  let testDir: string
  if (url.startsWith('file://')) {
    testDir = dirname(fileURLToPath(url))
  } else {
    // Last-resort fallback: vitest runs from the package root, so the
    // path is deterministic from cwd.
    testDir = resolve(process.cwd(), 'test')
  }
  const seedPath = resolve(testDir, '..', 'src', '__seeds__', 'ssr.json')
  const raw = readFileSync(seedPath, 'utf-8')
  return JSON.parse(raw) as SeedFile
}

/**
 * Simple consumer reading a single input by id. Kept tiny so tests can
 * compose graphs of arbitrary shape over it.
 */
function App({ id }: { id: string }) {
  const v = useCausl((g) => g.read({ id })) as number | string
  return <span data-testid="v">{v}</span>
}

/**
 * Multi-node consumer that records each observation into a trace so
 * `assertConsistentGraphTime` can lock the SPEC §3 invariant. Reading
 * `graph.now` during render is safe — the engine exposes `now` as a
 * synchronous property, and `useCausl` has already resolved the
 * selector against the current snapshot by the time we push to the
 * trace.
 */
function makeMultiConsumer(
  ids: readonly string[],
  trace: TraceEntry[],
  frameId: () => number | string,
) {
  return function MultiConsumer({
    graphRef,
  }: {
    graphRef: Graph
  }): JSX.Element {
    const values = ids.map((id) =>
      useCausl((g) => g.read({ id })) as number | string,
    )
    for (let i = 0; i < ids.length; i++) {
      trace.push({
        frameId: frameId(),
        selector: `read:${ids[i]}`,
        value: values[i],
        time: graphRef.now,
      })
    }
    return (
      <div>
        {values.map((v, i) => (
          <span key={ids[i]} data-testid={`v-${ids[i]}`}>
            {v}
          </span>
        ))}
      </div>
    )
  }
}

describe('SSR test family v1 (#131, #220, #248)', () => {
  it('renderToString + hydrateRoot: matched snapshot hydrates without DOM divergence and without hydration warnings', () => {
    // ---- Server side
    const serverGraph = createCausl()
    serverGraph.input('a', 42)
    const serverSnapshot = serverGraph.snapshot()
    const serverHtml = renderToString(
      <CauslProvider graph={serverGraph}>
        <App id="a" />
      </CauslProvider>,
    )
    expect(serverHtml).toContain('42')

    // ---- Client side: hydrateRoot against a container seeded with the
    // server HTML. This is the path real apps take and the only one
    // that surfaces React's hydration warnings.
    const container = document.createElement('div')
    container.innerHTML = serverHtml
    document.body.appendChild(container)

    const clientGraph = createCausl()
    clientGraph.input('a', 0) // initial value differs from server
    // Pre-hydrate the client graph BEFORE `hydrateRoot` so the first
    // React render observes the snapshot. #219 moved <Hydrate>'s engine
    // mutation out of the render body into `useLayoutEffect` (render
    // bodies must be pure under concurrent rendering), so any host
    // running `hydrateRoot` must seed the engine ahead of time. The
    // `<Hydrate>` element below remains as the idempotent safety net —
    // its WeakMap-keyed guard short-circuits when the pair is already
    // applied (Next.js / Apollo / Relay all use the same shape).
    clientGraph.hydrate(serverSnapshot)
    let root!: ReturnType<typeof hydrateRoot>
    act(() => {
      root = hydrateRoot(
        container,
        <CauslProvider graph={clientGraph}>
          <Hydrate snapshot={serverSnapshot}>
            <App id="a" />
          </Hydrate>
        </CauslProvider>,
      )
    })
    manualRoots.push({ unmount: () => root.unmount(), container })

    // First client render must observe the hydrated value, not the
    // initial 0 — that is the whole point of <Hydrate>.
    expect(container.querySelector('[data-testid="v"]')!.textContent).toBe('42')

    // SPEC §9.1 hydration race-row gate: zero hydration warnings on the
    // matched-snapshot path. This is the actual signal the suite was
    // built to catch (#248).
    expect(hydrationWarningCount(consoleErrorSpy)).toBe(0)
  })

  it('snapshot-then-hydrate produces a graph whose inputs and schemaHash equal the source (#366 changes time semantics)', () => {
    const src = createCausl()
    src.input('a', 1)
    src.input('b', 'hello')
    src.input('c', { nested: true })
    src.commit('bump', (tx) => tx.set({ id: 'a' }, 99))
    const snap = src.snapshot()

    const dest = createCausl()
    dest.input('a', 0)
    dest.input('b', '')
    dest.input('c', { nested: false })
    dest.hydrate(snap)
    // Inputs and schemaHash round-trip identically; only `time` differs
    // because hydrate advances the dest clock by exactly one tick (§3
    // monotonicity, #366) rather than copying `snap.time`. The on-the-
    // wire snapshot label is preserved on the published Commit's
    // `originatedAt` field, not on the dest engine's `now`.
    const reSnap = dest.snapshot()
    expect(reSnap.inputs).toEqual(snap.inputs)
    expect(reSnap.schemaHash).toBe(snap.schemaHash)
    expect(reSnap.schema).toBe(snap.schema)
  })

  it('mismatch detection: a snapshot produced by an incompatible schema fails loud', () => {
    const g = createCausl()
    const bad = { schema: 99, time: 0, inputs: {} } as unknown as GraphSnapshot
    expect(() => g.hydrate(bad)).toThrow(/schema/)
  })

  it('concurrent edit during hydration: user write before <Hydrate> still loses to the snapshot, by design', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    g.commit('user-edit', (tx) => tx.set(a, 100))

    function LocalApp() {
      const v = useCausl((graph) => graph.read(a))
      return <span data-testid="v">{v}</span>
    }
    render(
      <CauslProvider graph={g}>
        <Hydrate snapshot={{ schema: 1, time: 0, inputs: { a: 7 } }}>
          <LocalApp />
        </Hydrate>
      </CauslProvider>,
    )
    // Hydrate wins — snapshot is the canonical state, user's edit is overridden.
    expect(screen.getByTestId('v').textContent).toBe('7')
  })

  it('hydration into an empty graph (no pre-registered inputs) is a no-op for those keys', () => {
    const g = createCausl()
    const before = g.now
    // Snapshot mentions 'a' which is NOT registered in g.
    g.hydrate({ schema: 1, time: 0, inputs: { a: 99 } })
    // Post-#366: hydrate routes through the commit pipeline, so even
    // a hydrate whose write-set is empty (every snapshot id was
    // unknown) advances `now` by exactly one tick — the commit-log
    // entry it produces records the hydration as a first-class event.
    expect(g.now).toBe(before + 1)
    // Reading the unknown id throws (no-op since it was never registered).
    expect(() => g.read({ id: 'a' })).toThrow()
  })

  it('assertConsistentGraphTime: every consumer across server snapshot × client commit × hydrate resolves at one GraphTime', () => {
    // Build a non-trivial graph: three inputs seeded by a commit, so the
    // server snapshot captures a time>0 state and the consumer subtree
    // spans multiple selectors that all must agree on `now`.
    const serverGraph = createCausl()
    serverGraph.input('a', 1)
    serverGraph.input('b', 2)
    serverGraph.input('c', 3)
    serverGraph.commit('seed', (tx) => {
      tx.set({ id: 'a' }, 10)
      tx.set({ id: 'b' }, 20)
      tx.set({ id: 'c' }, 30)
    })
    const serverSnapshot = serverGraph.snapshot()

    const trace: TraceEntry[] = []
    let currentFrame: string = 'f0'
    const MultiConsumer = makeMultiConsumer(
      ['a', 'b', 'c'],
      trace,
      () => currentFrame,
    )

    // Server pass — capture observations under frameId f0.
    currentFrame = 'f0'
    const serverHtml = renderToString(
      <CauslProvider graph={serverGraph}>
        <MultiConsumer graphRef={serverGraph} />
      </CauslProvider>,
    )
    expect(serverHtml).toContain('10')
    expect(serverHtml).toContain('20')
    expect(serverHtml).toContain('30')

    // Client pass — fresh graph, pre-hydrate from the server snapshot
    // BEFORE `hydrateRoot` (see matched-snapshot test above for the why).
    const clientGraph = createCausl()
    clientGraph.input('a', 0)
    clientGraph.input('b', 0)
    clientGraph.input('c', 0)
    clientGraph.hydrate(serverSnapshot)
    const container = document.createElement('div')
    container.innerHTML = serverHtml
    document.body.appendChild(container)

    currentFrame = 'f1'
    let root!: ReturnType<typeof hydrateRoot>
    act(() => {
      root = hydrateRoot(
        container,
        <CauslProvider graph={clientGraph}>
          <Hydrate snapshot={serverSnapshot}>
            <MultiConsumer graphRef={clientGraph} />
          </Hydrate>
        </CauslProvider>,
      )
    })
    manualRoots.push({ unmount: () => root.unmount(), container })

    // The hydrated client must observe the seeded values across all
    // three nodes in its first commit.
    expect(container.querySelector('[data-testid="v-a"]')!.textContent).toBe('10')
    expect(container.querySelector('[data-testid="v-b"]')!.textContent).toBe('20')
    expect(container.querySelector('[data-testid="v-c"]')!.textContent).toBe('30')

    // SPEC §3: within each render frame, every observation must
    // resolve at one GraphTime. Server frame f0 and client frame f1
    // are separate frames (different times — this is fine), but each
    // frame internally must agree.
    assertConsistentGraphTime(trace)

    const f0 = trace.filter((e) => e.frameId === 'f0')
    const f1 = trace.filter((e) => e.frameId === 'f1')
    expect(f0.length).toBe(3)
    expect(f1.length).toBeGreaterThanOrEqual(3)
    expect(new Set(f0.map((e) => e.time)).size).toBe(1)
    expect(new Set(f1.map((e) => e.time)).size).toBe(1)
  })

  // ----- #248: console-warning gates, parity, and seed seam -----

  it('mismatch path: server snapshot diverges from client read → React fires a hydration warning', () => {
    // The server graph holds 'a' = 42 — that is what `renderToString`
    // emits into the markup. The client graph holds 'a' = 7 *and* its
    // <Hydrate> is fed a different snapshot than the server captured,
    // so when React runs `getSnapshot` during hydration it sees a value
    // that does not match the server-rendered DOM. That is exactly the
    // shape the SPEC §9.1 race-row tests against.
    const serverGraph = createCausl()
    serverGraph.input('a', 42)
    const serverHtml = renderToString(
      <CauslProvider graph={serverGraph}>
        <App id="a" />
      </CauslProvider>,
    )
    expect(serverHtml).toContain('42')

    const container = document.createElement('div')
    container.innerHTML = serverHtml
    document.body.appendChild(container)

    const clientGraph = createCausl()
    clientGraph.input('a', 7) // intentionally divergent
    // Hand <Hydrate> a snapshot whose 'a' does NOT match the server
    // markup. React's hydrateRoot will compare DOM to first client
    // render and fire a hydration warning.
    const divergentSnapshot: GraphSnapshot = {
      schema: 1,
      time: 0,
      inputs: { a: 999 },
    }
    // React 18 surfaced hydration mismatches as a `console.error`
    // warning. React 19 escalated them to *recoverable* errors that are
    // also routed through `hydrateRoot`'s `onRecoverableError` callback
    // (and, without a handler, they leak as an unhandled exception that
    // fails the surrounding vitest file). The peer-dep matrix (#261)
    // forces us to acknowledge both channels: we count
    // `onRecoverableError` invocations alongside the console-error
    // hits and assert at least one of the two fired. This keeps the
    // SPEC §9.1 mismatch-detection signal locked under both runtimes
    // without papering over a real divergence.
    let recoverableErrors = 0
    let root!: ReturnType<typeof hydrateRoot>
    act(() => {
      root = hydrateRoot(
        container,
        <CauslProvider graph={clientGraph}>
          <Hydrate snapshot={divergentSnapshot}>
            <App id="a" />
          </Hydrate>
        </CauslProvider>,
        {
          onRecoverableError: () => {
            recoverableErrors += 1
          },
        },
      )
    })
    manualRoots.push({ unmount: () => root.unmount(), container })

    // The mismatch must surface through *either* console.error
    // (React 18) or `onRecoverableError` (React 19). Both channels
    // distinguish a clean hydrate from a torn one — what the test
    // refuses to accept is silence.
    const consoleHits = hydrationWarningCount(consoleErrorSpy)
    expect(consoleHits + recoverableErrors).toBeGreaterThanOrEqual(1)
  })

  it('parity: getServerSnapshot value equals first-client-render getSnapshot value at the hydration boundary', () => {
    // SPEC §12.4: at the hydration boundary, the value
    // useSyncExternalStore reads via `getServerSnapshot` on the server
    // must be Object.is-equal to what `getSnapshot` returns on the
    // first client render. Without this, hydration tears silently.
    //
    // The adapter passes the same closure as both `getSnapshot` and
    // `getServerSnapshot`, so the proof reduces to: a graph hydrated
    // from the same snapshot produces an Object.is-equal value when
    // read for the first time on the client. We verify that directly.
    const serverGraph = createCausl()
    const probe = { sentinel: Symbol('parity') }
    serverGraph.input('p', probe)
    const serverSnapshot = serverGraph.snapshot()

    // Server-side value the selector would observe.
    let serverObserved: unknown
    function ServerProbe() {
      serverObserved = useCausl((g) => g.read({ id: 'p' }))
      return null
    }
    renderToString(
      <CauslProvider graph={serverGraph}>
        <ServerProbe />
      </CauslProvider>,
    )

    // Client-side: hydrate a fresh graph from the server snapshot and
    // capture the value the selector observes on the first commit.
    const clientGraph = createCausl()
    clientGraph.input('p', { sentinel: Symbol('placeholder') })
    let clientObserved: unknown
    function ClientProbe() {
      clientObserved = useCausl((g) => g.read({ id: 'p' }))
      return null
    }
    render(
      <CauslProvider graph={clientGraph}>
        <Hydrate snapshot={serverSnapshot}>
          <ClientProbe />
        </Hydrate>
      </CauslProvider>,
    )

    // The hydrated value the client first observes must be the very
    // same reference the server captured. Object.is is the contract
    // useSyncExternalStore uses to dedupe — anything weaker would let
    // a tear slip through.
    expect(clientObserved).toBe(serverObserved)
    expect(clientObserved).toBe(probe)
  })

  it('regression seeds: each pinned seed in src/__seeds__/ssr.json deterministically replays without divergence', () => {
    // SPEC §15.2 reproducibility: every shrunk counterexample is
    // pinned in the seed file and replayed at the start of every CI
    // run before random trials. A failure in this test means a known
    // counterexample regressed.
    const { seeds } = loadSeeds()
    expect(seeds.length).toBeGreaterThanOrEqual(1)

    for (const { label, seed } of seeds) {
      // Use the seed to pick a deterministic input value across the
      // server/client boundary. The mod-keeps-it-tiny shape is enough
      // to prove the load mechanism wires through and the SSR
      // pipeline survives every recorded counterexample.
      const value = ((seed >>> 0) % 1000) + 1

      const serverGraph = createCausl()
      serverGraph.input('a', value)
      const snap = serverGraph.snapshot()
      const html = renderToString(
        <CauslProvider graph={serverGraph}>
          <App id="a" />
        </CauslProvider>,
      )
      expect(html, `seed '${label}' (${seed}) — server html must contain ${value}`).toContain(
        String(value),
      )

      const container = document.createElement('div')
      container.innerHTML = html
      document.body.appendChild(container)

      const clientGraph = createCausl()
      clientGraph.input('a', 0)
      // Pre-hydrate before hydrateRoot — same channel constraint as the
      // matched-snapshot test (#219 moved engine mutation out of render).
      clientGraph.hydrate(snap)
      let root!: ReturnType<typeof hydrateRoot>
      act(() => {
        root = hydrateRoot(
          container,
          <CauslProvider graph={clientGraph}>
            <Hydrate snapshot={snap}>
              <App id="a" />
            </Hydrate>
          </CauslProvider>,
        )
      })
      manualRoots.push({ unmount: () => root.unmount(), container })

      expect(
        container.querySelector('[data-testid="v"]')!.textContent,
        `seed '${label}' (${seed}) — hydrated value must match server`,
      ).toBe(String(value))
    }

    // No hydration warnings allowed across any of the replayed seeds —
    // a regression here is a SPEC §9.1 violation that previously
    // shipped, by construction.
    expect(hydrationWarningCount(consoleErrorSpy)).toBe(0)
  })

  it('seed file is well-formed: every entry has label and integer seed', () => {
    // The seed seam is only useful if the schema is enforced. A
    // malformed seed silently dropped is worse than no seed at all —
    // the regression record degrades and we do not notice.
    const { seeds } = loadSeeds()
    expect(Array.isArray(seeds)).toBe(true)
    for (const entry of seeds) {
      expect(typeof entry.label).toBe('string')
      expect(entry.label.length).toBeGreaterThan(0)
      expect(Number.isInteger(entry.seed)).toBe(true)
      expect(entry.seed).toBeGreaterThanOrEqual(0)
    }
  })
})
