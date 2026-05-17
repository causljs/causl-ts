// src/update.ts
function runMessages(update, graph, messages) {
  for (const msg of messages) {
    update(msg, graph);
  }
  return graph;
}
function createUpdate(handlers) {
  return (msg, graph) => {
    const handler = handlers[msg.kind];
    if (!handler) {
      throw new Error(`No handler for Msg kind "${String(msg.kind)}"`);
    }
    handler(msg, graph);
  };
}

// src/msg.ts
var PAYLOAD_MARKER = Object.freeze({});
function payload() {
  return PAYLOAD_MARKER;
}
function defineMsgs(spec) {
  const builder = {};
  for (const key of Object.keys(spec)) {
    const marker = spec[key];
    if (marker === null) {
      builder[key] = () => ({ kind: key });
    } else {
      builder[key] = (p) => ({ ...p, kind: key });
    }
  }
  builder._union = void 0;
  return builder;
}
function assertNever(value) {
  throw new Error(`assertNever: unexpected Msg variant ${JSON.stringify(value)}`);
}

// src/context.ts
import { createContext } from "react";
var CauslContext = createContext(null);
CauslContext.displayName = "CauslContext";

// src/Provider.tsx
import { useMemo } from "react";
import { jsx } from "react/jsx-runtime";
function CauslProvider(props) {
  const { graph, update, children } = props;
  const families = useMemo(() => /* @__PURE__ */ new Map(), [graph]);
  const value = useMemo(
    () => update ? { graph, update, families } : { graph, families },
    [graph, update, families]
  );
  return /* @__PURE__ */ jsx(CauslContext.Provider, { value, children });
}

// src/useCausl.ts
import { __causlAdapterRead, narrowCapability } from "@causl/core/internal";
import { useCallback, useContext, useDebugValue, useMemo as useMemo2, useRef, useSyncExternalStore } from "react";
function useCausl(selector) {
  const ctx = useContext(CauslContext);
  if (!ctx) {
    throw new Error("useCausl must be used inside <CauslProvider>");
  }
  const { graph } = ctx;
  const cap = useMemo2(() => narrowCapability(graph), [graph]);
  const lastValue = useRef(null);
  const subscribe = useCallback(
    (onChange) => graph.subscribeCommits(() => onChange()),
    [graph]
  );
  const getSnapshot = useCallback(() => {
    return __causlAdapterRead(graph, () => {
      const next = selector(cap);
      if (lastValue.current && lastValue.current.from === graph) {
        if (Object.is(lastValue.current.value, next)) {
          return lastValue.current.value;
        }
      }
      lastValue.current = { value: next, from: graph };
      return next;
    });
  }, [graph, cap, selector]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useDebugValue(value);
  return value;
}

// src/useCauslShallow.ts
import { __causlAdapterRead as __causlAdapterRead2, narrowCapability as narrowCapability2 } from "@causl/core/internal";
import { useCallback as useCallback2, useContext as useContext2, useDebugValue as useDebugValue2, useMemo as useMemo3, useRef as useRef2, useSyncExternalStore as useSyncExternalStore2 } from "react";
function useCauslShallow(selector) {
  const ctx = useContext2(CauslContext);
  if (!ctx) {
    throw new Error("useCauslShallow must be used inside <CauslProvider>");
  }
  const { graph } = ctx;
  const cap = useMemo3(() => narrowCapability2(graph), [graph]);
  const lastValue = useRef2(null);
  const subscribe = useCallback2(
    (onChange) => graph.subscribeCommits(() => onChange()),
    [graph]
  );
  const getSnapshot = useCallback2(() => {
    return __causlAdapterRead2(graph, () => {
      const next = selector(cap);
      if (lastValue.current && lastValue.current.from === graph) {
        if (shallowEqual(lastValue.current.value, next)) {
          return lastValue.current.value;
        }
      }
      lastValue.current = { value: next, from: graph };
      return next;
    });
  }, [graph, cap, selector]);
  const value = useSyncExternalStore2(subscribe, getSnapshot, getSnapshot);
  useDebugValue2(value);
  return value;
}
function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null) return false;
  if (typeof b !== "object" || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is(a[k], b[k])) {
      return false;
    }
  }
  return true;
}

// src/useCauslNode.ts
import { __causlAdapterRead as __causlAdapterRead3 } from "@causl/core/internal";
import { useCallback as useCallback3, useContext as useContext3, useDebugValue as useDebugValue3, useSyncExternalStore as useSyncExternalStore3 } from "react";
function useCauslNode(node) {
  const ctx = useContext3(CauslContext);
  if (!ctx) {
    throw new Error("useCauslNode must be used inside <CauslProvider>");
  }
  const { graph } = ctx;
  const subscribe = useCallback3(
    (onChange) => graph.subscribe(node, () => onChange()),
    [graph, node]
  );
  const getSnapshot = useCallback3(
    () => __causlAdapterRead3(graph, () => graph.read(node)),
    [graph, node]
  );
  const value = useSyncExternalStore3(subscribe, getSnapshot, getSnapshot);
  useDebugValue3(value);
  return value;
}

// src/useCauslTypedArrayNode.ts
import { __causlAdapterRead as __causlAdapterRead4 } from "@causl/core/internal";
import { useCallback as useCallback4, useContext as useContext4, useDebugValue as useDebugValue4, useRef as useRef3, useSyncExternalStore as useSyncExternalStore4 } from "react";
var wasmBackendAvailable = null;
var wasmBackendProbe = null;
function probeWasmBackend() {
  if (wasmBackendProbe) return wasmBackendProbe;
  wasmBackendProbe = (async () => {
    try {
      const mod = await import("@causl/core/wasm");
      await mod.loadWasmBackend();
      wasmBackendAvailable = true;
      return true;
    } catch {
      wasmBackendAvailable = false;
      return false;
    }
  })();
  return wasmBackendProbe;
}
void probeWasmBackend();
function useCauslTypedArrayNode(node, ctor) {
  const ctx = useContext4(CauslContext);
  if (!ctx) {
    throw new Error("useCauslTypedArrayNode must be used inside <CauslProvider>");
  }
  const { graph } = ctx;
  const cache = useRef3(null);
  const subscribe = useCallback4(
    (onChange) => graph.subscribe(node, () => onChange()),
    [graph, node]
  );
  const getSnapshot = useCallback4(() => {
    return __causlAdapterRead4(graph, () => {
      const raw = graph.read(node);
      const cached = cache.current;
      if (cached && cached.graph === graph && Object.is(cached.raw, raw)) {
        return cached.view;
      }
      void wasmBackendAvailable;
      const view = coerceToTypedArray(raw, ctor);
      cache.current = { raw, view, graph };
      return view;
    });
  }, [graph, node, ctor]);
  const value = useSyncExternalStore4(subscribe, getSnapshot, getSnapshot);
  useDebugValue4(value);
  return value;
}
function coerceToTypedArray(raw, ctor) {
  if (raw instanceof ctor) return raw;
  if (raw == null) return new ctor(0);
  return ctor.from(raw);
}

// src/useDispatch.ts
import { useCallback as useCallback5, useContext as useContext5 } from "react";
function useDispatch() {
  const ctx = useContext5(CauslContext);
  if (!ctx) {
    throw new Error("useDispatch must be used inside <CauslProvider>");
  }
  const { graph, update } = ctx;
  return useCallback5(
    (msg) => {
      if (!update) {
        throw new Error(
          "useDispatch called but no `update` function was supplied to <CauslProvider>"
        );
      }
      ;
      update(msg, graph);
    },
    [graph, update]
  );
}

// src/useCauslFamily.ts
import { __causlAdapterRead as __causlAdapterRead5, dispose } from "@causl/core/internal";
import { useContext as useContext6, useEffect } from "react";
function useCauslFamily(key, factory) {
  const ctx = useContext6(CauslContext);
  if (!ctx) {
    throw new Error("useCauslFamily must be used inside <CauslProvider>");
  }
  const { graph, families } = ctx;
  let entry = families.get(key);
  if (!entry) {
    const node = __causlAdapterRead5(
      graph,
      () => factory(graph, key)
    );
    entry = { node, refcount: 0 };
    families.set(key, entry);
  }
  const resolved = entry;
  useEffect(() => {
    const e = families.get(key);
    if (!e) return;
    e.refcount++;
    return () => {
      e.refcount--;
      if (e.refcount <= 0) {
        queueMicrotask(() => {
          if (e.refcount <= 0 && families.get(key) === e) {
            families.delete(key);
            dispose(graph, e.node);
          }
        });
      }
    };
  }, [graph, families, key]);
  return resolved.node;
}

// src/useCauslSuspense.ts
import { assertNever as assertNever2 } from "@causl/core/internal";
import { useContext as useContext7 } from "react";
var idlePromiseByGraph = /* @__PURE__ */ new WeakMap();
function idlePromiseFor(graph) {
  const cached = idlePromiseByGraph.get(graph);
  if (cached) return cached;
  const promise = new Promise((resolve) => {
    const unsubscribe = graph.subscribeCommits(() => {
      idlePromiseByGraph.delete(graph);
      unsubscribe();
      resolve(void 0);
    });
  });
  idlePromiseByGraph.set(graph, promise);
  return promise;
}
function useCauslSuspense(selector) {
  const ctx = useContext7(CauslContext);
  if (!ctx) {
    throw new Error("useCauslSuspense must be used inside <CauslProvider>");
  }
  const result = useCausl(selector);
  switch (result.state) {
    case "loaded":
    case "stale":
      return result.value;
    case "errored":
      throw result.error;
    case "loading":
      throw result.promise;
    case "idle":
      throw idlePromiseFor(ctx.graph);
    default:
      return assertNever2(result);
  }
}

// src/Hydrate.tsx
import { useContext as useContext8, useLayoutEffect } from "react";
import { Fragment, jsx as jsx2 } from "react/jsx-runtime";
var hydratedSnapshotByGraph = /* @__PURE__ */ new WeakMap();
function Hydrate({ snapshot, children }) {
  const ctx = useContext8(CauslContext);
  if (!ctx) {
    throw new Error("<Hydrate> must be used inside <CauslProvider>");
  }
  useLayoutEffect(() => {
    const g = ctx.graph;
    if (hydratedSnapshotByGraph.get(g) === snapshot) return;
    g.hydrate(snapshot);
    hydratedSnapshotByGraph.set(g, snapshot);
  }, [ctx.graph]);
  return /* @__PURE__ */ jsx2(Fragment, { children });
}

// src/index.ts
var VERSION = "0.0.0";
export {
  CauslContext,
  CauslProvider,
  Hydrate,
  VERSION,
  assertNever,
  createUpdate,
  defineMsgs,
  payload,
  runMessages,
  shallowEqual,
  useCausl,
  useCauslFamily,
  useCauslNode,
  useCauslShallow,
  useCauslSuspense,
  useCauslTypedArrayNode,
  useDispatch
};
