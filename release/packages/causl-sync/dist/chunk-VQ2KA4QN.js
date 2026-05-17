import {
  reduceConflict
} from "./chunk-V4VSRV4P.js";

// src/conflict.ts
import { assertNever } from "@causl/core/internal";
var ForbiddenConflictTransitionError = class extends Error {
  constructor(id, from, to) {
    super(
      `Forbidden conflict transition: ${from} \u2192 ${to} on '${id}'. Only Open \u2192 ${to} is permitted by the conflict statechart.`
    );
    this.id = id;
    this.from = from;
    this.to = to;
  }
  id;
  from;
  to;
  name = "ForbiddenConflictTransitionError";
};
function createConflictRegistry(graph, options) {
  const resolutionsId = `${options.id}::__resolutions`;
  const resolutions = graph.input(
    resolutionsId,
    /* @__PURE__ */ new Map()
  );
  const openSetId = `${options.id}::__open`;
  const openSet = graph.derived(openSetId, options.compute);
  const node = graph.derived(options.id, (get) => {
    const open = get(openSet);
    const resolved = get(resolutions);
    const out = [];
    for (const partial of open) {
      const r = resolved.get(partial.id);
      if (!r) {
        out.push({ ...partial, kind: "open" });
        continue;
      }
      switch (r.kind) {
        // Resolution branch: explicit resolved with opaque tag carried
        // through to the public Conflict.
        case "resolved":
          out.push({
            ...partial,
            kind: "resolved",
            resolution: r.value,
            resolvedAt: r.at
          });
          break;
        // Resolution branch: operator-suppressed.
        case "ignored":
          out.push({ ...partial, kind: "ignored", ignoredAt: r.at });
          break;
        // Resolution branch: another conflict subsumed this one. The
        // linkage and the supersession GraphTime are surfaced on the
        // public shape so callers no longer have to reach into the
        // registry's mutators to recover it (the lossy old behaviour).
        case "superseded":
          out.push({
            ...partial,
            kind: "superseded",
            supersededBy: r.bySupersedingId,
            supersededAt: r.at
          });
          break;
        default:
          return assertNever(r, "unhandled ResolutionRecord kind");
      }
    }
    return out;
  });
  function patch(graph2, id, record) {
    const current = graph2.read(resolutions);
    const next = new Map(current);
    next.set(id, record);
    graph2.commit(`conflict:${record.kind}:${id}`, (tx) => tx.set(resolutions, next));
  }
  function currentKindOf(g, id) {
    const resolved = g.read(resolutions).get(id);
    if (resolved !== void 0) return resolved.kind;
    const open = g.read(openSet);
    for (const c of open) if (c.id === id) return "open";
    return "unknown";
  }
  function applyEvent(g, id, event) {
    const from = currentKindOf(g, id);
    const result = reduceConflict(from, event, g.now, id);
    if (result.kind === "forbidden") {
      const to = result.reason.to;
      throw new ForbiddenConflictTransitionError(
        id,
        result.reason.from,
        to
      );
    }
    patch(g, id, result.next);
  }
  return {
    node,
    read(g) {
      return g.read(node);
    },
    subscribe(g, observer) {
      return g.subscribe(node, observer);
    },
    resolve(g, id, resolution) {
      applyEvent(g, id, { kind: "resolve", resolution });
    },
    ignore(g, id) {
      applyEvent(g, id, { kind: "ignore" });
    },
    supersede(g, id, bySupersedingId) {
      applyEvent(g, id, { kind: "supersede", bySupersedingId });
    }
  };
}
function singleConflictWhen(source, predicate, describe) {
  return (get) => {
    const v = get(source);
    if (!predicate(v)) return [];
    const partial = describe(v, 0);
    return [
      {
        id: partial.id,
        target: partial.target,
        value: v,
        raisedAt: 0
      }
    ];
  };
}

export {
  ForbiddenConflictTransitionError,
  createConflictRegistry,
  singleConflictWhen
};
