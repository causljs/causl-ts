import {
  ForbiddenConflictTransitionError,
  createConflictRegistry,
  singleConflictWhen
} from "./chunk-VQ2KA4QN.js";
import {
  ForbiddenResourceTransitionError,
  resource
} from "./chunk-QBSGDGLK.js";
import "./chunk-V4VSRV4P.js";

// src/whyUpdated.ts
var RESOURCE_UPDATE_REASONS = Object.freeze([
  "fetch-begin",
  "fetch-resolved",
  "fetch-stale",
  "fetch-rejected",
  "invalidated",
  "failed",
  "dep-changed"
]);
function whyUpdated(commit, _prev, _next) {
  const intent = commit.intent;
  if (intent.startsWith("fetch:") && intent.endsWith(":start")) {
    return "fetch-begin";
  }
  if (intent.startsWith("fetch:") && intent.endsWith(":loaded")) {
    return "fetch-resolved";
  }
  if (intent.startsWith("fetch:") && intent.endsWith(":stale")) {
    return "fetch-stale";
  }
  if (intent.startsWith("fetch:") && intent.endsWith(":error")) {
    return "fetch-rejected";
  }
  if (intent.startsWith("invalidate:")) {
    return "invalidated";
  }
  if (intent.startsWith("fail:")) {
    return "failed";
  }
  return "dep-changed";
}
function whyNotUpdated(prev, next) {
  if (Object.is(prev, next)) {
    return "object-is-deduped";
  }
  if (statesAreStructurallyEqual(prev, next)) {
    return "no-dep-overlap";
  }
  return null;
}
function statesAreStructurallyEqual(a, b) {
  if (a.state !== b.state) return false;
  switch (a.state) {
    case "idle":
      return true;
    case "loading":
      return a.origin === b.origin && Object.is(a.promise, b.promise);
    case "loaded":
    case "stale":
      return Object.is(a.value, b.value) && a.origin === b.origin && a.loadedAt === b.loadedAt;
    case "errored":
      return Object.is(a.error, b.error) && a.origin === b.origin && a.erroredAt === b.erroredAt;
  }
}

// src/index.ts
var VERSION = "0.0.0";
export {
  ForbiddenConflictTransitionError,
  ForbiddenResourceTransitionError,
  RESOURCE_UPDATE_REASONS,
  VERSION,
  createConflictRegistry,
  resource,
  singleConflictWhen,
  whyNotUpdated,
  whyUpdated
};
