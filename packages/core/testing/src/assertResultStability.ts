/**
 * assertResultStability — referential stability gate for `useSyncExternalStore`.
 *
 * React's `useSyncExternalStore` requires `getSnapshot` to return a
 * referentially stable value when nothing has changed. If the snapshot
 * returns a new reference on every call, React enters a render loop.
 *
 * This helper wraps a `getSnapshot` function, calls it twice in
 * succession (with no intervening commit), and asserts the two return
 * values are referentially identical (`Object.is`).
 *
 * Why this is the right test: the bug it catches is the one that takes
 * a week to find in production — a render-loop spinner that maxes out
 * the CPU on what looks like a quiet page.
 *
 * Usage (vitest):
 *
 *   it('useCausl returns a stable reference between renders', () => {
 *     assertResultStability({
 *       getSnapshot: () => store.getSnapshot()
 *     })
 *   })
 *
 *   it('useCausl with a selector returns a stable reference', () => {
 *     assertResultStability({
 *       getSnapshot: () => store.getSnapshot()((g) => g.read(node))
 *     })
 *   })
 */

export class ResultInstability extends Error {
  readonly first: unknown
  readonly second: unknown
  constructor(first: unknown, second: unknown) {
    super(
      `getSnapshot returned a fresh reference between back-to-back calls ` +
        `with no intervening commit. React's useSyncExternalStore will enter a ` +
        `render loop. First: ${describe(first)}, Second: ${describe(second)}.`,
    )
    this.name = 'ResultInstability'
    this.first = first
    this.second = second
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'object') return `[object ${Object.prototype.toString.call(v)}]`
  return JSON.stringify(v)
}

export interface StabilityProbe<T> {
  /** Called twice in succession; must return the same reference. */
  getSnapshot: () => T
  /**
   * Optional equality. Defaults to `Object.is`. Pass a structural
   * comparator only if the snapshot type is documented as
   * structurally-stable; the default catches the common foot-gun.
   */
  equals?: (a: T, b: T) => boolean
}

export function assertResultStability<T>(probe: StabilityProbe<T>): void {
  const equals = probe.equals ?? Object.is
  const first = probe.getSnapshot()
  const second = probe.getSnapshot()
  if (!equals(first, second)) {
    throw new ResultInstability(first, second)
  }
}
