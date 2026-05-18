/**
 * @causl/devtools-bridge — Redux DevTools Extension protocol bridge.
 *
 * Each Causl Commit becomes a Redux action; reverse messages
 * (JUMP_TO_ACTION / JUMP_TO_STATE) replay against bounded retained
 * snapshots.
 */

export type {
  BridgeGraph,
  ConnectOptions,
  DevtoolsMessage,
  DispatchEvent,
  MonitorMessageKind,
} from './connect.js'
export { connectDevtools, isExtensionAvailable } from './connect.js'

/**
 * Package version identifier; rewritten by the release tooling at
 * publish time. The literal `'0.0.0'` in source means "not yet
 * stamped" — the published artefact carries the real semver.
 */
export const VERSION = '0.0.0'
