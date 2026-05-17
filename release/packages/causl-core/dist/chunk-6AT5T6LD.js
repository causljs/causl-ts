// src/testing-dispatch.ts
var registry = /* @__PURE__ */ new WeakMap();
function registerTestingDispatch(graph, dispatch) {
  registry.set(graph, dispatch);
}
function lookupTestingDispatch(graph) {
  const d = registry.get(graph);
  if (!d) {
    throw new Error(
      "Graph was not produced by createCausl() \u2014 testing dispatch unavailable. Did you pass an unrelated object to an @causl/core/testing helper?"
    );
  }
  return d;
}

export {
  registerTestingDispatch,
  lookupTestingDispatch
};
