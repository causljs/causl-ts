import {
  reduceResource
} from "./chunk-V4VSRV4P.js";

// src/resource.ts
var ForbiddenResourceTransitionError = class extends Error {
  constructor(id, from, to) {
    super(
      `Forbidden resource transition: ${from} \u2192 ${to} on '${id}'. Only Loading \u2192 ${to} (fetch-reject) and Loaded \u2192 ${to} (invalidate(error)) are permitted by the resource statechart.`
    );
    this.id = id;
    this.from = from;
    this.to = to;
  }
  id;
  from;
  to;
  name = "ForbiddenResourceTransitionError";
};
function resource(graph, key, options) {
  const initial = { state: "idle" };
  const node = graph.input(key, initial);
  const stalenessGuard = options.stalenessGuard ?? true;
  function setState(intent, next) {
    graph.commit(intent, (tx) => tx.set(node, next));
  }
  function applyEvent(intent, event) {
    const current = graph.read(node);
    const result = reduceResource(current, event, graph.now, key);
    if (result.kind === "forbidden") {
      throw new ForbiddenResourceTransitionError(
        key,
        result.reason.from,
        "errored"
      );
    }
    if (result.next === current) return current;
    setState(intent, result.next);
    return result.next;
  }
  function fetchOnce() {
    const origin = graph.now;
    const loaderPromise = options.loader(origin);
    const suspensePromise = loaderPromise.then(
      () => void 0,
      () => void 0
    );
    applyEvent(`fetch:${key}:start`, {
      kind: "fetch-start",
      origin,
      promise: suspensePromise
    });
    const loadingAt = graph.now;
    return loaderPromise.then(
      (value) => {
        const isStale = stalenessGuard && graph.now > loadingAt;
        applyEvent(isStale ? `fetch:${key}:stale` : `fetch:${key}:loaded`, {
          kind: "fetch-resolve",
          value,
          loadingAt,
          stalenessGuard
        });
        return value;
      },
      (error) => {
        applyEvent(`fetch:${key}:error`, { kind: "fetch-reject", error });
        throw error;
      }
    );
  }
  return {
    node,
    key,
    fetch: fetchOnce,
    /**
     * Transition Loaded -> Stale without re-fetching. No-op when the
     * current state is not Loaded — the statechart has no edge from
     * Idle/Loading/Stale/Errored under this trigger; the reducer
     * surfaces the no-op as `next === state` and `applyEvent` skips
     * the commit.
     */
    invalidate() {
      applyEvent(`invalidate:${key}`, { kind: "invalidate" });
    },
    /**
     * Drive the chart-named `Loading | Loaded → Errored` edges from
     * the host application. Refuses every other source state with a
     * {@link ForbiddenResourceTransitionError}.
     *
     * @remarks
     * `SPEC.md` §6 / `docs/lifecycle.md` §1 specify exactly two edges
     * into `Errored`: `Loading → Errored` (trigger `fetch-reject`) and
     * `Loaded → Errored` (trigger `invalidate(error)`). The
     * `fetch-reject` edge is also driven by the loader's rejection
     * branch in {@link fetchOnce}; this mutator covers the host-side
     * trigger for the same two edges (e.g. a host that cancels an
     * in-flight fetch, or that learns about a server-side error for
     * an already-Loaded resource via an out-of-band channel like a
     * websocket).
     *
     * `Idle → Errored`, `Stale → Errored`, and `Errored → Errored`
     * are not in the chart, so a previous total-over-state-space
     * `fail()` shipped enum tags whose transitions are not specified
     * by §6 — the exact failure mode `SPEC.md` §17 commitment 7
     * forbids. Those source states now throw rather than silently
     * write `errored`. The chart-guard decision lives in
     * {@link reduceResource}; this shell only wires the event in.
     */
    fail(error) {
      applyEvent(`fail:${key}`, { kind: "fail", error });
    }
  };
}

export {
  ForbiddenResourceTransitionError,
  resource
};
