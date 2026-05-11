/**
 * tinybench nightly benchmarks for @causl/core (#146).
 *
 * Run with:  pnpm -F @causl/core bench
 * Baseline:  packages/core/bench/baseline.json
 *
 * Trend tracking is delta-against-baseline; CI fails on regressions
 * exceeding the threshold defined in the workspace tinybench script.
 */

import { Bench } from 'tinybench'
import { createCausl } from '../src/index.js'

export async function runBench(): Promise<Bench> {
  // `time` is per-sample run time, NOT warm-up. Without a warm-up
  // window, V8's first-execution overhead (parse, baseline → opt
  // tier-up) lands inside measurement and skews 100-node fan-in
  // numbers by ~2x. tinybench distinguishes the two: `warmupTime`
  // for JIT settling, `time` for the measured-sample budget.
  // See PR #195 review comments — P0.
  const bench = new Bench({ warmupTime: 200, time: 200 })

  bench.add('createCausl() — empty graph', () => {
    createCausl()
  })

  bench.add('100-node fan-in: bump-root commit', () => {
    const g = createCausl()
    const inputs = Array.from({ length: 100 }, (_, i) => g.input(`a${i}`, 0))
    g.derived('sum', (get) => inputs.reduce((acc, n) => acc + get(n), 0))
    const target = inputs[0]!
    g.commit('bump', (tx) => tx.set(target, 1))
  })

  bench.add('1000-node chain: bump head', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    let prev: import('../src/index.js').Node<number> = a
    for (let i = 0; i < 1000; i++) {
      const upstream: import('../src/index.js').Node<number> = prev
      const next: import('../src/index.js').Node<number> = g.derived<number>(
        `c${i}`,
        (get) => get(upstream) + 1,
      )
      prev = next
    }
    g.commit('bump', (tx) => tx.set(a, 1))
  })

  bench.add('subscribe + 100 commits', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    g.subscribe(a, () => undefined)
    for (let i = 0; i < 100; i++) {
      g.commit('bump', (tx) => tx.set(a, i))
    }
  })

  await bench.run()
  return bench
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBench().then((b) => {
    console.table(b.table())
  })
}
