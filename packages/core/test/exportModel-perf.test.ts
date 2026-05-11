/**
 * @packageDocumentation
 *
 * `graph.exportModel()` performance gate (EPIC #282 sub-issue #274).
 *
 * One of the bounded-model-checker acceptance criteria I committed to
 * is concrete and testable on the engine side today, even though the
 * checker itself is deferred to a future epic: the runtime overhead
 * of `exportModel()` must stay below 50ms for a graph of 1000 nodes
 * (measured). That number is part of the contract that lets
 * `causl-check` run in CI as a required green gate alongside `tsc`
 * — if the IR producer can't keep up at the documented bounds, the
 * checker can't run on every PR, and the whole pre-runtime detection
 * story falls over.
 *
 * The test uses `performance.now()` directly rather than tinybench
 * because we want a regression gate that runs in vitest, not a
 * nightly bench. This is the integration-tier of the testing strategy
 * — unit tests cover the obvious surfaces and React component tests
 * verify subscription scope; this one covers the worked example for
 * "the IR producer is fast enough to ship in CI." Multiple iterations
 * are taken and the median is compared against the threshold so
 * transient GC pauses or system jitter don't flake the gate.
 *
 * Wall-time gates are inherently host-dependent. The threshold is
 * generous enough to pass on developer laptops (Apple Silicon, x64
 * desktops) under typical load, while still catching the kind of
 * regression #274 is filed for: O(N²) exportModel implementations
 * that would balloon to multi-hundred-millisecond at 1000 nodes.
 */

import { describe, it, expect } from 'vitest'
import {
  createCausl,
  type Graph,
  type DerivedNode,
  type InputNode,
  type Node,
} from '../src/index.js'

/** Shape the perf gate measures against. */
interface PerfMeasurement {
  readonly samples: readonly number[]
  readonly median: number
  readonly p95: number
  readonly mean: number
}

/**
 * Run `op` `iterations` times after a configurable warm-up and return
 * a measurement summary. Warm-up runs are discarded — V8's first-
 * execution overhead would otherwise dominate the median.
 */
function measure(
  op: () => void,
  opts: { warmups: number; iterations: number },
): PerfMeasurement {
  // Warm-up: discarded.
  for (let i = 0; i < opts.warmups; i++) op()
  const samples: number[] = []
  for (let i = 0; i < opts.iterations; i++) {
    const t0 = performance.now()
    op()
    const t1 = performance.now()
    samples.push(t1 - t0)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  const p95 = sorted[Math.max(0, p95Idx)]!
  const mean = sorted.reduce((acc, v) => acc + v, 0) / sorted.length
  return { samples, median, p95, mean }
}

/**
 * Build a graph with a configurable mix of inputs and derived
 * nodes, totalling `n` registered nodes. Half inputs, half deriveds;
 * each derived sums two earlier nodes — a fan-in pattern that mimics
 * the kind of topology the bounded checker enumerates over
 * (orderings of pending async resolutions, message dispatches,
 * branches of conditional `derived` bodies).
 */
function buildGraph(n: number): {
  readonly graph: Graph
  readonly inputs: readonly InputNode<number>[]
  readonly deriveds: readonly DerivedNode<number>[]
} {
  const g = createCausl()
  const inputCount = Math.ceil(n / 2)
  const derivedCount = n - inputCount
  const inputs: InputNode<number>[] = []
  for (let i = 0; i < inputCount; i++) {
    inputs.push(g.input(`in:${i}`, i))
  }
  const deriveds: DerivedNode<number>[] = []
  for (let i = 0; i < derivedCount; i++) {
    // Two-input fan-in: pick two prior nodes deterministically so
    // the topology is reproducible across runs.
    const upstreamA: Node<number> =
      inputs[i % inputs.length]! as Node<number>
    const upstreamB: Node<number> =
      i === 0
        ? (inputs[(i + 1) % inputs.length]! as Node<number>)
        : (deriveds[i - 1]! as Node<number>)
    deriveds.push(
      g.derived<number>(
        `d:${i}`,
        (get) => get(upstreamA) + get(upstreamB),
      ),
    )
  }
  return { graph: g, inputs, deriveds }
}

describe('exportModel() perf gate (EPIC #282 / #274)', () => {
  /**
   * The headline promise: 50ms / 1000-node export, the documented
   * acceptance bound for the bounded-model-checker pipeline. The
   * threshold has 50% slack over that bound so transient jitter
   * doesn't flake the gate; a real regression (e.g. O(N²) dependency
   * scan) would push median past 100ms easily.
   */
  describe('1000-node graph', () => {
    /**
     * Median exportModel time on a 1000-node graph stays under the
     * documented bound (50ms; we gate at 75ms to absorb CI noise — a
     * real O(N²) regression would exceed both).
     */
    it('exportModel median under 75ms over 50 iterations', () => {
      // arrange: build the graph once
      const { graph } = buildGraph(1000)
      // Sanity: graph actually has 1000 nodes.
      expect(graph.exportModel().nodes.length).toBe(1000)

      // act: measure
      const result = measure(() => graph.exportModel(), {
        warmups: 5,
        iterations: 50,
      })

      // assert: median below threshold
      expect(
        result.median,
        `median ${result.median.toFixed(2)}ms; samples ${result.samples
          .slice(0, 5)
          .map((n) => n.toFixed(2))
          .join(', ')}…`,
      ).toBeLessThan(75)
    })

    /**
     * Sanity bound on the long tail too — p95 should be under 150ms
     * even with GC noise. A regression where exportModel allocates
     * pathologically would surface here as p95 spiking.
     */
    it('exportModel p95 under 150ms over 50 iterations', () => {
      const { graph } = buildGraph(1000)
      const result = measure(() => graph.exportModel(), {
        warmups: 5,
        iterations: 50,
      })
      expect(
        result.p95,
        `p95 ${result.p95.toFixed(2)}ms; max ${Math.max(...result.samples).toFixed(2)}ms`,
      ).toBeLessThan(150)
    })

    /**
     * Returned IR is byte-stable across iterations — exportModel
     * must be a pure read of engine state (no allocation-dependent
     * ordering, no mutation of the graph). Without this, a perf
     * regression could mask itself by silently dropping fields.
     */
    it('exportModel returns byte-equal IR across repeated calls', () => {
      const { graph } = buildGraph(1000)
      const a = JSON.stringify(graph.exportModel())
      const b = JSON.stringify(graph.exportModel())
      expect(a).toBe(b)
    })
  })

  /**
   * Smaller graphs should run well under the bound — these
   * regression-gate the constant-factor cost of the export
   * pipeline, not just the per-node scaling.
   */
  describe('100-node graph (constant factor)', () => {
    /**
     * A 100-node graph should export in well under 10ms median.
     * A 50ms+ median at 100 nodes signals an O(N²) bug.
     */
    it('exportModel median under 10ms', () => {
      const { graph } = buildGraph(100)
      expect(graph.exportModel().nodes.length).toBe(100)
      const result = measure(() => graph.exportModel(), {
        warmups: 5,
        iterations: 50,
      })
      expect(
        result.median,
        `median ${result.median.toFixed(2)}ms`,
      ).toBeLessThan(10)
    })
  })

  /**
   * Scale check: doubling N must not multiply export time by more
   * than 2.5×. This is the loose linear-scaling gate that catches
   * O(N log N) → O(N²) regressions.
   */
  describe('linear-scaling gate', () => {
    /**
     * Compare 500-node vs 1000-node export times. If 1000-node is
     * more than 3× slower than 500-node, exportModel has a
     * super-linear hot spot.
     */
    it('1000-node export is at most 3× slower than 500-node export', () => {
      const small = buildGraph(500)
      const big = buildGraph(1000)
      const smallMeasure = measure(() => small.graph.exportModel(), {
        warmups: 5,
        iterations: 30,
      })
      const bigMeasure = measure(() => big.graph.exportModel(), {
        warmups: 5,
        iterations: 30,
      })
      // Sub-millisecond timings are noise-dominated — a 0.02ms /
      // 0.07ms divide is meaningless for super-linear regression
      // detection. Fall back to an absolute upper bound when the
      // 500-node baseline is too small to use as a denominator.
      const NOISE_FLOOR_MS = 1
      if (smallMeasure.median < NOISE_FLOOR_MS) {
        expect(
          bigMeasure.median,
          `1000-node median ${bigMeasure.median.toFixed(2)}ms below noise floor — regression would still need to be slow in absolute terms`,
        ).toBeLessThan(20)
        return
      }
      const ratio = bigMeasure.median / smallMeasure.median
      expect(
        ratio,
        `1000-node median ${bigMeasure.median.toFixed(2)}ms vs 500-node ${smallMeasure.median.toFixed(2)}ms (ratio ${ratio.toFixed(2)})`,
      ).toBeLessThan(3)
    })
  })

  /**
   * Self-check: the measurement helper itself is correct. Without
   * this, the perf gate could "pass" because the timing harness
   * silently no-ops.
   */
  describe('harness self-checks', () => {
    /**
     * `measure()` actually runs the operation `iterations` times.
     */
    it('measure() invokes op the requested number of times', () => {
      let count = 0
      const result = measure(
        () => {
          count++
        },
        { warmups: 3, iterations: 20 },
      )
      expect(count).toBe(23) // warmups + iterations
      expect(result.samples.length).toBe(20)
    })

    /**
     * `measure()` returns ordered statistics: median ≤ p95.
     */
    it('measure() median is no greater than p95', () => {
      // Synthesise a varying workload by busy-waiting a small amount.
      const result = measure(
        () => {
          const start = performance.now()
          while (performance.now() - start < Math.random() * 0.5) {
            /* spin */
          }
        },
        { warmups: 2, iterations: 30 },
      )
      expect(result.median).toBeLessThanOrEqual(result.p95)
    })

    /**
     * buildGraph(N) yields exactly N registered nodes, regardless
     * of the input/derived split.
     */
    it('buildGraph(N) registers exactly N nodes for N in [10, 100, 500, 1000]', () => {
      for (const n of [10, 100, 500, 1000]) {
        const { graph } = buildGraph(n)
        expect(graph.exportModel().nodes.length, `N=${n}`).toBe(n)
      }
    })
  })
})
