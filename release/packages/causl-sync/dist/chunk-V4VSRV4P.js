// src/statechart-reducers.ts
function reduceConflict(state, event, time, id) {
  const to = event.kind === "resolve" ? "resolved" : event.kind === "ignore" ? "ignored" : "superseded";
  if (state !== "open") {
    return {
      kind: "forbidden",
      reason: { region: "conflict", from: state, to, id }
    };
  }
  switch (event.kind) {
    case "resolve":
      return {
        kind: "ok",
        next: { kind: "resolved", value: event.resolution, at: time }
      };
    case "ignore":
      return { kind: "ok", next: { kind: "ignored", at: time } };
    case "supersede":
      return {
        kind: "ok",
        next: { kind: "superseded", bySupersedingId: event.bySupersedingId, at: time }
      };
  }
}
function reduceResource(state, event, time, id) {
  switch (event.kind) {
    // `* → Loading` is unconditional in the chart — issuing a fetch
    // from any source state is the host-driven trigger.
    case "fetch-start":
      return {
        kind: "ok",
        next: {
          state: "loading",
          origin: event.origin,
          promise: event.promise
        }
      };
    // `Loading → Loaded | Stale` is legal only from `loading`. Every
    // other source state is a forbidden edge.
    case "fetch-resolve": {
      if (state.state !== "loading") {
        return {
          kind: "forbidden",
          reason: { region: "resource", from: state.state, to: "loaded", id }
        };
      }
      const isStale = event.stalenessGuard && time > event.loadingAt;
      return {
        kind: "ok",
        next: isStale ? { state: "stale", value: event.value, origin: state.origin, loadedAt: time } : { state: "loaded", value: event.value, origin: state.origin, loadedAt: time }
      };
    }
    // `Loading → Errored` via the loader's rejection branch. Legal
    // only from `loading`.
    case "fetch-reject": {
      if (state.state !== "loading") {
        return {
          kind: "forbidden",
          reason: { region: "resource", from: state.state, to: "errored", id }
        };
      }
      return {
        kind: "ok",
        next: {
          state: "errored",
          error: event.error,
          origin: state.origin,
          erroredAt: time
        }
      };
    }
    // `Loaded → Stale` via `invalidate`. Every other source state is
    // a chart-named no-op (the pre-#698 silent-no-op).
    case "invalidate":
      if (state.state !== "loaded") {
        return { kind: "ok", next: state };
      }
      return {
        kind: "ok",
        next: {
          state: "stale",
          value: state.value,
          origin: state.origin,
          loadedAt: state.loadedAt
        }
      };
    // `Loading | Loaded → Errored` via the host-side `fail()`
    // trigger. Every other source state is forbidden and surfaces
    // through ForbiddenResourceTransitionError on the wiring side.
    case "fail":
      if (state.state !== "loading" && state.state !== "loaded") {
        return {
          kind: "forbidden",
          reason: { region: "resource", from: state.state, to: "errored", id }
        };
      }
      return {
        kind: "ok",
        next: {
          state: "errored",
          error: event.error,
          origin: state.origin,
          erroredAt: time
        }
      };
  }
}

export {
  reduceConflict,
  reduceResource
};
