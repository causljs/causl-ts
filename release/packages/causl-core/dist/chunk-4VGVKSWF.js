import {
  assertNever,
  registerInternalDispatch
} from "./chunk-HLBMCSGV.js";
import {
  registerTestingDispatch
} from "./chunk-6AT5T6LD.js";

// src/errors.ts
var CauslError = class extends Error {
  name = "CauslError";
};
var DuplicateNodeError = class extends CauslError {
  constructor(id) {
    super(`Node already registered: ${id}`);
    this.id = id;
  }
  id;
  name = "DuplicateNodeError";
};
var UnknownNodeError = class extends CauslError {
  constructor(id) {
    super(`Unknown node: ${id}`);
    this.id = id;
  }
  id;
  name = "UnknownNodeError";
};
var NotAnInputNodeError = class extends CauslError {
  constructor(id) {
    super(`Cannot tx.set a derived node: ${id}`);
    this.id = id;
  }
  id;
  name = "NotAnInputNodeError";
};
var CommitInProgressError = class extends CauslError {
  name = "CommitInProgressError";
  constructor() {
    super("A commit is already in progress; commits do not nest.");
  }
};
var CycleError = class extends CauslError {
  constructor(path) {
    super(`Derivation cycle detected: ${path.join(" \u2192 ")}`);
    this.path = path;
  }
  path;
  name = "CycleError";
};
var StaleTxError = class extends CauslError {
  name = "StaleTxError";
  constructor() {
    super("Tx used outside its commit callback.");
  }
};
var NodeDisposedError = class extends CauslError {
  constructor(id, disposedAt) {
    super(`Node "${id}" was disposed at t=${disposedAt}`);
    this.id = id;
    this.disposedAt = disposedAt;
  }
  id;
  disposedAt;
  name = "NodeDisposedError";
  /** Discriminated tag for exhaustive matching. */
  kind = "NodeDisposed";
};
var NodeHasDependentsError = class extends CauslError {
  constructor(id, dependents) {
    super(
      `Cannot dispose "${id}" \u2014 it still has ${dependents.length} dependent(s): ${dependents.join(", ")}`
    );
    this.id = id;
    this.dependents = dependents;
  }
  id;
  dependents;
  name = "NodeHasDependentsError";
  /** Discriminated tag for exhaustive matching. */
  kind = "NodeHasDependents";
};
var HydrationSchemaError = class extends CauslError {
  constructor(reason, detail) {
    super(`Hydration rejected (${reason}): ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
  reason;
  detail;
  name = "HydrationSchemaError";
  /** Discriminated tag for exhaustive matching. */
  kind = "HydrationSchema";
};
var DisposalDuringCommitError = class extends CauslError {
  constructor(id) {
    super(`Cannot dispose "${id}" while a commit is in progress`);
    this.id = id;
  }
  id;
  name = "DisposalDuringCommitError";
  /** Discriminated tag for exhaustive matching. */
  kind = "DisposalDuringCommit";
};
var NonDeterministicComputeError = class extends CauslError {
  constructor(id, path) {
    super(
      `Derived "${id}" is not a deterministic function of its declared dependencies: re-running its compute against the same dep snapshot produced a different value. Path: ${path.join(" \u2192 ")}`
    );
    this.id = id;
    this.path = path;
  }
  id;
  path;
  name = "NonDeterministicComputeError";
  /** Discriminated tag for exhaustive matching. */
  kind = "NonDeterministicCompute";
};
var DerivedRegistrationStackOverflowError = class extends CauslError {
  constructor(id, scale = -1) {
    super(
      `Derived "${id}" registration overflowed the V8 call stack \u2014 the engine's closure-tracking walker recurses one frame per dep-chain edge and exhausted the stack at depth` + (scale >= 0 ? ` \u2265 ${scale}` : "") + `. The chain is too deep for the recursive registration walker; reduce the chain depth, or split the registration into smaller batches separated by a commit (#936).`
    );
    this.id = id;
    this.scale = scale;
  }
  id;
  scale;
  name = "DerivedRegistrationStackOverflowError";
  /** Discriminated tag for exhaustive matching. */
  kind = "DerivedRegistrationStackOverflow";
};
var InvalidGraphNameError = class extends CauslError {
  constructor(invalidName) {
    super(
      `Invalid graph name: ${JSON.stringify(invalidName)}. Must match /^[A-Za-z0-9_.:-]{1,256}$/.`
    );
    this.invalidName = invalidName;
  }
  invalidName;
  name = "InvalidGraphNameError";
  /** Discriminated tag for exhaustive matching. */
  kind = "InvalidGraphName";
};

// src/backend.ts
var JsBackend = class {
  #ops;
  constructor(ops) {
    this.#ops = ops;
  }
  commit(intent, writes) {
    return this.#ops.commit(intent, writes);
  }
  read(node) {
    return this.#ops.read(node);
  }
  subscribe(node, observer) {
    return this.#ops.subscribe(node, observer);
  }
  subscribeCommits(observer) {
    return this.#ops.subscribeCommits(observer);
  }
  snapshot() {
    return this.#ops.snapshot();
  }
  hydrate(s) {
    this.#ops.hydrate(s);
  }
  exportModel() {
    return this.#ops.exportModel();
  }
  readAt(node, time) {
    return this.#ops.readAt(node, time);
  }
  snapshotAt(time) {
    return this.#ops.snapshotAt(time);
  }
  dispose(node) {
    this.#ops.dispose(node);
  }
  evaluateStatechart(input) {
    return this.#ops.evaluateStatechart(input);
  }
  get now() {
    return this.#ops.now();
  }
};

// src/auto-adapt.ts
var DEFAULT_THRESHOLDS = Object.freeze({
  nodeCount: 5e4,
  maxChainDepth: 500,
  medianCommitMsThreshold: 1,
  rollingCommitWindow: 100,
  commitCount: 500,
  totalSubscribers: 1e3
});
var HYSTERESIS_TRIP_COUNT = 3;
var NODE_COUNT_EWMA_ALPHA = 0.1;
function ewmaOver(values, alpha) {
  if (values.length === 0) return 0;
  let ewma = values[0];
  for (let i = 1; i < values.length; i += 1) {
    ewma = alpha * values[i] + (1 - alpha) * ewma;
  }
  return ewma;
}
function medianOf(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if ((sorted.length & 1) === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
function tripped(stats, t, medianCommitMs) {
  const nodes = stats.inputs + stats.deriveds;
  if (nodes > t.nodeCount) return true;
  const chainDepth = stats.maxChainDepth ?? 0;
  if (chainDepth > t.maxChainDepth) return true;
  if (stats.lastCommitTime > t.commitCount && stats.subscribersTotal > t.totalSubscribers && medianCommitMs > t.medianCommitMsThreshold) {
    return true;
  }
  return false;
}
function shouldMigrate(stats, thresholds, history, commitTimings = []) {
  const medianCommitMs = commitTimings.length > 0 ? medianOf(commitTimings) : stats.medianCommitMs ?? 0;
  if (history.length < HYSTERESIS_TRIP_COUNT - 1) return false;
  const tail = history.slice(-(HYSTERESIS_TRIP_COUNT - 1));
  if (!tripped(stats, thresholds, medianCommitMs)) return false;
  for (let i = 0; i < tail.length; i += 1) {
    if (!tripped(tail[i], thresholds, tail[i].medianCommitMs ?? 0)) return false;
  }
  const allNodeCounts = new Array(history.length + 1);
  for (let i = 0; i < history.length; i += 1) {
    const s = history[i];
    allNodeCounts[i] = s.inputs + s.deriveds;
  }
  allNodeCounts[history.length] = stats.inputs + stats.deriveds;
  const ewma = ewmaOver(allNodeCounts, NODE_COUNT_EWMA_ALPHA);
  return ewma > thresholds.nodeCount;
}
function loadThresholdsFromEnv() {
  const overrides = {};
  try {
    const proc = globalThis.process;
    const env = proc?.env;
    if (env === void 0 || env === null) return overrides;
    const tryParse = (key) => {
      const raw = env[key];
      if (raw === void 0 || raw === "") return void 0;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) return void 0;
      return parsed;
    };
    const nodeCount = tryParse("CAUSL_WASM_NODE_THRESHOLD");
    if (nodeCount !== void 0) overrides.nodeCount = nodeCount;
    const chain = tryParse("CAUSL_WASM_CHAIN_THRESHOLD");
    if (chain !== void 0) overrides.maxChainDepth = chain;
    const subs = tryParse("CAUSL_WASM_SUBSCRIBER_THRESHOLD");
    if (subs !== void 0) overrides.totalSubscribers = subs;
    const commits = tryParse("CAUSL_WASM_COMMIT_THRESHOLD");
    if (commits !== void 0) overrides.commitCount = commits;
    const commitMs = tryParse("CAUSL_WASM_COMMIT_MS_THRESHOLD");
    if (commitMs !== void 0) overrides.medianCommitMsThreshold = commitMs;
  } catch {
  }
  return overrides;
}
function mergeThresholds(overrides) {
  if (overrides === void 0) return DEFAULT_THRESHOLDS;
  return Object.freeze({ ...DEFAULT_THRESHOLDS, ...overrides });
}
var MODULE_THRESHOLD_OVERRIDES = Object.freeze(loadThresholdsFromEnv());

// src/auto-adapt-wrapper.ts
var MIGRATION_PAYBACK_FIELD = "migrationPaybackCommits";
var STATS_HISTORY_CAP = 128;
var UNSEEN = /* @__PURE__ */ Symbol("@causl/core/auto-adapt-wrapper/unseen");
function createAutoAdaptGraph(baseFactory, options) {
  const thresholds = mergeThresholds({
    ...MODULE_THRESHOLD_OVERRIDES,
    ...options.adaptThresholds
  });
  const { backend: _backend, adaptThresholds: _adaptThresholds, ...jsOptions } = options;
  void _backend;
  void _adaptThresholds;
  let inner = baseFactory(jsOptions);
  let migrated = false;
  let migrating = false;
  let wasmBackendReady = null;
  let migrationPaybackCommits = void 0;
  const commitTimings = [];
  const statsHistory = [];
  const registrationLog = [];
  const liveNodeSubs = /* @__PURE__ */ new Set();
  const liveCommitSubs = /* @__PURE__ */ new Set();
  function nowMs() {
    const perf = globalThis.performance;
    if (perf && typeof perf.now === "function") return perf.now();
    return Date.now();
  }
  function captureStats(inner2) {
    const t = inner2.stats();
    return {
      inputs: t.inputs,
      deriveds: t.deriveds,
      subscribersTotal: t.subscribersTotal,
      lastCommitTime: t.lastCommitTime
    };
  }
  function pushBounded(buf, value, cap) {
    buf.push(value);
    while (buf.length > cap) buf.shift();
  }
  function triggerMigration() {
    migrating = true;
    void (async () => {
      try {
        const wasmMod = await import("./wasm.js");
        const graphName = options.name;
        const batchedFlush = options.batchedFlush;
        const engine = options.engine;
        wasmBackendReady = await wasmMod.loadWasmBackend({
          ...graphName !== void 0 ? { graphName } : {},
          ...batchedFlush !== void 0 ? { batchedFlush } : {},
          ...engine !== void 0 ? { engine } : {}
        });
      } catch {
        migrating = false;
        wasmBackendReady = null;
      }
    })();
  }
  function rebindNodeSubscription(target, sub) {
    let firstFire = true;
    const wrapped = (value, time) => {
      if (firstFire) {
        firstFire = false;
        if (sub.lastValue !== UNSEEN && Object.is(sub.lastValue, value)) {
          return;
        }
      }
      sub.lastValue = value;
      sub.userObserver(value, time);
    };
    return sub.options === void 0 ? target.subscribe(sub.node, wrapped) : target.subscribe(sub.node, wrapped, sub.options);
  }
  function performSwap() {
    if (migrated) return;
    if (wasmBackendReady === null) return;
    const wasmBackend = wasmBackendReady;
    const wasmGraphFn = wasmBackend.__graph;
    const wasmMigrateFn = wasmBackend.__migrateFrom;
    if (typeof wasmGraphFn !== "function" || typeof wasmMigrateFn !== "function") {
      migrating = false;
      return;
    }
    const wasmGraph = wasmGraphFn.call(wasmBackend);
    for (const reg of registrationLog) {
      switch (reg.kind) {
        case "input":
          wasmGraph.input(reg.id, reg.initial);
          break;
        case "derived":
          wasmGraph.derived(
            reg.id,
            reg.compute,
            reg.tag !== void 0 ? { tag: reg.tag } : void 0
          );
          break;
        case "commitMetadataDerived":
          wasmGraph.commitMetadataDerived(reg.id, reg.compute);
          break;
      }
    }
    const snap = inner.snapshot();
    wasmMigrateFn.call(wasmBackend, snap);
    for (const sub of liveNodeSubs) {
      sub.dispose();
      sub.dispose = rebindNodeSubscription(wasmGraph, sub);
    }
    for (const cs of liveCommitSubs) {
      cs.dispose();
      cs.dispose = wasmGraph.subscribeCommits(cs.userObserver);
    }
    inner = wasmGraph;
    migrated = true;
    migrating = false;
    migrationPaybackCommits = thresholds.commitCount;
  }
  function commitWrapped(intent, run) {
    const start = nowMs();
    const result = inner.commit(intent, run);
    const elapsed = nowMs() - start;
    pushBounded(commitTimings, elapsed, thresholds.rollingCommitWindow);
    const stats = captureStats(inner);
    pushBounded(statsHistory, stats, STATS_HISTORY_CAP);
    if (migrationPaybackCommits !== void 0 && migrationPaybackCommits > 0) {
      migrationPaybackCommits -= 1;
    }
    if (!migrated) {
      if (migrating && wasmBackendReady !== null) {
        performSwap();
      } else if (!migrating) {
        const historyPrefix = statsHistory.slice(0, -1);
        if (shouldMigrate(stats, thresholds, historyPrefix, commitTimings)) {
          triggerMigration();
        }
      }
    }
    return result;
  }
  const graph = {
    input(id, initial) {
      const handle = inner.input(id, initial);
      registrationLog.push({ kind: "input", id, initial });
      return handle;
    },
    derived(id, compute, opts) {
      const handle = inner.derived(id, compute, opts);
      registrationLog.push({
        kind: "derived",
        id,
        compute,
        tag: opts?.tag
      });
      return handle;
    },
    commitMetadataDerived(id, compute) {
      const handle = inner.commitMetadataDerived(id, compute);
      registrationLog.push({
        kind: "commitMetadataDerived",
        id,
        compute
      });
      return handle;
    },
    commit: commitWrapped,
    simulate: (intent, run) => inner.simulate(intent, run),
    read: (node) => inner.read(node),
    subscribe: (node, observer, options2) => {
      const sub = {
        node,
        userObserver: observer,
        options: options2,
        lastValue: UNSEEN,
        // The disposer is replaced below once we have it.
        dispose: () => void 0
      };
      const wrapped = (value, time) => {
        sub.lastValue = value;
        sub.userObserver(value, time);
      };
      sub.dispose = options2 === void 0 ? inner.subscribe(node, wrapped) : inner.subscribe(node, wrapped, options2);
      liveNodeSubs.add(sub);
      return () => {
        if (liveNodeSubs.has(sub)) {
          sub.dispose();
          liveNodeSubs.delete(sub);
        }
      };
    },
    subscribeMany: (nodes, observer, options2) => inner.subscribeMany(nodes, observer, options2),
    subscribeCommits: (observer) => {
      const cs = {
        userObserver: observer,
        dispose: () => void 0
      };
      cs.dispose = inner.subscribeCommits(observer);
      liveCommitSubs.add(cs);
      return () => {
        if (liveCommitSubs.has(cs)) {
          cs.dispose();
          liveCommitSubs.delete(cs);
        }
      };
    },
    subscribeReads: (observer, projection) => inner.subscribeReads(observer, projection),
    explain: (node) => inner.explain(node),
    dependencies: (node) => inner.dependencies(node),
    dependents: (node) => inner.dependents(node),
    exportModel: (opts) => opts === void 0 ? inner.exportModel() : inner.exportModel(opts),
    snapshot: () => inner.snapshot(),
    snapshotAt: (time) => inner.snapshotAt(time),
    hydrate: (snap) => inner.hydrate(snap),
    readAt: (node, time) => inner.readAt(node, time),
    get now() {
      return inner.now;
    },
    get commitLog() {
      return inner.commitLog;
    },
    stats: () => {
      const inner_stats = inner.stats();
      if (migrationPaybackCommits === void 0) return inner_stats;
      return {
        ...inner_stats,
        [MIGRATION_PAYBACK_FIELD]: migrationPaybackCommits
      };
    }
  };
  return graph;
}

// src/statechart-evaluator.ts
function evaluateConflict(state, event, time, id) {
  const to = event.kind === "resolve" ? "resolved" : event.kind === "ignore" ? "ignored" : "superseded";
  if (state !== "open") {
    const reason = {
      region: "conflict",
      from: state,
      to,
      id
    };
    return { kind: "forbidden", reason };
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
        next: {
          kind: "superseded",
          bySupersedingId: event.bySupersedingId,
          at: time
        }
      };
  }
}
function evaluateResource(state, event, time, id) {
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
        const reason = {
          region: "resource",
          from: state.state,
          to: "loaded",
          id
        };
        return { kind: "forbidden", reason };
      }
      const isStale = event.stalenessGuard && time > event.loadingAt;
      return {
        kind: "ok",
        next: isStale ? {
          state: "stale",
          value: event.value,
          origin: state.origin,
          loadedAt: time
        } : {
          state: "loaded",
          value: event.value,
          origin: state.origin,
          loadedAt: time
        }
      };
    }
    // `Loading → Errored` via the loader's rejection branch. Legal
    // only from `loading`.
    case "fetch-reject": {
      if (state.state !== "loading") {
        const reason = {
          region: "resource",
          from: state.state,
          to: "errored",
          id
        };
        return { kind: "forbidden", reason };
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
    case "invalidate": {
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
    }
    // `Loading | Loaded → Errored` via the host-side `fail()` trigger.
    // Every other source state is forbidden and surfaces through
    // `ForbiddenResourceTransitionError` on the wiring side.
    case "fail":
      if (state.state !== "loading" && state.state !== "loaded") {
        const reason = {
          region: "resource",
          from: state.state,
          to: "errored",
          id
        };
        return { kind: "forbidden", reason };
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
function evaluateStatechart(input) {
  switch (input.region) {
    case "conflict":
      return evaluateConflict(
        input.state,
        input.event,
        input.time,
        input.id
      );
    case "resource":
      return evaluateResource(
        input.state,
        input.event,
        input.time,
        input.id
      );
  }
}

// src/flags.ts
function loadFlagsFromEnv() {
  let freezeOffInProd = false;
  let assertDeterministicCompute = false;
  try {
    const proc = globalThis.process;
    if (proc?.env?.CAUSL_FREEZE_OFF_IN_PROD === "1") {
      freezeOffInProd = true;
    }
    if (proc?.env?.CAUSL_ASSERT_DETERMINISTIC_COMPUTE === "1") {
      assertDeterministicCompute = true;
    }
  } catch {
  }
  return Object.freeze({ freezeOffInProd, assertDeterministicCompute });
}
var MODULE_FLAGS = loadFlagsFromEnv();
function mergeFlags(overrides) {
  if (overrides === void 0) return MODULE_FLAGS;
  return Object.freeze({ ...MODULE_FLAGS, ...overrides });
}

// src/ir.ts
var CAUSL_MODEL_SCHEMA = 3;
function parseCauslModel(input) {
  if (typeof input !== "object" || input === null) {
    return { ok: false, path: [], reason: "not-an-object" };
  }
  const m = input;
  if (m.schema !== CAUSL_MODEL_SCHEMA) {
    return {
      ok: false,
      path: ["schema"],
      reason: `expected schema ${CAUSL_MODEL_SCHEMA}, got ${String(m.schema)}`
    };
  }
  if (typeof m.time !== "number") {
    return { ok: false, path: ["time"], reason: "expected number" };
  }
  if (!Array.isArray(m.nodes)) {
    return { ok: false, path: ["nodes"], reason: "expected array" };
  }
  if (!Array.isArray(m.commits)) {
    return { ok: false, path: ["commits"], reason: "expected array" };
  }
  if (!Array.isArray(m.events)) {
    return { ok: false, path: ["events"], reason: "expected array" };
  }
  if (!Array.isArray(m.scopes)) {
    return { ok: false, path: ["scopes"], reason: "expected array" };
  }
  if (!Array.isArray(m.bridges)) {
    return { ok: false, path: ["bridges"], reason: "expected array" };
  }
  for (let i = 0; i < m.events.length; i++) {
    const e = m.events[i];
    if (typeof e !== "object" || e === null) {
      return {
        ok: false,
        path: ["events", i],
        reason: "event is not an object"
      };
    }
    const ev = e;
    const kind = ev.kind;
    switch (kind) {
      case "subscribe":
      case "subscribe-callback":
      case "unsubscribe":
      case "read":
      case "tx-set":
        break;
      case "dispose": {
        const da = ev.disposeAt;
        if (!Array.isArray(da) || da.length !== 2 || typeof da[0] !== "number" || typeof da[1] !== "number") {
          return {
            ok: false,
            path: ["events", i, "disposeAt"],
            reason: "expected [number, number]"
          };
        }
        break;
      }
      default:
        return {
          ok: false,
          path: ["events", i, "kind"],
          reason: `unknown event kind: ${String(kind)}`
        };
    }
  }
  return { ok: true, value: input };
}

// src/graph.ts
var DEFAULT_COMMIT_HISTORY_CAP = 0;
var DEFAULT_SNAPSHOT_RETENTION_CAP = 0;
function makeFreezeIfDev(flags) {
  if (flags.freezeOffInProd) {
    return (value) => value;
  }
  return (value) => Object.freeze(value);
}
var DEFAULT_DISPOSED_TOMBSTONE_CAP = 1e3;
var defaultOnObserverError = (error, ctx) => {
  console.error(
    `[causl] observer threw (${ctx.source}${ctx.nodeId ? ":" + ctx.nodeId : ""} @ t=${ctx.time}):`,
    error
  );
};
function makeInputNode(id) {
  return Object.freeze({ id });
}
function makeDerivedNode(id) {
  return Object.freeze({ id });
}
function makeInputEntry(id, value, lastWriteTime, node) {
  return {
    kind: "input",
    id,
    value,
    node,
    lastWriteTime,
    // #994 — every freshly-registered input starts with no derived
    // consumers. Edges flip this true on the first `setDeps` add and
    // back to false on the last edge remove.
    hasDependents: false,
    // #995 — split-staged read-shadow sentinel. `-1` is the
    // never-staged value; `tx.set`'s slow path stamps `now` on first
    // stage. See InputEntry's field comment for the lifecycle
    // rationale.
    lastStagedAt: -1,
    lastStagedRow: -1,
    // #1303 — every freshly-registered input starts with no
    // transitively-downstream subscriber. `subscribe` flips this true
    // when the per-node refcount crosses 0 → ≥1 (either by a direct
    // subscriber on this input or by a `setDeps` edge that newly
    // routes a subscribed-derived's path through this input).
    hasDownstreamSubscriber: false
  };
}
var pretenureLatchTripped = false;
var PRETENURE_WARMUP_COUNT = 2e4;
function pretenureInputAllocationSites() {
  if (pretenureLatchTripped) return;
  pretenureLatchTripped = true;
  for (let i = 0; i < PRETENURE_WARMUP_COUNT; i++) {
    const id = `__causl_pretenure__:${i}`;
    const node = makeInputNode(id);
    makeInputEntry(id, i, 0, node);
  }
  const warmupGraph = createCausl();
  for (let i = 0; i < PRETENURE_WARMUP_COUNT; i++) {
    warmupGraph.input(`__causl_pretenure_input__:${i}`, i);
  }
}
var GRAPH_ID_REGEX = /^[A-Za-z0-9_.:-]{1,256}$/;
function createCausl(options = {}) {
  if (options.backend === "auto") {
    return createAutoAdaptGraph(
      (innerOptions) => createCausl(innerOptions),
      options
    );
  }
  pretenureInputAllocationSites();
  const commitHistoryCap = options.commitHistoryCap ?? DEFAULT_COMMIT_HISTORY_CAP;
  const snapshotRetentionCap = options.snapshotRetentionCap ?? DEFAULT_SNAPSHOT_RETENTION_CAP;
  const disposedTombstoneCap = options.disposedTombstoneCap ?? DEFAULT_DISPOSED_TOMBSTONE_CAP;
  const onObserverError = options.onObserverError ?? defaultOnObserverError;
  const _strictCyclesDeprecated = options.strictCycles ?? true;
  const flags = mergeFlags(options.experimentalFlags);
  const freezeIfDev = makeFreezeIfDev(flags);
  const enableH1HazardWarning = options.enableH1HazardWarning ?? false;
  let h1HazardTrack = null;
  if (process.env.NODE_ENV !== "production") {
    h1HazardTrack = enableH1HazardWarning ? [] : null;
  }
  let adapterReadDepth = 0;
  if (options.name !== void 0 && !GRAPH_ID_REGEX.test(options.name)) {
    throw new InvalidGraphNameError(options.name);
  }
  const graphId = options.name ?? mintGraphIdUuid();
  function mintGraphIdUuid() {
    const fromCrypto = globalThis.crypto?.randomUUID?.();
    if (fromCrypto !== void 0) return fromCrypto;
    const hex = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        s += "-";
      } else if (i === 14) {
        s += "4";
      } else if (i === 19) {
        s += hex[Math.random() * 16 & 3 | 8];
      } else {
        s += hex[Math.random() * 16 | 0];
      }
    }
    return s;
  }
  const retainedSnapshots = [];
  function resolveRetained(row, id) {
    let cur = row;
    while (cur !== null) {
      if (cur.delta.has(id)) return { found: true, value: cur.delta.get(id) };
      cur = cur.prev;
    }
    return { found: false };
  }
  function materialiseRetained(row) {
    const out = {};
    let cur = row;
    while (cur !== null) {
      for (const [id, v] of cur.delta) {
        if (!(id in out)) out[id] = v;
      }
      cur = cur.prev;
    }
    return out;
  }
  const entries = /* @__PURE__ */ new Map();
  const inputRegisteredAtMap = /* @__PURE__ */ new Map();
  const inputSerializableMemo = /* @__PURE__ */ new Map();
  const commitMetadataIds = /* @__PURE__ */ new Set();
  const explainHandles = /* @__PURE__ */ new Map();
  const dependents = /* @__PURE__ */ new Map();
  const subscriberRefcount = /* @__PURE__ */ new Map();
  const disposed = /* @__PURE__ */ new Map();
  const subscriptions = /* @__PURE__ */ new Set();
  const subscriptionsByNode = /* @__PURE__ */ new Map();
  const pendingTransientDrops = /* @__PURE__ */ new Set();
  const commitObservers = /* @__PURE__ */ new Set();
  const subscribeReadsRegistrations = /* @__PURE__ */ new Set();
  const subscribeReadsByNode = /* @__PURE__ */ new Map();
  let activeReadTracker = null;
  const commitHistory = [];
  const COMMIT_LOG_ID = "__causl_commit_log__";
  const commitLogNode = makeDerivedNode(COMMIT_LOG_ID);
  let commitLogConsumerCount = 0;
  let inputCount = 0;
  let derivedCount = 0;
  const nodeVersions = /* @__PURE__ */ new Map();
  const nodeVersionAccessor = (node) => nodeVersions.get(node.id) ?? 0;
  let transientSubscriberCount = 0;
  let now = 0;
  let committing = false;
  const stagedWriteEntries = [];
  const stagedWriteValues = [];
  let stagedActive = false;
  retainedSnapshots.push({ time: 0, delta: /* @__PURE__ */ new Map(), prev: null });
  const commitLogEntry = {
    kind: "derived",
    id: COMMIT_LOG_ID,
    compute: (() => buildCommitLogValue()),
    value: Object.freeze([]),
    computed: true,
    lastTime: 0,
    deps: /* @__PURE__ */ new Set(),
    // Engine-owned commit log: registered at genesis t₀ alongside the
    // graph itself, so its Behavior domain is [0, ∞) — no caller ever
    // hits the pre-existence branch on this id.
    derivedRegisteredAt: 0,
    // Always-set tag field per #703 Win 5 (monomorphic hidden class).
    tag: void 0
  };
  entries.set(COMMIT_LOG_ID, commitLogEntry);
  function buildCommitLogValue() {
    return Object.freeze(
      commitHistory.map(
        (row) => (
          // Always-set the optional `originatedAt` field (#703 Win 5 /
          // #760) so the published Commit hidden class is monomorphic
          // across regular and hydrate-issued records. The conditional
          // spread previously produced two hidden classes the moment
          // the first hydrate landed, sending every commit-log
          // consumer's `c.originatedAt` access megamorphic.
          Object.freeze({
            time: row.time,
            intent: row.intent,
            changedNodes: freezeIfDev(row.changedNodes.slice()),
            originatedAt: row.originatedAt
          })
        )
      )
    );
  }
  function reportObserverError(error, ctx) {
    try {
      onObserverError(error, ctx);
    } catch {
      console.error("[causl] onObserverError threw while reporting:", error);
    }
  }
  function getEntry(id) {
    const e = entries.get(id);
    if (!e) {
      const disposedAt = disposed.get(id);
      if (disposedAt !== void 0) throw new NodeDisposedError(id, disposedAt);
      throw new UnknownNodeError(id);
    }
    return e;
  }
  function readEntry(node) {
    const e = getEntry(node.id);
    return readEntryFromResolved(e, node);
  }
  function readEntryFromResolved(e, node) {
    if (activeReadTracker !== null) {
      activeReadTracker.add(e.id);
    }
    if (e.kind === "input") {
      if (stagedActive && e.lastStagedAt === now) {
        return stagedWriteValues[e.lastStagedRow];
      }
      return e.value;
    }
    if (e.id === COMMIT_LOG_ID && e.lastTime < now && commitHistoryCap > 0) {
      e.value = buildCommitLogValue();
      e.lastTime = now;
    }
    if (e.kind === "derived" && !e.computed) {
      computeDerived(e);
    }
    return e.value;
  }
  function anyInputSubscriberIn(changedInputIds) {
    if (changedInputIds.length === 0) return false;
    if (subscriptionsByNode.size === 0) return false;
    for (const id of changedInputIds) {
      if (subscriptionsByNode.has(id)) return true;
    }
    return false;
  }
  function anyProjectionDepIn(changedInputIds) {
    if (changedInputIds.length === 0) return false;
    if (subscribeReadsByNode.size === 0) return false;
    for (const id of changedInputIds) {
      if (subscribeReadsByNode.has(id)) return true;
    }
    return false;
  }
  function anyChangedInputHasSubscriber(changedInputIds) {
    if (changedInputIds.length === 0) return false;
    for (const id of changedInputIds) {
      const e = entries.get(id);
      if (e !== void 0 && e.kind === "input" && e.hasDownstreamSubscriber) {
        return true;
      }
    }
    return false;
  }
  function bumpSubscriberRefcountUp(startId, delta) {
    if (delta === 0) return;
    const stack = [startId];
    while (stack.length > 0) {
      const cur = stack.pop();
      const e = entries.get(cur);
      if (e === void 0) continue;
      const prev = subscriberRefcount.get(cur) ?? 0;
      const next = prev + delta;
      if (next === 0) {
        subscriberRefcount.delete(cur);
        if (e.kind === "input" && e.hasDownstreamSubscriber) {
          e.hasDownstreamSubscriber = false;
        }
      } else {
        subscriberRefcount.set(cur, next);
        if (e.kind === "input" && !e.hasDownstreamSubscriber && next > 0) {
          e.hasDownstreamSubscriber = true;
        }
      }
      if (e.kind === "derived") {
        for (const dep of e.deps) stack.push(dep);
      }
    }
  }
  function setDeps(derivedId, nextDeps) {
    const prev = entries.get(derivedId);
    if (!prev || prev.kind !== "derived") return;
    if (nextDeps.size === prev.deps.size) {
      if (prev.deps === nextDeps) return;
      let identical = true;
      for (const id of nextDeps) {
        if (!prev.deps.has(id)) {
          identical = false;
          break;
        }
      }
      if (identical) {
        return;
      }
    }
    const derivedSubCount = subscriberRefcount.get(derivedId) ?? 0;
    for (const oldDep of prev.deps) {
      if (!nextDeps.has(oldDep)) {
        const bucket = dependents.get(oldDep);
        if (bucket !== void 0) {
          bucket.delete(derivedId);
          if (bucket.size === 0) {
            const upstream = entries.get(oldDep);
            if (upstream !== void 0 && upstream.kind === "input") {
              upstream.hasDependents = false;
            }
          }
        }
        if (derivedSubCount > 0) {
          bumpSubscriberRefcountUp(oldDep, -derivedSubCount);
        }
      }
    }
    for (const newDep of nextDeps) {
      let set = dependents.get(newDep);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        dependents.set(newDep, set);
      }
      const sizeBefore = set.size;
      set.add(derivedId);
      if (sizeBefore === 0 && set.size === 1) {
        const upstream = entries.get(newDep);
        if (upstream !== void 0 && upstream.kind === "input") {
          upstream.hasDependents = true;
        }
      }
      if (derivedSubCount > 0 && !prev.deps.has(newDep)) {
        bumpSubscriberRefcountUp(newDep, +derivedSubCount);
      }
    }
    if (prev.tag !== "commit-metadata") {
      const hadBefore = prev.deps.has(COMMIT_LOG_ID);
      const hasAfter = nextDeps.has(COMMIT_LOG_ID);
      if (hasAfter && !hadBefore) commitLogConsumerCount++;
      else if (!hasAfter && hadBefore) commitLogConsumerCount--;
    }
    prev.deps = nextDeps;
  }
  function setDepsFromArray(derivedId, arr, len) {
    const prev = entries.get(derivedId);
    if (!prev || prev.kind !== "derived") return;
    const prevDeps = prev.deps;
    if (len === prevDeps.size) {
      let identical = true;
      for (let i = 0; i < len; i++) {
        if (!prevDeps.has(arr[i])) {
          identical = false;
          break;
        }
      }
      if (identical) return;
    }
    const next = /* @__PURE__ */ new Set();
    for (let i = 0; i < len; i++) next.add(arr[i]);
    const derivedSubCount = subscriberRefcount.get(derivedId) ?? 0;
    for (const oldDep of prevDeps) {
      if (!next.has(oldDep)) {
        const bucket = dependents.get(oldDep);
        if (bucket !== void 0) {
          bucket.delete(derivedId);
          if (bucket.size === 0) {
            const upstream = entries.get(oldDep);
            if (upstream !== void 0 && upstream.kind === "input") {
              upstream.hasDependents = false;
            }
          }
        }
        if (derivedSubCount > 0) {
          bumpSubscriberRefcountUp(oldDep, -derivedSubCount);
        }
      }
    }
    for (let i = 0; i < len; i++) {
      const newDep = arr[i];
      let set = dependents.get(newDep);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        dependents.set(newDep, set);
      }
      const sizeBefore = set.size;
      set.add(derivedId);
      if (sizeBefore === 0 && set.size === 1) {
        const upstream = entries.get(newDep);
        if (upstream !== void 0 && upstream.kind === "input") {
          upstream.hasDependents = true;
        }
      }
      if (derivedSubCount > 0 && !prevDeps.has(newDep)) {
        bumpSubscriberRefcountUp(newDep, +derivedSubCount);
      }
    }
    if (prev.tag !== "commit-metadata") {
      const hadBefore = prevDeps.has(COMMIT_LOG_ID);
      const hasAfter = next.has(COMMIT_LOG_ID);
      if (hasAfter && !hadBefore) commitLogConsumerCount++;
      else if (!hasAfter && hadBefore) commitLogConsumerCount--;
    }
    prev.deps = next;
  }
  function findCyclePathFrom(startId) {
    const startEntry = entries.get(startId);
    if (!startEntry || startEntry.kind !== "derived") return null;
    const parent = /* @__PURE__ */ new Map();
    const visited = /* @__PURE__ */ new Set();
    const stack = [];
    for (const d of startEntry.deps) {
      if (!parent.has(d) && d !== startId) {
        parent.set(d, startId);
        stack.push(d);
      } else if (d === startId) {
        return [startId, startId];
      }
    }
    while (stack.length > 0) {
      const cur = stack.pop();
      if (visited.has(cur)) continue;
      visited.add(cur);
      const e = entries.get(cur);
      if (!e || e.kind !== "derived") continue;
      for (const d of e.deps) {
        if (d === startId) {
          const path = [startId];
          const reverseChain = [cur];
          let p = parent.get(cur);
          while (p !== void 0 && p !== startId) {
            reverseChain.push(p);
            p = parent.get(p);
          }
          for (let i = reverseChain.length - 1; i >= 0; i--) {
            path.push(reverseChain[i]);
          }
          path.push(startId);
          return path;
        }
        if (!parent.has(d) && !visited.has(d)) {
          parent.set(d, cur);
          stack.push(d);
        }
      }
    }
    return null;
  }
  function recoverCyclePath(residue) {
    const residueSet = new Set(residue);
    const seed = residue[0];
    const visited = /* @__PURE__ */ new Set();
    const path = [];
    const onPath = /* @__PURE__ */ new Set();
    function dfs(cur) {
      if (onPath.has(cur)) {
        const startIdx = path.indexOf(cur);
        return path.slice(startIdx).concat([cur]);
      }
      if (visited.has(cur)) return null;
      visited.add(cur);
      onPath.add(cur);
      path.push(cur);
      const e = entries.get(cur);
      if (e && e.kind === "derived") {
        for (const d of e.deps) {
          if (!residueSet.has(d)) continue;
          const found2 = dfs(d);
          if (found2 !== null) return found2;
        }
      }
      path.pop();
      onPath.delete(cur);
      return null;
    }
    const found = dfs(seed);
    if (found !== null) return found;
    return [...residue, residue[0]];
  }
  let activeRecording = null;
  function recordingGet(n) {
    const rec = activeRecording;
    if (rec === null) {
      throw new Error(
        "[causl] recordingGet called outside a compute frame \u2014 internal invariant violated"
      );
    }
    const dep = getEntry(n.id);
    if (dep.kind === "derived") {
      if (rec.kind === "iterative") {
        if (rec.inFlight.has(n.id)) {
          const stack = rec.stackForCycle;
          const ids = [];
          for (let i = 0; i < stack.length; i++) ids.push(stack[i].entry.id);
          const cycleStart = ids.indexOf(n.id);
          const path = ids.slice(cycleStart).concat([n.id]);
          throw new CycleError(path);
        }
        if (!dep.computed) {
          throw new MissingUpstream(n.id);
        }
      } else {
        if (!dep.computed) {
          computeDerived(dep, rec.dirtyStack);
        }
      }
    }
    const id = n.id;
    const arr = rec.nextDepsArr;
    const len = rec.nextDepsLen;
    let already = false;
    for (let i = 0; i < len; i++) {
      if (arr[i] === id) {
        already = true;
        break;
      }
    }
    if (!already) {
      arr[len] = id;
      rec.nextDepsLen = len + 1;
    }
    const value = readEntryFromResolved(dep, n);
    if (rec.captured !== null) rec.captured.set(n.id, value);
    return value;
  }
  function computeDerived(e, dirtyStack = []) {
    if (dirtyStack.includes(e.id)) {
      throw new CycleError([...dirtyStack, e.id]);
    }
    const nextDepsArr = [];
    const nextStack = [...dirtyStack, e.id];
    const gate = flags.assertDeterministicCompute;
    const frame = {
      kind: "recursive",
      nextDepsArr,
      nextDepsLen: 0,
      dirtyStack: nextStack,
      captured: gate ? /* @__PURE__ */ new Map() : null
    };
    const prevRecording = activeRecording;
    activeRecording = frame;
    let next;
    try {
      next = e.compute(recordingGet);
    } finally {
      activeRecording = prevRecording;
    }
    if (frame.captured !== null) {
      const captured = frame.captured;
      const verifyGet = (n) => {
        if (captured.has(n.id)) return captured.get(n.id);
        return recordingGet(n);
      };
      const prev2 = activeRecording;
      activeRecording = frame;
      let verify;
      try {
        verify = e.compute(verifyGet);
      } finally {
        activeRecording = prev2;
      }
      if (!Object.is(verify, next)) {
        throw new NonDeterministicComputeError(e.id, [...dirtyStack, e.id]);
      }
    }
    e.value = next;
    setDepsFromArray(e.id, nextDepsArr, frame.nextDepsLen);
    e.computed = true;
    e.lastTime = now;
  }
  class MissingUpstream {
    constructor(id) {
      this.id = id;
    }
    id;
  }
  function computeDerivedIterative(rootEntry) {
    if (rootEntry.computed) return;
    const stack = [];
    const inFlight = /* @__PURE__ */ new Set();
    const gate = flags.assertDeterministicCompute;
    const pushFrame = (entry) => {
      stack.push({ entry, nextDepsArr: [], nextDepsLen: 0 });
      inFlight.add(entry.id);
    };
    pushFrame(rootEntry);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      frame.nextDepsLen = 0;
      const captured = gate ? /* @__PURE__ */ new Map() : null;
      const recFrame = {
        kind: "iterative",
        nextDepsArr: frame.nextDepsArr,
        nextDepsLen: 0,
        inFlight,
        stackForCycle: stack,
        captured
      };
      let nextValue;
      const prevRecording = activeRecording;
      activeRecording = recFrame;
      let computeErr = void 0;
      let computeThrew = false;
      try {
        nextValue = frame.entry.compute(recordingGet);
      } catch (err) {
        computeErr = err;
        computeThrew = true;
      } finally {
        activeRecording = prevRecording;
      }
      frame.nextDepsLen = recFrame.nextDepsLen;
      if (computeThrew) {
        if (computeErr instanceof MissingUpstream) {
          const upstream = entries.get(computeErr.id);
          if (!upstream || upstream.kind !== "derived") {
            throw computeErr;
          }
          pushFrame(upstream);
          continue;
        }
        for (const f of stack) inFlight.delete(f.entry.id);
        stack.length = 0;
        throw computeErr;
      }
      if (captured !== null) {
        const verifyGet = (n) => {
          if (captured.has(n.id)) return captured.get(n.id);
          return recordingGet(n);
        };
        const prev2 = activeRecording;
        activeRecording = recFrame;
        let verifyErr = void 0;
        let verifyThrew = false;
        let verify;
        try {
          verify = frame.entry.compute(verifyGet);
        } catch (err) {
          verifyErr = err;
          verifyThrew = true;
        } finally {
          activeRecording = prev2;
        }
        frame.nextDepsLen = recFrame.nextDepsLen;
        if (verifyThrew) {
          if (verifyErr instanceof MissingUpstream) {
            const upstream = entries.get(verifyErr.id);
            if (!upstream || upstream.kind !== "derived") throw verifyErr;
            pushFrame(upstream);
            continue;
          }
          for (const f of stack) inFlight.delete(f.entry.id);
          stack.length = 0;
          throw verifyErr;
        }
        if (!Object.is(verify, nextValue)) {
          const errPath = [];
          for (let i = 0; i < stack.length; i++) errPath.push(stack[i].entry.id);
          for (const f of stack) inFlight.delete(f.entry.id);
          stack.length = 0;
          throw new NonDeterministicComputeError(frame.entry.id, errPath);
        }
      }
      frame.entry.value = nextValue;
      setDepsFromArray(frame.entry.id, frame.nextDepsArr, frame.nextDepsLen);
      frame.entry.computed = true;
      frame.entry.lastTime = now;
      inFlight.delete(frame.entry.id);
      stack.pop();
    }
  }
  function input(id, initial) {
    if (entries.has(id)) throw new DuplicateNodeError(id);
    const node = makeInputNode(id);
    entries.set(id, makeInputEntry(id, initial, now, node));
    inputCount++;
    if (now !== 0) inputRegisteredAtMap.set(id, now);
    if (snapshotRetentionCap > 0 && isSerializable(initial)) {
      for (const snap of retainedSnapshots) {
        if (snap.time === now) {
          snap.delta.set(id, initial);
        }
      }
    }
    return node;
  }
  function derived(id, compute, options2) {
    if (entries.has(id)) throw new DuplicateNodeError(id);
    const node = makeDerivedNode(id);
    const entry = {
      kind: "derived",
      id,
      compute,
      value: void 0,
      computed: false,
      lastTime: now,
      deps: /* @__PURE__ */ new Set(),
      // Anchor the Behavior's domain at the registration moment so
      // `readAt(derived, t < derivedRegisteredAt)` surfaces the
      // discriminated `evicted` arm rather than fabricating a value
      // by recomputing against a pre-existence input snapshot (#374).
      derivedRegisteredAt: now,
      // Always-set the optional `tag` field (#703 Win 5) so the
      // DerivedEntry hidden class is monomorphic across plain
      // `derived(...)` and `commitMetadataDerived(...)` callers.
      // The conditional spread previously produced two hidden
      // classes the moment any tagged node was registered, sending
      // every entries.get(id).kind === 'derived' branch megamorphic.
      tag: options2?.tag
    };
    entries.set(id, entry);
    if (options2?.tag === "commit-metadata") {
      commitMetadataIds.add(id);
      commitLogConsumerCount++;
    }
    try {
      computeDerivedIterative(entry);
    } catch (err) {
      entries.delete(id);
      commitMetadataIds.delete(id);
      if (options2?.tag === "commit-metadata") commitLogConsumerCount--;
      if (isStackOverflowRangeError(err)) {
        throw new DerivedRegistrationStackOverflowError(id);
      }
      throw err;
    }
    derivedCount++;
    return node;
  }
  function isStackOverflowRangeError(err) {
    if (!(err instanceof RangeError)) return false;
    const msg = err.message;
    return typeof msg === "string" && msg.startsWith("Maximum call stack size exceeded");
  }
  function commitMetadataDerived(id, compute) {
    return derived(id, compute, { tag: "commit-metadata" });
  }
  function read(node) {
    const value = readEntry(node);
    if (process.env.NODE_ENV !== "production") {
      if (h1HazardTrack !== null && activeReadTracker === null && adapterReadDepth === 0 && value !== null && (typeof value === "object" || typeof value === "function")) {
        h1HazardTrack.push({
          ref: new WeakRef(value),
          nodeId: node.id,
          capturedAt: now
        });
        if (h1HazardTrack.length > H1_HAZARD_TRACK_CAP) {
          pruneH1HazardTrack();
        }
      }
    }
    return value;
  }
  const H1_HAZARD_TRACK_CAP = 4096;
  function pruneH1HazardTrack() {
    if (process.env.NODE_ENV === "production") return;
    if (h1HazardTrack === null) return;
    let write = 0;
    for (let read2 = 0; read2 < h1HazardTrack.length; read2++) {
      const rec = h1HazardTrack[read2];
      if (rec.ref.deref() !== void 0) {
        h1HazardTrack[write++] = rec;
      }
    }
    h1HazardTrack.length = write;
  }
  function checkH1HazardOnCommit() {
    if (process.env.NODE_ENV === "production") return;
    if (h1HazardTrack === null || h1HazardTrack.length === 0) return;
    let write = 0;
    for (let read2 = 0; read2 < h1HazardTrack.length; read2++) {
      const rec = h1HazardTrack[read2];
      const referent = rec.ref.deref();
      if (referent === void 0) continue;
      if (rec.capturedAt < now) {
        console.warn(
          `[causl] H1 hazard: graph.read(node '${rec.nodeId}') return value held across commit \u2014 reference identity not guaranteed (SPEC \xA715.1)`
        );
        continue;
      }
      h1HazardTrack[write++] = rec;
    }
    h1HazardTrack.length = write;
  }
  function runInAdapterReadMode(fn) {
    if (process.env.NODE_ENV === "production") {
      return fn();
    }
    adapterReadDepth++;
    try {
      return fn();
    } finally {
      adapterReadDepth--;
    }
  }
  function recomputeAffected(seedChanged, rollback) {
    const indegree = /* @__PURE__ */ new Map();
    const queue = [];
    for (const id of seedChanged) {
      const downstream = dependents.get(id);
      if (!downstream) continue;
      for (const d of downstream) {
        if (!indegree.has(d)) {
          indegree.set(d, 0);
          queue.push(d);
        }
      }
    }
    let qHead = 0;
    while (qHead < queue.length) {
      const id = queue[qHead++];
      const downstream = dependents.get(id);
      if (!downstream) continue;
      for (const d of downstream) {
        const cur = indegree.get(d);
        if (cur !== void 0) {
          indegree.set(d, cur + 1);
        } else {
          indegree.set(d, 1);
          queue.push(d);
        }
      }
    }
    const ready = [];
    for (const [id, d] of indegree.entries()) {
      if (d === 0) ready.push(id);
    }
    const ordered = [];
    let rHead = 0;
    while (rHead < ready.length) {
      const id = ready[rHead++];
      ordered.push(id);
      const downstream = dependents.get(id);
      if (!downstream) continue;
      for (const d of downstream) {
        const cur = indegree.get(d);
        if (cur === void 0) continue;
        const next = cur - 1;
        indegree.set(d, next);
        if (next === 0) ready.push(d);
      }
    }
    if (ordered.length < indegree.size) {
      const orderedSet = new Set(ordered);
      const residue = [];
      for (const id of indegree.keys()) {
        if (!orderedSet.has(id)) residue.push(id);
      }
      throw new CycleError(recoverCyclePath(residue));
    }
    const processedThisPass = /* @__PURE__ */ new Set();
    const changedThisCommit = [];
    const cutoffStable = /* @__PURE__ */ new Set();
    for (const id of ordered) {
      const e = entries.get(id);
      if (!e || e.kind !== "derived") continue;
      if (e.computed) {
        let allStable = true;
        for (const dp of e.deps) {
          if (seedChanged.has(dp)) {
            allStable = false;
            break;
          }
          if (indegree.has(dp) && !cutoffStable.has(dp)) {
            allStable = false;
            break;
          }
        }
        if (allStable) {
          cutoffStable.add(id);
          continue;
        }
      }
      const before = e.value;
      const wasComputed = e.computed;
      const prevDeps = e.deps;
      if (rollback !== void 0) {
        let m = rollback.map;
        if (m === void 0) {
          m = /* @__PURE__ */ new Map();
          rollback.map = m;
        }
        if (!m.has(id)) {
          m.set(id, {
            value: e.value,
            deps: e.deps,
            computed: e.computed,
            lastTime: e.lastTime
          });
        }
      }
      computeDerived(e);
      processedThisPass.add(id);
      let hasNewDep = false;
      for (const d of e.deps) {
        if (!prevDeps.has(d)) {
          hasNewDep = true;
          break;
        }
      }
      if (hasNewDep) {
        const cyclePath = findCyclePathFrom(e.id);
        if (cyclePath !== null) {
          throw new CycleError(cyclePath);
        }
      }
      if (!wasComputed || !Object.is(before, e.value)) {
        changedThisCommit.push(id);
      } else {
        cutoffStable.add(id);
      }
    }
    return changedThisCommit;
  }
  function recomputeCommitMetadata(rollback) {
    if (commitMetadataIds.size === 0) return [];
    const changedThisPhase = [];
    for (const id of commitMetadataIds) {
      const e = entries.get(id);
      if (!e || e.kind !== "derived") continue;
      const before = e.value;
      const wasComputed = e.computed;
      let m = rollback.map;
      if (m === void 0) {
        m = /* @__PURE__ */ new Map();
        rollback.map = m;
      }
      if (!m.has(id)) {
        m.set(id, {
          value: e.value,
          // #703 Win 3 — capture by reference; `setDeps` swaps the
          // reference rather than mutating in place, so the prior
          // set stays a valid pre-recompute snapshot for the
          // commit() catch-arm rollback. Same invariant as Phase D's
          // capture site above; same property-test gate
          // (`test/properties/setDeps-immutability.test.ts`).
          deps: e.deps,
          computed: e.computed,
          lastTime: e.lastTime
        });
      }
      computeDerived(e);
      if (!wasComputed || !Object.is(before, e.value)) {
        changedThisPhase.push(id);
      }
    }
    return changedThisPhase;
  }
  function commit(intent, run) {
    return commitInternal(intent, run);
  }
  function phaseD_recomputeAffected(changed, derivedRollback) {
    return recomputeAffected(changed, derivedRollback);
  }
  function phaseF4_refreshCommitLog(currentNow, changed) {
    commitLogEntry.value = buildCommitLogValue();
    commitLogEntry.lastTime = currentNow;
    changed.add(COMMIT_LOG_ID);
  }
  function phaseF6_retainInputSnapshot(currentNow, changedInputIds) {
    const delta = /* @__PURE__ */ new Map();
    for (const id of changedInputIds) {
      const e = entries.get(id);
      if (e && e.kind === "input" && isInputValueSerializable(e, inputSerializableMemo)) {
        delta.set(id, e.value);
      }
    }
    const head = retainedSnapshots.length > 0 ? retainedSnapshots[retainedSnapshots.length - 1] : null;
    retainedSnapshots.push({ time: currentNow, delta, prev: head });
    while (retainedSnapshots.length > snapshotRetentionCap) {
      const evicted = retainedSnapshots.shift();
      const newRoot = retainedSnapshots[0];
      if (!newRoot) break;
      let cur = evicted;
      while (cur !== null) {
        for (const [id, v] of cur.delta) {
          if (!newRoot.delta.has(id)) {
            newRoot.delta.set(id, v);
          }
        }
        cur = cur.prev;
      }
      newRoot.prev = null;
    }
  }
  function phaseG_dispatchPerNodeSubscribers(changed, c, currentNow) {
    let firedManyGroups;
    for (const changedId of changed) {
      const bucket = subscriptionsByNode.get(changedId);
      if (bucket === void 0) continue;
      for (const sub of bucket) {
        if (sub.manyGroup !== null) {
          if (sub.manyGroup.disposed) continue;
          if (firedManyGroups !== void 0 && firedManyGroups.has(sub.manyGroup)) continue;
        }
        const v = readEntry(sub.node);
        if (!sub.hasFired || !Object.is(sub.lastValue, v)) {
          sub.lastValue = v;
          sub.hasFired = true;
          if (sub.manyGroup !== null) {
            if (firedManyGroups === void 0) firedManyGroups = /* @__PURE__ */ new Set();
            firedManyGroups.add(sub.manyGroup);
          }
          try {
            sub.observer(v, currentNow);
          } catch (err) {
            reportObserverError(err, {
              source: "node-subscriber",
              nodeId: sub.node.id,
              time: currentNow
            });
          }
          if (sub.transient) {
            if (sub.manyGroup !== null) {
              for (const peer of sub.manyGroup.entries) {
                pendingTransientDrops.add(peer);
              }
            } else {
              pendingTransientDrops.add(sub);
            }
          }
        }
      }
    }
    if (subscribeReadsRegistrations.size > 0) {
      const fired = /* @__PURE__ */ new Set();
      for (const changedId of changed) {
        const bucket = subscribeReadsByNode.get(changedId);
        if (bucket === void 0) continue;
        for (const reg of bucket) {
          if (fired.has(reg)) continue;
          fired.add(reg);
          let result;
          try {
            result = runProjectionTracked(reg.projection);
          } catch (err) {
            reportObserverError(err, {
              source: "subscribe-reads-projection",
              time: currentNow
            });
            continue;
          }
          reconcileProjectionDeps(reg, result.deps);
          try {
            reg.observer(c, result.value);
          } catch (err) {
            reportObserverError(err, {
              source: "subscribe-reads",
              time: currentNow
            });
          }
        }
      }
    }
  }
  function phaseH_dispatchCommitObservers(c, currentNow) {
    for (const obs of commitObservers) {
      try {
        obs(c);
      } catch (err) {
        reportObserverError(err, { source: "commit-subscriber", time: currentNow });
      }
    }
  }
  function commitInternal(intent, run, originatedAt) {
    if (committing) throw new CommitInProgressError();
    committing = true;
    stagedWriteEntries.length = 0;
    stagedWriteValues.length = 0;
    stagedActive = true;
    const inputRollbackEntries = [];
    const inputRollbackPriorValues = [];
    const inputRollbackPriorLastWrite = [];
    const beforeNow = now;
    let txAlive = true;
    const tx = {
      set(node, value) {
        if (!txAlive) throw new StaleTxError();
        const id = node.id;
        const e = getEntry(id);
        if (e.kind !== "input") throw new NotAnInputNodeError(id);
        if (!e.hasDependents) {
          if (Object.is(e.value, value)) return;
          if (e.lastWriteTime > now) {
            e.value = value;
            return;
          }
          inputRollbackEntries.push(e);
          inputRollbackPriorValues.push(e.value);
          inputRollbackPriorLastWrite.push(e.lastWriteTime);
          e.value = value;
          e.lastWriteTime = now + 1;
          return;
        }
        if (e.lastStagedAt === now) {
          const idx = e.lastStagedRow;
          if (Object.is(stagedWriteValues[idx], value)) return;
          stagedWriteValues[idx] = value;
          return;
        }
        if (Object.is(e.value, value)) return;
        e.lastStagedAt = now;
        e.lastStagedRow = stagedWriteEntries.length;
        stagedWriteEntries.push(e);
        stagedWriteValues.push(value);
      }
    };
    const changedInputIds = [];
    const derivedRollback = { map: void 0 };
    let commitHistorySnapshot = null;
    const commitLogValueBeforeF4 = commitLogEntry.value;
    const commitLogLastTimeBeforeF4 = commitLogEntry.lastTime;
    try {
      run(tx);
      txAlive = false;
      const fastPathLen = inputRollbackEntries.length;
      if (fastPathLen > 0) {
        let writeIdx = 0;
        for (let i = 0; i < fastPathLen; i++) {
          const e = inputRollbackEntries[i];
          const priorValue = inputRollbackPriorValues[i];
          const priorLastWrite = inputRollbackPriorLastWrite[i];
          if (Object.is(e.value, priorValue)) {
            e.lastWriteTime = priorLastWrite;
            continue;
          }
          if (writeIdx !== i) {
            inputRollbackEntries[writeIdx] = e;
            inputRollbackPriorValues[writeIdx] = priorValue;
            inputRollbackPriorLastWrite[writeIdx] = priorLastWrite;
          }
          writeIdx++;
          changedInputIds.push(e.id);
          inputSerializableMemo.delete(e.id);
        }
        if (writeIdx !== fastPathLen) {
          inputRollbackEntries.length = writeIdx;
          inputRollbackPriorValues.length = writeIdx;
          inputRollbackPriorLastWrite.length = writeIdx;
        }
      }
      const stagedLen = stagedWriteEntries.length;
      let rollbackLen = inputRollbackEntries.length;
      if (stagedLen > 0) {
        const cap = rollbackLen + stagedLen;
        inputRollbackEntries.length = cap;
        inputRollbackPriorValues.length = cap;
        inputRollbackPriorLastWrite.length = cap;
        for (let i = 0; i < stagedLen; i++) {
          const e = stagedWriteEntries[i];
          const v = stagedWriteValues[i];
          if (!Object.is(e.value, v)) {
            inputRollbackEntries[rollbackLen] = e;
            inputRollbackPriorValues[rollbackLen] = e.value;
            inputRollbackPriorLastWrite[rollbackLen] = e.lastWriteTime;
            rollbackLen++;
            e.value = v;
            inputSerializableMemo.delete(e.id);
            changedInputIds.push(e.id);
          }
        }
        if (rollbackLen !== cap) {
          inputRollbackEntries.length = rollbackLen;
          inputRollbackPriorValues.length = rollbackLen;
          inputRollbackPriorLastWrite.length = rollbackLen;
        }
      }
      now += 1;
      for (let i = 0, n = inputRollbackEntries.length; i < n; i++) {
        inputRollbackEntries[i].lastWriteTime = now;
      }
      const changed = new Set(changedInputIds);
      let downstreamChanged = [];
      if (changedInputIds.length > 0) {
        downstreamChanged = phaseD_recomputeAffected(changed, derivedRollback);
        for (const id of downstreamChanged) changed.add(id);
      }
      if (changedInputIds.length === 0 && downstreamChanged.length === 0 && commitObservers.size === 0 && commitMetadataIds.size === 0 && commitHistoryCap === 0 && !anyInputSubscriberIn(changedInputIds) && !anyProjectionDepIn(changedInputIds)) {
        return Object.freeze({
          time: now,
          intent,
          changedNodes: freezeIfDev([]),
          originatedAt
        });
      }
      const changedNodes = Array.from(changed);
      const frozenChangedNodes = freezeIfDev(changedNodes);
      const c = Object.freeze({
        time: now,
        intent,
        changedNodes: frozenChangedNodes,
        originatedAt
      });
      if (commitMetadataIds.size > 0) {
        commitHistorySnapshot = commitHistory.slice();
      }
      if (commitHistoryCap > 0) {
        commitHistory.push({
          time: c.time,
          graphId,
          intent: c.intent,
          changedNodes: c.changedNodes,
          originatedAt: c.originatedAt
        });
        if (commitHistory.length > commitHistoryCap) {
          commitHistory.splice(0, commitHistory.length - commitHistoryCap);
        }
      }
      if (commitHistoryCap > 0 && commitLogConsumerCount > 0) {
        phaseF4_refreshCommitLog(now, changed);
      }
      if (commitMetadataIds.size > 0) {
        const metadataChanged = recomputeCommitMetadata(derivedRollback);
        for (const id of metadataChanged) changed.add(id);
      }
      for (const id of changed) {
        nodeVersions.set(id, (nodeVersions.get(id) ?? 0) + 1);
      }
      if (commitHistoryCap > 0) {
        phaseF6_retainInputSnapshot(now, changedInputIds);
      }
      if (changed.size > 0 && (anyChangedInputHasSubscriber(changedInputIds) || changed.has(COMMIT_LOG_ID) && (subscriberRefcount.get(COMMIT_LOG_ID) ?? 0) > 0 || subscribeReadsRegistrations.size > 0)) {
        phaseG_dispatchPerNodeSubscribers(changed, c, now);
      }
      if (commitObservers.size > 0) {
        phaseH_dispatchCommitObservers(c, now);
      }
      if (process.env.NODE_ENV !== "production") {
        if (h1HazardTrack !== null) checkH1HazardOnCommit();
      }
      return c;
    } catch (err) {
      for (let i = 0, n = inputRollbackEntries.length; i < n; i++) {
        const e = inputRollbackEntries[i];
        e.value = inputRollbackPriorValues[i];
        inputSerializableMemo.delete(e.id);
        e.lastWriteTime = inputRollbackPriorLastWrite[i];
      }
      for (let i = 0, n = stagedWriteEntries.length; i < n; i++) {
        stagedWriteEntries[i].lastStagedAt = -1;
      }
      if (derivedRollback.map !== void 0) {
        for (const [id, prior] of derivedRollback.map) {
          const e = entries.get(id);
          if (e && e.kind === "derived") {
            e.value = prior.value;
            setDeps(id, prior.deps);
            e.computed = prior.computed;
            e.lastTime = prior.lastTime;
          }
        }
      }
      if (commitHistorySnapshot !== null) {
        commitHistory.length = 0;
        for (const row of commitHistorySnapshot) commitHistory.push(row);
        commitLogEntry.value = commitLogValueBeforeF4;
        commitLogEntry.lastTime = commitLogLastTimeBeforeF4;
      }
      now = beforeNow;
      throw err;
    } finally {
      if (pendingTransientDrops.size > 0) {
        for (const sub of pendingTransientDrops) {
          if (sub.manyGroup !== null) {
            disposeManyGroup(sub.manyGroup);
            continue;
          }
          const wasPresent = subscriptions.delete(sub);
          const b = subscriptionsByNode.get(sub.node.id);
          if (b !== void 0) {
            b.delete(sub);
            if (b.size === 0) subscriptionsByNode.delete(sub.node.id);
          }
          if (wasPresent) bumpSubscriberRefcountUp(sub.node.id, -1);
          if (wasPresent && sub.node.id === COMMIT_LOG_ID) {
            commitLogConsumerCount--;
          }
          if (wasPresent) transientSubscriberCount--;
        }
        pendingTransientDrops.clear();
      }
      txAlive = false;
      committing = false;
      stagedActive = false;
      stagedWriteEntries.length = 0;
      stagedWriteValues.length = 0;
    }
  }
  function simulate(intent, run) {
    if (committing) throw new CommitInProgressError();
    committing = true;
    stagedWriteEntries.length = 0;
    stagedWriteValues.length = 0;
    stagedActive = true;
    const inputRollbackEntries = [];
    const inputRollbackPriorValues = [];
    const inputRollbackPriorLastWrite = [];
    const beforeNow = now;
    let txAlive = true;
    const tx = {
      set(node, value) {
        if (!txAlive) throw new StaleTxError();
        const id = node.id;
        const e = getEntry(id);
        if (e.kind !== "input") throw new NotAnInputNodeError(id);
        if (!e.hasDependents) {
          if (Object.is(e.value, value)) return;
          if (e.lastWriteTime > now) {
            e.value = value;
            return;
          }
          inputRollbackEntries.push(e);
          inputRollbackPriorValues.push(e.value);
          inputRollbackPriorLastWrite.push(e.lastWriteTime);
          e.value = value;
          e.lastWriteTime = now + 1;
          return;
        }
        if (e.lastStagedAt === now) {
          const idx = e.lastStagedRow;
          if (Object.is(stagedWriteValues[idx], value)) return;
          stagedWriteValues[idx] = value;
          return;
        }
        if (Object.is(e.value, value)) return;
        e.lastStagedAt = now;
        e.lastStagedRow = stagedWriteEntries.length;
        stagedWriteEntries.push(e);
        stagedWriteValues.push(value);
      }
    };
    const changedInputIds = [];
    const derivedRollback = { map: void 0 };
    let prediction = null;
    let predictedError = null;
    try {
      run(tx);
      txAlive = false;
      const fastPathLen = inputRollbackEntries.length;
      if (fastPathLen > 0) {
        let writeIdx = 0;
        for (let i = 0; i < fastPathLen; i++) {
          const e = inputRollbackEntries[i];
          const priorValue = inputRollbackPriorValues[i];
          const priorLastWrite = inputRollbackPriorLastWrite[i];
          if (Object.is(e.value, priorValue)) {
            e.lastWriteTime = priorLastWrite;
            continue;
          }
          if (writeIdx !== i) {
            inputRollbackEntries[writeIdx] = e;
            inputRollbackPriorValues[writeIdx] = priorValue;
            inputRollbackPriorLastWrite[writeIdx] = priorLastWrite;
          }
          writeIdx++;
          changedInputIds.push(e.id);
          inputSerializableMemo.delete(e.id);
        }
        if (writeIdx !== fastPathLen) {
          inputRollbackEntries.length = writeIdx;
          inputRollbackPriorValues.length = writeIdx;
          inputRollbackPriorLastWrite.length = writeIdx;
        }
      }
      for (let i = 0, n = stagedWriteEntries.length; i < n; i++) {
        const e = stagedWriteEntries[i];
        const v = stagedWriteValues[i];
        if (!Object.is(e.value, v)) {
          inputRollbackEntries.push(e);
          inputRollbackPriorValues.push(e.value);
          inputRollbackPriorLastWrite.push(e.lastWriteTime);
          e.value = v;
          inputSerializableMemo.delete(e.id);
          changedInputIds.push(e.id);
        }
      }
      now += 1;
      for (let i = 0, n = inputRollbackEntries.length; i < n; i++) {
        inputRollbackEntries[i].lastWriteTime = now;
      }
      const changed = new Set(changedInputIds);
      const derivedDiff = [];
      if (changedInputIds.length > 0) {
        const downstreamChanged = recomputeAffected(changed, derivedRollback);
        for (const id of downstreamChanged) {
          changed.add(id);
          derivedDiff.push(id);
        }
      }
      const changedNodes = Array.from(changed);
      const c = Object.freeze({
        time: now,
        intent,
        changedNodes: freezeIfDev(changedNodes.slice()),
        originatedAt: void 0
      });
      prediction = { c, derivedDiff };
    } catch (err) {
      predictedError = err;
    } finally {
      for (let i = 0, n = inputRollbackEntries.length; i < n; i++) {
        const e = inputRollbackEntries[i];
        e.value = inputRollbackPriorValues[i];
        inputSerializableMemo.delete(e.id);
        e.lastWriteTime = inputRollbackPriorLastWrite[i];
      }
      if (derivedRollback.map !== void 0) {
        for (const [id, prior] of derivedRollback.map) {
          const e = entries.get(id);
          if (e && e.kind === "derived") {
            e.value = prior.value;
            setDeps(id, prior.deps);
            e.computed = prior.computed;
            e.lastTime = prior.lastTime;
          }
        }
      }
      now = beforeNow;
      txAlive = false;
      committing = false;
      for (let i = 0, n = stagedWriteEntries.length; i < n; i++) {
        stagedWriteEntries[i].lastStagedAt = -1;
      }
      stagedActive = false;
      stagedWriteEntries.length = 0;
      stagedWriteValues.length = 0;
    }
    if (prediction !== null) {
      return {
        status: "clean",
        commit: prediction.c,
        stagedDiff: Object.freeze(changedInputIds.slice()),
        derivedDiff: Object.freeze(prediction.derivedDiff.slice())
      };
    }
    return {
      status: "failed",
      error: predictedError,
      stagedDiff: Object.freeze(changedInputIds.slice())
    };
  }
  function subscribe(node, observer, options2) {
    getEntry(node.id);
    const initialValue = readEntry(node);
    const sub = {
      node,
      observer,
      lastValue: initialValue,
      hasFired: false,
      // PR-B1 stamps registration time as the current GraphTime;
      // the value flows through to `IRSubscribe.time` on export.
      subscribedAt: now,
      // #766 — `transient: true` registers the observer as a one-shot
      // that auto-disposes after the first Phase G fire. Default is
      // `false`, preserving the canonical `subscribe` retain-across-
      // commits contract for every existing call site.
      transient: options2?.transient === true,
      // Plain `subscribe` is not part of a multi-node group; the
      // per-commit dedupe path in Phase G never visits this entry's
      // `manyGroup` slot when it's `null`.
      manyGroup: null
    };
    subscriptions.add(sub);
    let bucket = subscriptionsByNode.get(node.id);
    if (bucket === void 0) {
      bucket = /* @__PURE__ */ new Set();
      subscriptionsByNode.set(node.id, bucket);
    }
    bucket.add(sub);
    bumpSubscriberRefcountUp(node.id, 1);
    if (node.id === COMMIT_LOG_ID) commitLogConsumerCount++;
    if (sub.transient) transientSubscriberCount++;
    try {
      observer(initialValue, now);
      sub.hasFired = true;
    } catch (err) {
      reportObserverError(err, {
        source: "subscribe-initial",
        nodeId: node.id,
        time: now
      });
    }
    return () => {
      const wasPresent = subscriptions.delete(sub);
      const b = subscriptionsByNode.get(node.id);
      if (b !== void 0) {
        b.delete(sub);
        if (b.size === 0) subscriptionsByNode.delete(node.id);
      }
      if (wasPresent) bumpSubscriberRefcountUp(node.id, -1);
      if (wasPresent && node.id === COMMIT_LOG_ID) commitLogConsumerCount--;
      if (wasPresent && sub.transient) transientSubscriberCount--;
    };
  }
  function disposeManyGroup(group) {
    if (group.disposed) return;
    group.disposed = true;
    for (const entry of group.entries) {
      const wasPresent = subscriptions.delete(entry);
      const b = subscriptionsByNode.get(entry.node.id);
      if (b !== void 0) {
        b.delete(entry);
        if (b.size === 0) subscriptionsByNode.delete(entry.node.id);
      }
      if (wasPresent) bumpSubscriberRefcountUp(entry.node.id, -1);
      if (entry.node.id === COMMIT_LOG_ID) commitLogConsumerCount--;
      if (wasPresent && entry.transient) transientSubscriberCount--;
    }
    group.entries.clear();
  }
  function subscribeMany(nodes, observer, options2) {
    for (const node of nodes) {
      getEntry(node.id);
    }
    const transient = options2?.transient === true;
    const observerErased = observer;
    const group = {
      entries: /* @__PURE__ */ new Set(),
      nodes: nodes.slice(),
      observer: observerErased,
      transient,
      disposed: false
    };
    const fireGroupOnce = (_value, _time) => {
      if (group.disposed) return;
      const values = new Array(group.nodes.length);
      for (let i = 0; i < group.nodes.length; i++) {
        values[i] = readEntry(group.nodes[i]);
      }
      observerErased(values);
    };
    for (const node of nodes) {
      const initialValue = readEntry(node);
      const sub = {
        node,
        observer: fireGroupOnce,
        lastValue: initialValue,
        hasFired: false,
        subscribedAt: now,
        transient,
        manyGroup: group
      };
      subscriptions.add(sub);
      let bucket = subscriptionsByNode.get(node.id);
      if (bucket === void 0) {
        bucket = /* @__PURE__ */ new Set();
        subscriptionsByNode.set(node.id, bucket);
      }
      bucket.add(sub);
      bumpSubscriberRefcountUp(node.id, 1);
      if (node.id === COMMIT_LOG_ID) commitLogConsumerCount++;
      if (transient) transientSubscriberCount++;
      group.entries.add(sub);
    }
    try {
      const initialValues = [];
      for (const entry of group.entries) {
        initialValues.push(entry.lastValue);
      }
      observerErased(initialValues);
      for (const entry of group.entries) entry.hasFired = true;
    } catch (err) {
      const firstId = nodes[0]?.id;
      reportObserverError(
        err,
        firstId !== void 0 ? { source: "subscribe-initial", nodeId: firstId, time: now } : { source: "subscribe-initial", time: now }
      );
    }
    return () => {
      disposeManyGroup(group);
    };
  }
  function subscribeCommits(observer) {
    commitObservers.add(observer);
    return () => {
      commitObservers.delete(observer);
    };
  }
  function runProjectionTracked(projection) {
    const prior = activeReadTracker;
    const deps = /* @__PURE__ */ new Set();
    activeReadTracker = deps;
    try {
      const value = projection();
      return { value, deps };
    } finally {
      activeReadTracker = prior;
    }
  }
  function reconcileProjectionDeps(reg, nextDeps) {
    for (const oldDep of reg.recordedDeps) {
      if (!nextDeps.has(oldDep)) {
        const b = subscribeReadsByNode.get(oldDep);
        if (b !== void 0) {
          b.delete(reg);
          if (b.size === 0) subscribeReadsByNode.delete(oldDep);
        }
      }
    }
    for (const newDep of nextDeps) {
      let b = subscribeReadsByNode.get(newDep);
      if (b === void 0) {
        b = /* @__PURE__ */ new Set();
        subscribeReadsByNode.set(newDep, b);
      }
      b.add(reg);
    }
    reg.recordedDeps = nextDeps;
  }
  function subscribeReads(observer, projection) {
    const { value: initialValue, deps: initialDeps } = runProjectionTracked(projection);
    const reg = {
      observer,
      projection,
      // Filled in by `reconcileProjectionDeps` immediately below.
      recordedDeps: /* @__PURE__ */ new Set()
    };
    subscribeReadsRegistrations.add(reg);
    reconcileProjectionDeps(reg, initialDeps);
    try {
      const initialCommit = Object.freeze({
        time: now,
        intent: "subscribe-reads-initial",
        changedNodes: freezeIfDev([]),
        originatedAt: void 0
      });
      observer(initialCommit, initialValue);
    } catch (err) {
      reportObserverError(err, {
        source: "subscribe-reads-initial",
        time: now
      });
    }
    return () => {
      if (!subscribeReadsRegistrations.has(reg)) return;
      subscribeReadsRegistrations.delete(reg);
      for (const dep of reg.recordedDeps) {
        const b = subscribeReadsByNode.get(dep);
        if (b !== void 0) {
          b.delete(reg);
          if (b.size === 0) subscribeReadsByNode.delete(dep);
        }
      }
      reg.recordedDeps = /* @__PURE__ */ new Set();
    };
  }
  function explain(node) {
    getEntry(node.id);
    const explainId = `__explain__:${node.id}`;
    const cached = explainHandles.get(explainId);
    if (cached) return cached;
    const handle = derived(explainId, (get) => {
      return buildExplanation(node.id, get, /* @__PURE__ */ new Set());
    });
    explainHandles.set(explainId, handle);
    return handle;
  }
  function buildExplanation(id, get, stack) {
    if (stack.has(id)) {
      return { via: "cycle", node: id, cycleBackTo: id };
    }
    const entry = entries.get(id);
    if (!entry) return { via: "cycle", node: id, cycleBackTo: id };
    if (entry.kind === "input") {
      const value2 = get(entry.node);
      return Object.freeze({
        via: "input",
        node: id,
        value: value2,
        computedAt: entry.lastWriteTime,
        deps: freezeIfDev([])
      });
    }
    const value = get({ id });
    stack.add(id);
    const deps = [];
    for (const depId of Array.from(entry.deps).sort()) {
      const childEntry = entries.get(depId);
      if (!childEntry) continue;
      const subExplanation = buildExplanation(depId, get, stack);
      const contributedAt = childEntry.kind === "input" ? childEntry.lastWriteTime : childEntry.lastTime;
      deps.push(freezeIfDev({ node: depId, contributedAt, explanation: subExplanation }));
    }
    stack.delete(id);
    const via = entry.tag === "live" ? "live" : "derived";
    return Object.freeze({
      via,
      node: id,
      value,
      computedAt: entry.lastTime,
      deps: freezeIfDev(deps)
    });
  }
  function dependenciesOf(node) {
    const entry = getEntry(node.id);
    if (entry.kind === "input") return Object.freeze([]);
    return Object.freeze([...entry.deps].sort());
  }
  function dependentsOf(node) {
    getEntry(node.id);
    const set = dependents.get(node.id);
    if (!set || set.size === 0) return Object.freeze([]);
    return Object.freeze([...set].sort());
  }
  function exportModel(opts) {
    const maxCommits = opts?.maxCommits ?? 100;
    const captureCallGraph = opts?.captureCallGraph ?? true;
    const nodes = [];
    for (const e of entries.values()) {
      if (e.id === COMMIT_LOG_ID) continue;
      switch (e.kind) {
        case "input":
          nodes.push({
            kind: "input",
            id: e.id,
            graphId,
            // #703 Win 1 — route through the cached probe so a
            // repeated `exportModel` on a quiescent engine doesn't
            // re-stringify each input cell on every call.
            value: isInputValueSerializable(e, inputSerializableMemo) ? e.value : null,
            serializable: isInputValueSerializable(e, inputSerializableMemo)
          });
          break;
        case "derived":
          nodes.push({
            kind: "derived",
            id: e.id,
            graphId,
            deps: Array.from(e.deps).sort(),
            conditionalDeps: [],
            value: serialiseSafely(e.value),
            serializable: isSerializable(e.value)
          });
          break;
        default:
          assertNever(e, "exportModel: unknown entry kind");
      }
    }
    const commits = commitHistory.slice(-maxCommits);
    void captureCallGraph;
    const events = [];
    const defaultScopeId = `${graphId}:default`;
    let exportSubSeq = 0;
    for (const sub of subscriptions) {
      events.push({
        kind: "subscribe",
        graphId,
        id: `${graphId}:s.${++exportSubSeq}`,
        scopeId: defaultScopeId,
        target: sub.node.id,
        callbackSite: "<unknown>",
        time: sub.subscribedAt
      });
    }
    const scopes = [
      {
        id: `${graphId}:default`,
        kind: "infinite",
        lifetime: { origin: "graph-construct", terminator: "process-exit" }
      }
    ];
    return {
      schema: CAUSL_MODEL_SCHEMA,
      time: now,
      nodes,
      commits,
      events,
      scopes,
      bridges: []
    };
  }
  function computeSchemaHash() {
    const tokens = [];
    for (const e of entries.values()) {
      tokens.push(`${e.kind}:${e.id}`);
    }
    tokens.sort();
    let h = 2166136261;
    const str = tokens.join("|");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  function snapshot() {
    const inputs = {};
    for (const e of entries.values()) {
      if (e.kind !== "input") continue;
      if (!isInputValueSerializable(e, inputSerializableMemo)) continue;
      inputs[e.id] = e.value;
    }
    return {
      schema: 1,
      time: now,
      inputs,
      schemaHash: computeSchemaHash()
    };
  }
  function snapshotAt(time) {
    if (retainedSnapshots.length === 0) {
      return { status: "evicted", oldestRetainedTime: now };
    }
    const oldest = retainedSnapshots[0].time;
    if (time < oldest) {
      return { status: "evicted", oldestRetainedTime: oldest };
    }
    let chosen;
    for (const snap of retainedSnapshots) {
      if (snap.time <= time) chosen = snap;
      else break;
    }
    if (!chosen) return { status: "evicted", oldestRetainedTime: oldest };
    const materialised = materialiseRetained(chosen);
    const inputs = {};
    for (const [id, v] of Object.entries(materialised)) {
      if (!isSerializable(v)) continue;
      inputs[id] = cloneForRetention(v);
    }
    return {
      status: "retained",
      time: chosen.time,
      value: {
        schema: 1,
        time: chosen.time,
        inputs,
        schemaHash: computeSchemaHash()
      }
    };
  }
  function hydrate(snap) {
    if (snap.schema !== 1) {
      throw new HydrationSchemaError(
        "schema-version",
        `unsupported schema version ${String(snap.schema)} (expected 1)`
      );
    }
    if (snap.schemaHash !== void 0) {
      const live = computeSchemaHash();
      if (snap.schemaHash !== live) {
        throw new HydrationSchemaError(
          "schema-hash",
          `snapshot schemaHash ${snap.schemaHash} does not match live graph ${live}`
        );
      }
    }
    const writes = [];
    for (const [id, value] of Object.entries(snap.inputs)) {
      const e = entries.get(id);
      if (!e || e.kind !== "input") continue;
      writes.push([id, value]);
    }
    commitInternal(
      "hydrate",
      (tx) => {
        for (const [id, value] of writes) {
          tx.set({ id }, value);
        }
      },
      snap.time
    );
  }
  function _migrateFrom(snap) {
    if (snap.schema !== 1) {
      throw new HydrationSchemaError(
        "schema-version",
        `unsupported schema version ${String(snap.schema)} (expected 1)`
      );
    }
    if (snap.schemaHash !== void 0) {
      const live = computeSchemaHash();
      if (snap.schemaHash !== live) {
        throw new HydrationSchemaError(
          "schema-hash",
          `snapshot schemaHash ${snap.schemaHash} does not match live graph ${live}`
        );
      }
    }
    if (committing) throw new CommitInProgressError();
    if (now !== 0 || commitHistory.length !== 0) {
      throw new Error(
        `_migrateFrom: graph is not in a fresh migration-boundary state (now=${now}, commitHistory.length=${commitHistory.length}). _migrateFrom is only valid on a freshly-registered graph with no prior commits; use Graph.hydrate() to restore a snapshot onto a running graph.`
      );
    }
    const writes = [];
    for (const [id, value] of Object.entries(snap.inputs)) {
      const e = entries.get(id);
      if (!e || e.kind !== "input") continue;
      writes.push([id, value, e]);
    }
    now = snap.time;
    const changedInputIds = [];
    for (const [id, value, e] of writes) {
      if (Object.is(e.value, value)) continue;
      e.value = value;
      e.lastWriteTime = now;
      inputSerializableMemo.delete(id);
      changedInputIds.push(id);
    }
    if (commitHistoryCap > 0 && snapshotRetentionCap > 0) {
      const delta = /* @__PURE__ */ new Map();
      for (const id of changedInputIds) {
        const e = entries.get(id);
        if (e && e.kind === "input" && isInputValueSerializable(e, inputSerializableMemo)) {
          delta.set(id, e.value);
        }
      }
      const head = retainedSnapshots.length > 0 ? retainedSnapshots[retainedSnapshots.length - 1] : null;
      retainedSnapshots.push({ time: now, delta, prev: head });
      while (retainedSnapshots.length > snapshotRetentionCap) {
        const evicted = retainedSnapshots.shift();
        const newRoot = retainedSnapshots[0];
        if (!newRoot) break;
        let cur = evicted;
        while (cur !== null) {
          for (const [id, v] of cur.delta) {
            if (!newRoot.delta.has(id)) {
              newRoot.delta.set(id, v);
            }
          }
          cur = cur.prev;
        }
        newRoot.prev = null;
      }
    }
    if (changedInputIds.length > 0) {
      const seedSet = new Set(changedInputIds);
      recomputeAffected(seedSet);
    }
  }
  function readAt(node, time) {
    const e = entries.get(node.id);
    if (e && e.kind === "input") {
      const registeredAt = inputRegisteredAtMap.get(node.id) ?? 0;
      if (time < registeredAt) {
        return { status: "evicted", oldestRetainedTime: registeredAt };
      }
    }
    if (e && e.kind === "derived" && time < e.derivedRegisteredAt) {
      return { status: "evicted", oldestRetainedTime: e.derivedRegisteredAt };
    }
    if (retainedSnapshots.length === 0) {
      return { status: "evicted", oldestRetainedTime: now };
    }
    const oldest = retainedSnapshots[0].time;
    if (time < oldest) {
      return { status: "evicted", oldestRetainedTime: oldest };
    }
    let chosen;
    for (const snap of retainedSnapshots) {
      if (snap.time <= time) chosen = snap;
      else break;
    }
    if (!chosen) {
      return { status: "evicted", oldestRetainedTime: oldest };
    }
    if (e && e.kind === "input") {
      const lookup = resolveRetained(chosen, node.id);
      if (!lookup.found) {
        return { status: "evicted", oldestRetainedTime: oldest };
      }
      return {
        status: "retained",
        value: cloneForRetention(lookup.value),
        time: chosen.time
      };
    }
    if (e && e.kind === "derived") {
      const value = recomputeFromSnapshot(e.id, chosen);
      return { status: "retained", value, time: chosen.time };
    }
    return { status: "evicted", oldestRetainedTime: oldest };
  }
  function recomputeFromSnapshot(id, snapshotRow, memo = /* @__PURE__ */ new Map(), inFlight = /* @__PURE__ */ new Set()) {
    if (memo.has(id)) return memo.get(id);
    const e = entries.get(id);
    if (!e) throw new UnknownNodeError(id);
    if (e.kind === "input") {
      const lookup = resolveRetained(snapshotRow, id);
      const v = lookup.found ? lookup.value : e.value;
      memo.set(id, v);
      return v;
    }
    if (inFlight.has(id)) {
      throw new CycleError([...inFlight, id]);
    }
    inFlight.add(id);
    const get = (n) => recomputeFromSnapshot(n.id, snapshotRow, memo, inFlight);
    const value = e.compute(get);
    inFlight.delete(id);
    memo.set(id, value);
    return value;
  }
  function _dispose(node) {
    const id = node.id;
    const e = entries.get(id);
    if (!e) return;
    if (committing) throw new DisposalDuringCommitError(id);
    const downstream = dependents.get(id);
    if (downstream && downstream.size > 0) {
      throw new NodeHasDependentsError(id, [...downstream]);
    }
    if (e.kind === "derived") {
      for (const dep of e.deps) {
        const bucket = dependents.get(dep);
        if (bucket !== void 0) {
          bucket.delete(id);
          if (bucket.size === 0) {
            const upstream = entries.get(dep);
            if (upstream !== void 0 && upstream.kind === "input") {
              upstream.hasDependents = false;
            }
          }
        }
      }
      if (e.tag === "commit-metadata") {
        commitLogConsumerCount--;
      } else if (e.deps.has(COMMIT_LOG_ID)) {
        commitLogConsumerCount--;
      }
    }
    dependents.delete(id);
    for (const sub of subscriptions) {
      if (sub.node.id === id) {
        subscriptions.delete(sub);
        bumpSubscriberRefcountUp(sub.node.id, -1);
        if (id === COMMIT_LOG_ID) commitLogConsumerCount--;
        if (sub.transient) transientSubscriberCount--;
      }
    }
    subscriptionsByNode.delete(id);
    const projBucket = subscribeReadsByNode.get(id);
    if (projBucket !== void 0) {
      for (const reg of projBucket) {
        reg.recordedDeps.delete(id);
      }
      subscribeReadsByNode.delete(id);
    }
    if (disposed.has(id)) {
      disposed.delete(id);
    }
    entries.delete(id);
    if (e.kind === "input") inputCount--;
    else derivedCount--;
    inputRegisteredAtMap.delete(id);
    inputSerializableMemo.delete(id);
    commitMetadataIds.delete(id);
    nodeVersions.delete(id);
    subscriberRefcount.delete(id);
    disposed.set(id, now);
    while (disposed.size > disposedTombstoneCap) {
      const oldest = disposed.keys().next().value;
      if (oldest === void 0) break;
      disposed.delete(oldest);
    }
  }
  function stats() {
    return {
      inputs: inputCount,
      deriveds: derivedCount,
      subscribersTotal: subscriptions.size,
      subscribersByNodeKeys: subscriptionsByNode.size,
      transientSubscribers: transientSubscriberCount,
      commitObservers: commitObservers.size,
      commitMetadataDeriveds: commitMetadataIds.size,
      commitLogConsumerCount,
      entries: entries.size,
      lastCommitTime: now,
      retainedCommits: commitHistory.length,
      // #1242 — per-node version accessor (SPEC §15.1). Closure-captured
      // lookup against the `nodeVersions` Map maintained alongside the
      // existing `changed` set in `commitInternal`'s success arm (post
      // Phase F.5 / pre Phase G). Returns `0` for a never-changed node,
      // including nodes the engine has never seen, so adopters can
      // safely call `nodeVersion(node)` without preconditioning on
      // registration. Disposed nodes have their entry deleted in
      // `_dispose`, so a future reuse under generational NodeId (#1164)
      // starts from a fresh counter at 0. Function reference is hoisted
      // (see `nodeVersionAccessor` declaration above) so sequential
      // `stats()` snapshots share the same closure identity — the leak-
      // gate `expect(s1).toEqual(s2)` test in `stats.test.ts` compares
      // function-typed fields by reference under vitest's deep-equal,
      // and a fresh closure per call would defeat that gate.
      nodeVersion: nodeVersionAccessor
    };
  }
  const backend = new JsBackend({
    commit: (intent, writes) => commit(intent, (tx) => {
      for (const [id, value] of writes) {
        tx.set({ id }, value);
      }
    }),
    read: (node) => read(node),
    subscribe: (node, observer) => subscribe(node, observer),
    subscribeCommits: (observer) => subscribeCommits(observer),
    snapshot: () => snapshot(),
    hydrate: (snap) => {
      hydrate(snap);
    },
    exportModel: () => exportModel(),
    readAt: (node, time) => readAt(node, time),
    snapshotAt: (time) => snapshotAt(time),
    dispose: (node) => {
      _dispose(node);
    },
    // `evaluateStatechart` — SPEC §6 composite-statechart extension
    // point landed by issue #1068 as the deferred-from-#698 work. The
    // default implementation lives in `./statechart-evaluator.ts` and
    // mirrors the sync-side reducers (`reduceConflict` /
    // `reduceResource` in `@causl/sync/src/statechart-reducers.ts`)
    // structurally. A cross-backend determinism gate verifies the two
    // implementations stay byte-equivalent; the WASM backend's
    // `evaluateStatechart` (Sub-D of EPIC #680) replaces this with a
    // Rust-side implementation consuming the
    // `tools/engine-rs-core/src/statechart_reducers.rs` enums (gated
    // behind `feature = "future"`).
    evaluateStatechart: (input2) => evaluateStatechart(input2),
    now: () => now
  });
  const graph = {
    input,
    derived,
    commitMetadataDerived,
    commit,
    simulate,
    read: (node) => backend.read(node),
    subscribe: (node, observer, options2) => (
      // The Graph surface's `subscribe` accepts a `transient: true`
      // option (#766) that the BackendEngine seam does not carry —
      // transient observers are an adopter-facing convenience, not a
      // backend-storage concept. Route the no-options arity through
      // the backend; fall back to the closure's full surface when
      // options are present.
      options2 === void 0 ? backend.subscribe(node, observer) : subscribe(node, observer, options2)
    ),
    subscribeMany,
    subscribeCommits: (observer) => backend.subscribeCommits(observer),
    subscribeReads,
    explain,
    dependencies: dependenciesOf,
    dependents: dependentsOf,
    exportModel: (opts) => (
      // The Graph surface's `exportModel` accepts caller tuning
      // (commit-log cap); the BackendEngine seam takes no options.
      // Route the no-options arity through the backend; fall back to
      // the closure for the tuned form.
      opts === void 0 ? backend.exportModel() : exportModel(opts)
    ),
    snapshot: () => backend.snapshot(),
    snapshotAt: (time) => backend.snapshotAt(time),
    hydrate: (snap) => backend.hydrate(snap),
    readAt: (node, time) => backend.readAt(node, time),
    get now() {
      return backend.now;
    },
    commitLog: commitLogNode,
    stats
  };
  registerInternalDispatch(graph, {
    dispose: (node) => backend.dispose(node),
    _migrateFrom: (snap) => _migrateFrom(snap),
    // #1241 — adapter-exemption seam. Routes through the
    // closure-scoped `runInAdapterReadMode` helper which manages the
    // H1 hazard tracker's depth counter. See
    // `InternalDispatch.__causlAdapterRead` for the contract.
    __causlAdapterRead: (fn) => runInAdapterReadMode(fn)
  });
  registerTestingDispatch(graph, {
    disposedTombstoneSize: () => disposed.size,
    commitLogConsumerCount: () => commitLogConsumerCount,
    // #703 Win 3 — expose the live deps Set so the
    // setDeps-immutability property suite can capture a reference
    // and verify subsequent commits leave it byte-identical.
    derivedDeps: (id) => {
      const e = entries.get(id);
      if (!e || e.kind !== "derived") return null;
      return e.deps;
    }
  });
  return graph;
}
function cloneForRetention(value) {
  if (value === null || value === void 0) return value;
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}
function isSerializable(value) {
  if (value === null || value === void 0) return true;
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean") return true;
  if (t === "function" || t === "symbol") return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
function isInputValueSerializable(e, memoMap) {
  const memo = memoMap.get(e.id);
  if (memo !== void 0) return memo;
  const verdict = isSerializable(e.value);
  memoMap.set(e.id, verdict);
  return verdict;
}
function serialiseSafely(value) {
  if (isSerializable(value)) return value;
  return null;
}

// src/schema.ts
var causlModelJsonSchema = {
  // Document-level metadata: dialect, identifier, and human-readable title.
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://causl.dev/schemas/causl-model-v3.json",
  title: "CauslModel",
  type: "object",
  // Top-level required keys; mirrors the CauslModel interface.
  // The shape is closed by `additionalProperties: false`: schema 3
  // adds `events` (lifecycle stream), `scopes` (scope registry), and
  // `bridges` (cross-graph allowlist). Adapter packages that need
  // richer model state ship a sibling document the checker reads
  // alongside the engine IR; they do not extend `CauslModel` itself.
  required: ["schema", "time", "nodes", "commits", "events", "scopes", "bridges"],
  additionalProperties: false,
  properties: {
    // Pinned schema version: must equal CAUSL_MODEL_SCHEMA exactly.
    schema: { const: CAUSL_MODEL_SCHEMA },
    // GraphTime is a non-negative integer counting committed moments.
    time: { type: "integer", minimum: 0 },
    // Node array: each element is either an IRInput or an IRDerived.
    // The `oneOf` is the wire-level expression of §4's two-primitive
    // commitment — adding a third arm here would be a schema break
    // and must clear the same bar as adding a third `kind` to the
    // engine's runtime universe.
    nodes: {
      type: "array",
      items: {
        oneOf: [
          // IRInput shape — writable Behavior snapshot.
          {
            type: "object",
            required: ["kind", "id", "graphId", "value", "serializable"],
            additionalProperties: false,
            properties: {
              kind: { const: "input" },
              id: { type: "string", minLength: 1 },
              graphId: { type: "string", minLength: 1 },
              value: {},
              serializable: { type: "boolean" }
            }
          },
          // IRDerived shape — composed Behavior with dep edges.
          {
            type: "object",
            required: ["kind", "id", "graphId", "deps", "conditionalDeps", "value", "serializable"],
            additionalProperties: false,
            properties: {
              kind: { const: "derived" },
              id: { type: "string", minLength: 1 },
              graphId: { type: "string", minLength: 1 },
              deps: { type: "array", items: { type: "string" } },
              conditionalDeps: { type: "array", items: { type: "string" } },
              value: {},
              serializable: { type: "boolean" }
            }
          }
        ]
      }
    },
    // Capped commit log used for replay-determinism checks. Each
    // commit carries `graphId` (schema-3 multi-graph foreign key); the
    // optional `originatedAt`, `callGraph`, and `originEvent` fields
    // are reserved by schema 3 and emitted by the exporter when their
    // capture options are enabled.
    commits: {
      type: "array",
      items: {
        type: "object",
        required: ["time", "graphId", "intent", "changedNodes"],
        additionalProperties: false,
        properties: {
          time: { type: "integer", minimum: 0 },
          graphId: { type: "string", minLength: 1 },
          intent: { type: "string" },
          changedNodes: { type: "array", items: { type: "string" } },
          originatedAt: { type: "integer", minimum: 0 },
          callGraph: {
            type: "object",
            required: ["frames", "truncatedDeeper"],
            additionalProperties: false,
            properties: {
              frames: { type: "array" },
              truncatedDeeper: { type: "boolean" }
            }
          },
          originEvent: { type: "string" }
        }
      }
    },
    // Lifecycle event stream. Closed under `oneOf` on the `kind`
    // discriminator. Adding a seventh variant requires bumping the
    // schema and is caught at every `assertNever`-guarded reading
    // site in the engine and the checker.
    events: {
      type: "array",
      items: {
        oneOf: [
          // IRSubscribe — observer registration.
          {
            type: "object",
            required: ["kind", "graphId", "id", "scopeId", "target", "callbackSite", "time"],
            additionalProperties: false,
            properties: {
              kind: { const: "subscribe" },
              graphId: { type: "string", minLength: 1 },
              id: { type: "string", minLength: 1 },
              scopeId: { type: "string", minLength: 1 },
              target: { type: "string", minLength: 1 },
              callbackSite: { type: "string" },
              time: { type: "integer", minimum: 0 }
            }
          },
          // IRSubscribeCallback — observer invocation frame.
          {
            type: "object",
            required: ["kind", "graphId", "id", "subscribeId", "firedAt"],
            additionalProperties: false,
            properties: {
              kind: { const: "subscribe-callback" },
              graphId: { type: "string", minLength: 1 },
              id: { type: "string", minLength: 1 },
              subscribeId: { type: "string", minLength: 1 },
              firedAt: { type: "integer", minimum: 0 }
            }
          },
          // IRUnsubscribe — subscription teardown.
          {
            type: "object",
            required: ["kind", "graphId", "id", "scopeId", "time"],
            additionalProperties: false,
            properties: {
              kind: { const: "unsubscribe" },
              graphId: { type: "string", minLength: 1 },
              id: { type: "string", minLength: 1 },
              scopeId: { type: "string", minLength: 1 },
              time: { type: "integer", minimum: 0 }
            }
          },
          // IRDispose — node removal with half-open
          // [enqueueAt, appliedAt] interval per the brutal-critical
          // review's recommendation #5.
          {
            type: "object",
            required: ["kind", "graphId", "nodeId", "scopeId", "time", "disposeAt"],
            additionalProperties: false,
            properties: {
              kind: { const: "dispose" },
              graphId: { type: "string", minLength: 1 },
              nodeId: { type: "string", minLength: 1 },
              scopeId: { type: "string", minLength: 1 },
              time: { type: "integer", minimum: 0 },
              disposeAt: {
                type: "array",
                items: { type: "integer", minimum: 0 }
              }
            }
          },
          // IRRead — per-commit derived-read summary.
          {
            type: "object",
            required: ["kind", "graphId", "derivedId", "readNodeId", "time", "seq", "truncated"],
            additionalProperties: false,
            properties: {
              kind: { const: "read" },
              graphId: { type: "string", minLength: 1 },
              derivedId: { type: "string", minLength: 1 },
              readNodeId: { type: "string", minLength: 1 },
              time: { type: "integer", minimum: 0 },
              seq: { type: "integer", minimum: 0 },
              truncated: { type: "boolean" }
            }
          },
          // IRTxSet — `tx.set(input, value)` event.
          {
            type: "object",
            required: ["kind", "graphId", "inputId", "time"],
            additionalProperties: false,
            properties: {
              kind: { const: "tx-set" },
              graphId: { type: "string", minLength: 1 },
              inputId: { type: "string", minLength: 1 },
              time: { type: "integer", minimum: 0 }
            }
          }
        ]
      }
    },
    // Lifecycle scopes referenced by IRSubscribe / IRUnsubscribe /
    // IRDispose. Closed at three `kind` arms.
    scopes: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "kind", "lifetime"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { enum: ["ephemeral", "infinite", "process-exit"] },
          lifetime: {
            type: "object",
            required: ["origin", "terminator"],
            additionalProperties: false,
            properties: {
              origin: { type: "string" },
              terminator: { type: "string" }
            }
          }
        }
      }
    },
    // Sanctioned cross-graph dependency declarations. Closed at
    // three `policy` arms.
    bridges: {
      type: "array",
      items: {
        type: "object",
        required: ["from", "to", "dep", "policy"],
        additionalProperties: false,
        properties: {
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
          dep: { type: "string", minLength: 1 },
          policy: { enum: ["legacy-allow", "test-only", "read-only"] }
        }
      }
    }
  }
};

// src/bridge.ts
async function detectFeatures() {
  const gc = await probeWasmGc();
  const jsStringBuiltins = await probeJsStringBuiltins();
  const sharedMemory = probeSharedMemory();
  const stringView = await probeStringView();
  return Object.freeze({ gc, jsStringBuiltins, sharedMemory, stringView });
}
async function tryCompile(bytes) {
  try {
    if (typeof WebAssembly === "undefined" || typeof WebAssembly.compile !== "function") {
      return false;
    }
    await WebAssembly.compile(bytes);
    return true;
  } catch {
    return false;
  }
}
async function probeWasmGc() {
  const bytes = new Uint8Array([
    0,
    97,
    115,
    109,
    // \0asm
    1,
    0,
    0,
    0,
    // version 1
    1,
    4,
    1,
    96,
    0,
    0,
    // type section: () -> ()
    3,
    2,
    1,
    0,
    // function section: one function of type 0
    10,
    7,
    1,
    5,
    0,
    208,
    110,
    26,
    11
    // code section: ref.null any (0xd0 0x6e), drop (0x1a), end (0x0b)
  ]);
  return tryCompile(bytes);
}
async function probeJsStringBuiltins() {
  const bytes = new Uint8Array([
    0,
    97,
    115,
    109,
    // \0asm
    1,
    0,
    0,
    0,
    // version 1
    // type section: (param externref) -> (i32)
    1,
    6,
    1,
    96,
    1,
    111,
    1,
    127,
    // import section: "wasm:js-string" . "length" : func type 0
    2,
    28,
    1,
    14,
    119,
    97,
    115,
    109,
    58,
    106,
    115,
    45,
    115,
    116,
    114,
    105,
    110,
    103,
    6,
    108,
    101,
    110,
    103,
    116,
    104,
    0,
    0
  ]);
  return tryCompile(bytes);
}
function probeSharedMemory() {
  try {
    const isolation = globalThis.crossOriginIsolated;
    if (isolation === false) return false;
    if (typeof WebAssembly === "undefined" || typeof WebAssembly.Memory !== "function") {
      return false;
    }
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return true;
  } catch {
    return false;
  }
}
async function probeStringView() {
  const bytes = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    1,
    6,
    1,
    96,
    1,
    111,
    1,
    127,
    2,
    38,
    1,
    24,
    119,
    97,
    115,
    109,
    58,
    115,
    116,
    114,
    105,
    110,
    103,
    45,
    118,
    105,
    101,
    119,
    47,
    119,
    116,
    102,
    49,
    54,
    6,
    108,
    101,
    110,
    103,
    116,
    104,
    0,
    0
  ]);
  return tryCompile(bytes);
}
function readBridgeOverride() {
  try {
    const proc = globalThis.process;
    const raw = proc?.env?.CAUSL_WASM_BRIDGE;
    if (raw === "gc" || raw === "serde" || raw === "auto") return raw;
    return void 0;
  } catch {
    return void 0;
  }
}
function makeSerdeJsonPlaceholder() {
  const placeholderError = () => new Error(
    "[@causl/core] serde-json bridge is a placeholder pending #693. Real implementation lands with the wasm-pack pipeline."
  );
  const features = Object.freeze({
    gc: false,
    jsStringBuiltins: false,
    sharedMemory: false,
    stringView: false
  });
  return Object.freeze({
    id: "serde-json",
    features,
    abiVersion: 0,
    toWasmObject() {
      throw placeholderError();
    },
    fromWasmObject() {
      throw placeholderError();
    },
    toWasmString() {
      throw placeholderError();
    },
    fromWasmString() {
      throw placeholderError();
    },
    release() {
    }
  });
}
async function detectBridge() {
  let features;
  try {
    features = await detectFeatures();
  } catch {
    features = Object.freeze({
      gc: false,
      jsStringBuiltins: false,
      sharedMemory: false,
      stringView: false
    });
  }
  const explicit = readBridgeOverride();
  if (explicit === "serde") {
    return loadSerdeBridge(features);
  }
  if (explicit === "gc" || features.gc && features.jsStringBuiltins) {
    try {
      return await loadGcBridge(features);
    } catch {
    }
  }
  if (features.gc) {
    try {
      return await loadGcClassicBridge(features);
    } catch {
    }
  }
  return loadSerdeBridge(features);
}
async function loadGcBridge(_features) {
  await Promise.resolve();
  return makeSerdeJsonPlaceholder();
}
async function loadGcClassicBridge(_features) {
  await Promise.resolve();
  return makeSerdeJsonPlaceholder();
}
function loadSerdeBridge(_features) {
  return makeSerdeJsonPlaceholder();
}

// src/index.ts
var VERSION = "0.0.0";

export {
  CauslError,
  DuplicateNodeError,
  UnknownNodeError,
  NotAnInputNodeError,
  CommitInProgressError,
  CycleError,
  StaleTxError,
  NodeDisposedError,
  NodeHasDependentsError,
  HydrationSchemaError,
  DisposalDuringCommitError,
  NonDeterministicComputeError,
  DerivedRegistrationStackOverflowError,
  InvalidGraphNameError,
  DEFAULT_THRESHOLDS,
  shouldMigrate,
  evaluateStatechart,
  CAUSL_MODEL_SCHEMA,
  parseCauslModel,
  GRAPH_ID_REGEX,
  createCausl,
  causlModelJsonSchema,
  detectFeatures,
  detectBridge,
  VERSION
};
