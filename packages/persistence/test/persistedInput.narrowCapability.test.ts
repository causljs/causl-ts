/**
 * @packageDocumentation
 *
 * Capability-narrowing contract for {@link persistedInput} — closes #257.
 *
 * Persistence is the canonical SPEC §13 leak-fence case: a storage
 * adapter crosses a trust boundary and must receive only the authority
 * its job requires. `persistedInput` registers exactly one input,
 * watches the commit stream for changes to that input, and serialises
 * the new value to the adapter — so the engine handle it accepts must
 * carry only `input`, `subscribeCommits`, and `read`.
 *
 * The narrowing is type-level: the function parameter is a `Pick`
 * subset of `Graph`, and `// @ts-expect-error` directives lock
 * forbidden methods (`commit`, `derived`, `hydrate`, `snapshot`,
 * `exportModel`, …) out of reach. If a future change broadens the
 * parameter, the directives stop being errors and this file fails to
 * type-check.
 */

import type { Graph } from '@causljs/core'
import { describe, it } from 'vitest'
import type { persistedInput } from '../src/persistedInput.js'

describe('persistedInput — narrowed capability (compile-time)', () => {
  /**
   * The narrowed surface must still expose `input` (registers the
   * persisted node), `subscribeCommits` (drives writes), and `read`
   * (reads the post-commit value to serialise). Removing any breaks
   * the implementation; locking them in keeps the surface honest.
   */
  it('keeps the registration + commit-stream + read methods reachable', () => {
    type GraphParam = Parameters<typeof persistedInput>[0]
    type Required = Pick<Graph, 'input' | 'subscribeCommits' | 'read'>
    // The narrowed parameter must include at least the methods the
    // implementation calls — assignability in this direction proves the
    // capability is sufficient for the function to do its job.
    const _sufficient: (g: Required) => GraphParam = (g) => g
    void _sufficient
  })

  /**
   * Authority leak surface — none of these methods belong on a
   * persistence adapter. Each `// @ts-expect-error` is a structural
   * lock: removing the narrowing makes the directive unused and breaks
   * the type-check.
   *
   * Body wrapped in an unreachable `if` so the type-checker still
   * inspects every line while the runtime never dereferences the
   * sentinel value.
   */
  it('rejects mutation, time-travel, hydration, and admin authority', () => {
    type GraphParam = Parameters<typeof persistedInput>[0]
    const graph = null as unknown as GraphParam
    // The `if (false)` gate keeps this body unreachable at runtime so
    // `graph` is never dereferenced; TypeScript still type-checks every
    // line, which is the point of the `// @ts-expect-error` directives.
    const ALWAYS_FALSE: boolean = false
    if (ALWAYS_FALSE) {
      // @ts-expect-error commit is not a persistence-adapter capability.
      graph.commit('hack', () => undefined)
      // @ts-expect-error derived registration belongs to authoring code, not persistence.
      graph.derived('x', () => 0)
      // @ts-expect-error hydrate is the engine-side counterpart and must not be reachable from persistence.
      graph.hydrate({ schema: 1, time: 0, inputs: {} })
      // @ts-expect-error snapshot belongs to SSR/devtools, not the per-input persister.
      graph.snapshot()
      // @ts-expect-error exportModel must not be reachable from a storage adapter.
      graph.exportModel()
      // @ts-expect-error subscribe (per-node) is not used by persistedInput — only subscribeCommits.
      graph.subscribe(null as never, () => undefined)
      // @ts-expect-error explain belongs to devtools.
      graph.explain(null as never)
      // @ts-expect-error readAt is time-travel.
      graph.readAt(null as never, 0)
      // @ts-expect-error snapshotAt is time-travel.
      graph.snapshotAt(0)
      // @ts-expect-error commitLog is the devtools seam.
      void graph.commitLog
      // @ts-expect-error now is a devtools/inspector concern.
      void graph.now
    }
  })

  /**
   * Structural narrowing — a full `Graph` is still a valid argument
   * (call sites keep working) but the parameter type is a strict
   * subset and cannot be widened back to `Graph` without an explicit
   * cast.
   */
  it('is structurally narrower than Graph', () => {
    type GraphParam = Parameters<typeof persistedInput>[0]
    // A full Graph satisfies the narrowed parameter.
    const _accepts: (g: Graph) => GraphParam = (g) => g
    void _accepts
    // @ts-expect-error narrowing must be strict — GraphParam is a proper subset of Graph.
    const _widensBack: (g: GraphParam) => Graph = (g) => g
    void _widensBack
  })
})
