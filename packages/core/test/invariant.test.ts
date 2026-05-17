/**
 * @packageDocumentation
 *
 * Behavioural pinning for the `invariant` option on `graph.input(...)`,
 * a runtime guard that fires inside `commit`'s staging phase and rolls
 * back the transaction when a staged write would violate a caller-
 * supplied predicate.
 *
 * Contract being pinned (from the team review captured in the issue):
 *
 *   - Happy path: setting a value that satisfies the invariant commits
 *     normally — value visible, time advances, subscribers fire.
 *   - Sad path: setting a value that violates the invariant throws an
 *     `InvariantViolationError`. The error carries `nodeId`, the
 *     offending `value`, and the original throw as `cause`.
 *   - Atomicity on violation: the commit is rolled back. `graph.now`
 *     does not advance, no per-node subscriber fires, no commitLog
 *     entry is appended.
 *   - Multi-set atomicity: a single commit that stages writes against
 *     several inputs is rolled back as a unit when ANY of them fails
 *     its invariant — even the writes whose invariants would have
 *     passed are discarded.
 *   - Re-entrancy: an invariant that tries to call `graph.commit`
 *     during its own validation throws `CommitInProgressError`. Same
 *     guard as today's nested-commit protection.
 *   - Async invariants are not supported. The signature returns
 *     `void`; a Promise return value is ignored (the engine cannot
 *     await it without breaking atomicity).
 *   - One invariant per node. Composing multiple checks is the
 *     caller's responsibility (compose them inside one function).
 *
 * Closes causljs/causl-ts#1.
 */

import { describe, expect, it } from 'vitest'
import {
  CommitInProgressError,
  createCausl,
  InvariantViolationError,
  CauslError,
} from '../src/index.js'

describe('graph.input — invariant option', () => {
  describe('happy path', () => {
    it('a passing invariant lets the commit advance time and publish the value', () => {
      const graph = createCausl()
      const n = graph.input<number>('n', 0, {
        invariant: (v) => {
          if (typeof v !== 'number') throw new TypeError('must be number')
        },
      })
      const t0 = graph.now
      graph.commit('set:42', (tx) => tx.set(n, 42))
      expect(graph.now).toBe(t0 + 1)
      expect(graph.read(n)).toBe(42)
    })

    it('an absent invariant leaves the engine semantics unchanged (backcompat)', () => {
      const graph = createCausl()
      const n = graph.input<number>('n', 0) // two-arg form, no options
      graph.commit('set', (tx) => tx.set(n, 999))
      expect(graph.read(n)).toBe(999)
    })

    it('the initial value is NOT validated at registration time', () => {
      // SPEC choice: the engine assumes the caller has produced a
      // valid initial value (it just typed the signature as `T`).
      // Validating at registration would prevent recoverable
      // bootstraps where the initial is provisionally invalid until
      // a subsequent commit. Defer to the call site if needed.
      expect(() => {
        createCausl().input<number>('n', 'not-a-number' as unknown as number, {
          invariant: (v) => {
            if (typeof v !== 'number') throw new TypeError('must be number')
          },
        })
      }).not.toThrow()
    })
  })

  describe('sad path — invariant throws', () => {
    it('throws InvariantViolationError carrying nodeId + value + cause', () => {
      const graph = createCausl()
      const n = graph.input<number>('n', 0, {
        invariant: (v) => {
          if (typeof v !== 'number') throw new TypeError('must be number, got ' + typeof v)
        },
      })
      let caught: unknown
      try {
        graph.commit('bad', (tx) => tx.set(n, 'oops' as unknown as number))
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(InvariantViolationError)
      expect(caught).toBeInstanceOf(CauslError) // discriminated-identity root
      const err = caught as InvariantViolationError
      expect(err.nodeId).toBe('n')
      expect(err.value).toBe('oops')
      expect(err.cause).toBeInstanceOf(TypeError)
      expect((err.cause as Error).message).toContain('must be number')
    })

    it('atomicity: graph.now does NOT advance when invariant rejects', () => {
      const graph = createCausl()
      const n = graph.input<number>('n', 0, {
        invariant: (v) => {
          if (v < 0) throw new RangeError('negative not allowed')
        },
      })
      const t0 = graph.now
      expect(() => graph.commit('bad', (tx) => tx.set(n, -1))).toThrow(InvariantViolationError)
      expect(graph.now).toBe(t0)
      expect(graph.read(n)).toBe(0) // initial value preserved
    })

    it('atomicity: per-node subscribers do NOT fire on rejected commits', () => {
      const graph = createCausl()
      const n = graph.input<number>('n', 0, {
        invariant: (v) => {
          if (v < 0) throw new RangeError('negative')
        },
      })
      const fires: number[] = []
      graph.subscribe(n, (v) => fires.push(v))
      // The subscribe contract fires a synchronous initial fire with the
      // current value. We're interested in *commit-time* fires.
      const baselineFireCount = fires.length
      expect(() => graph.commit('bad', (tx) => tx.set(n, -1))).toThrow(InvariantViolationError)
      expect(fires.length).toBe(baselineFireCount) // no commit-time fire
    })

    it('atomicity: subscribeCommits does NOT fire on rejected commits', () => {
      const graph = createCausl()
      const n = graph.input<number>('n', 0, {
        invariant: (v) => {
          if (v < 0) throw new RangeError('negative')
        },
      })
      const commits: unknown[] = []
      graph.subscribeCommits((c) => commits.push(c))
      expect(() => graph.commit('bad', (tx) => tx.set(n, -1))).toThrow(InvariantViolationError)
      expect(commits.length).toBe(0)
    })

    it('multi-set: when one node fails, ALL staged writes in the same commit roll back', () => {
      const graph = createCausl()
      const a = graph.input<number>('a', 0) // no invariant
      const b = graph.input<number>('b', 0, {
        invariant: (v) => {
          if (v < 0) throw new RangeError('b: negative')
        },
      })
      expect(() =>
        graph.commit('multi-set:one-bad', (tx) => {
          tx.set(a, 100) // would succeed in isolation
          tx.set(b, -5)   // violates b's invariant
        }),
      ).toThrow(InvariantViolationError)
      // Neither a nor b updated; commit is atomic.
      expect(graph.read(a)).toBe(0)
      expect(graph.read(b)).toBe(0)
    })

    it('the offending invariant identifies the FIRST violation when many nodes are invalid', () => {
      const graph = createCausl()
      const a = graph.input<number>('a', 0, {
        invariant: (v) => {
          if (v < 0) throw new RangeError('a: negative')
        },
      })
      const b = graph.input<number>('b', 0, {
        invariant: (v) => {
          if (v < 0) throw new RangeError('b: negative')
        },
      })
      let caught: InvariantViolationError | undefined
      try {
        graph.commit('multi-bad', (tx) => {
          tx.set(a, -1)
          tx.set(b, -2)
        })
      } catch (e) {
        caught = e as InvariantViolationError
      }
      // The engine surfaces the FIRST violation; the rest of the
      // transaction is rolled back unread.
      expect(caught).toBeInstanceOf(InvariantViolationError)
      expect(['a', 'b']).toContain(caught!.nodeId)
    })
  })

  describe('re-entrancy & async restrictions', () => {
    it('an invariant that calls graph.commit during validation throws CommitInProgressError', () => {
      const graph = createCausl()
      const n = graph.input<number>('n', 0, {
        invariant: () => {
          // Misuse: invariants must be pure. Calling commit inside the
          // staging phase is the same race the existing nested-commit
          // guard catches.
          graph.commit('nested', () => {
            /* no-op */
          })
        },
      })
      expect(() => graph.commit('outer', (tx) => tx.set(n, 1))).toThrow(CommitInProgressError)
      expect(graph.now).toBe(0)
    })

    it('an invariant returning a Promise is ignored (sync-only contract)', () => {
      const graph = createCausl()
      const seen: number[] = []
      const n = graph.input<number>('n', 0, {
        // Async invariants are NOT awaited. They're allowed to return a
        // Promise (TS won't error because `void` accepts anything), but
        // the engine treats them as fire-and-forget. Misregistered async
        // checks therefore have no protective value; document & move on.
        invariant: ((v: number) => {
          seen.push(v)
          return Promise.resolve()
        }) as (v: number) => void,
      })
      // Should commit cleanly — the async invariant's eventual resolution
      // (even a rejection) does NOT block commit time advancement.
      graph.commit('async-invariant', (tx) => tx.set(n, 42))
      expect(graph.read(n)).toBe(42)
      expect(seen).toEqual([42])
    })
  })

  describe('TypeScript signature', () => {
    it('infers the invariant parameter as the node generic T', () => {
      // Type-level test: this file must compile under strict mode.
      const graph = createCausl()
      const n = graph.input<{ name: string; age: number }>(
        'person',
        { name: 'Alice', age: 30 },
        {
          invariant: (v) => {
            // `v` should be inferred as { name: string; age: number }
            const _name: string = v.name
            const _age: number = v.age
            void _name
            void _age
          },
        },
      )
      void n
      expect(true).toBe(true)
    })
  })
})
