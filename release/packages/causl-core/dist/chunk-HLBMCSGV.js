// src/internal-dispatch.ts
var registry = /* @__PURE__ */ new WeakMap();
function registerInternalDispatch(graph, dispatch) {
  registry.set(graph, dispatch);
}
function lookupInternalDispatch(graph) {
  const d = registry.get(graph);
  if (!d) {
    throw new Error(
      "Graph was not produced by createCausl() \u2014 internal dispatch unavailable. Did you pass an unrelated object to an @causl/core/internal helper?"
    );
  }
  return d;
}

// src/internal.ts
var INTERNAL_ENTRYPOINT = "@causl/core/internal";
function dispose(graph, node) {
  lookupInternalDispatch(graph).dispose(node);
}
function _migrateFrom(graph, snap) {
  lookupInternalDispatch(graph)._migrateFrom(snap);
}
function __causlAdapterRead(graph, fn) {
  return lookupInternalDispatch(graph).__causlAdapterRead(fn);
}
function assertNever(value, hint = "unhandled discriminator") {
  throw new Error(`${hint}: ${JSON.stringify(value)}`);
}
var CapabilityViolation = class extends Error {
  attempt;
  constructor(attempt) {
    super(
      `CapabilityViolation: tried to invoke '${attempt}' on a narrowed ReadOnlyGraph. Selectors and listeners must not mutate or register; if you need authority over the engine, accept a full Graph parameter at the call site rather than reach for ambient capability.`
    );
    this.name = "CapabilityViolation";
    this.attempt = attempt;
  }
};
function narrowCapability(graph) {
  const allowed = {
    read(node) {
      return graph.read(node);
    },
    subscribe(node, observer) {
      return graph.subscribe(node, observer);
    },
    subscribeCommits(observer) {
      return graph.subscribeCommits(observer);
    },
    get now() {
      return graph.now;
    }
  };
  return new Proxy(allowed, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      throw new CapabilityViolation(String(prop));
    },
    set(_target, prop) {
      throw new CapabilityViolation(`set:${String(prop)}`);
    },
    deleteProperty(_target, prop) {
      throw new CapabilityViolation(`delete:${String(prop)}`);
    }
  });
}

export {
  registerInternalDispatch,
  INTERNAL_ENTRYPOINT,
  dispose,
  _migrateFrom,
  __causlAdapterRead,
  assertNever,
  CapabilityViolation,
  narrowCapability
};
