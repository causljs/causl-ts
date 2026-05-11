/**
 * @packageDocumentation
 *
 * Typed `Msg` discriminated-union helper for the §8 MVU surface
 * (closes #369). Application developers don't think "I will mutate
 * `cell:wb1:Sheet1:A1`," they think "the user clicked Save." The
 * `Msg` union is the application-facing front door, and §9's "make
 * impossible states impossible" applies *here* — at the dispatch
 * boundary — not in 57 internal enum tags.
 *
 * Before this module the engine contributed only the `Msg extends
 * { kind: string }` constraint inside `createUpdate`'s generics: a
 * name (`kind`), nothing else. Users hand-rolled the discriminated
 * union, hand-rolled the variant constructors, and reached for
 * `assertNever` themselves. Adding a tag without a handler caught
 * the dispatch site, but adding a tag without updating the union
 * silently drifted.
 *
 * The helper exposed here closes that surface:
 *
 *   - {@link Msg} — generic variant template; `Msg<'inc'>` produces
 *     `{ kind: 'inc' }` with no payload, `Msg<'set', { value: number }>`
 *     produces `{ kind: 'set'; value: number }`.
 *   - {@link defineMsgs} — record-of-payloads builder that returns a
 *     typed factory plus a phantom `_union` field carrying the closed
 *     `Msg` union. Pair the record-of-payloads with `createUpdate`'s
 *     record-of-handlers and the same shape declares both sides.
 *   - {@link MsgOf} — extractor pulling the closed union back out of
 *     a builder so consumers can name the parameter type explicitly.
 *   - {@link assertNever} — exhaustiveness probe; the canonical
 *     `default` arm in a `switch (msg.kind)`.
 *
 * Pairing with `createUpdate` (the MVU runner factory):
 *
 * ```ts
 * const msg = defineMsgs({
 *   inc: null,
 *   dec: null,
 *   set: payload<{ value: number }>(),
 * })
 * type CounterMsg = MsgOf<typeof msg>
 *
 * const update = createUpdate<CounterMsg>({
 *   inc: (_m, g) => { g.commit('inc', tx => ...) },
 *   dec: (_m, g) => { g.commit('dec', tx => ...) },
 *   set: (m, g) => { g.commit('set', tx => tx.set(n, m.value)) },
 * })
 *
 * dispatch(msg.inc())            // { kind: 'inc' }
 * dispatch(msg.set({ value: 3 })) // { kind: 'set'; value: 3 }
 * ```
 *
 * Adding a fourth tag to the `defineMsgs` record without adding a
 * matching handler is a compile error at the `createUpdate` call
 * site (same exhaustiveness gate as before). Adding a fourth tag
 * without naming it in a `switch (msg.kind)` is a compile error at
 * the `assertNever(msg)` default arm. Both gates fail closed.
 */

/**
 * Variant template for a discriminated `Msg` union. `Msg<TKind>`
 * produces a payload-less `{ kind: TKind }`; `Msg<TKind, TPayload>`
 * intersects an additional payload object.
 *
 * @typeParam TKind - The literal tag string identifying this variant.
 * @typeParam TPayload - Additional payload object merged into the
 * variant. Defaults to `void` for the no-payload case.
 *
 * @example
 * ```ts
 * type CounterMsg =
 *   | Msg<'inc'>
 *   | Msg<'dec'>
 *   | Msg<'set', { value: number }>
 * ```
 */
export type Msg<TKind extends string, TPayload = void> = [TPayload] extends [void]
  ? { readonly kind: TKind }
  : { readonly kind: TKind } & TPayload

/**
 * Phantom marker brand carrying the payload type at the type level.
 * Not constructed by user code; produced exclusively by {@link payload}.
 */
export interface PayloadMarker<P extends object> {
  readonly __payload: P
}

/**
 * Internal sentinel referenced by every {@link payload} call. A
 * frozen empty object suffices: the marker is structural at the type
 * level (the `__payload` brand) and identity-only at runtime.
 */
const PAYLOAD_MARKER = Object.freeze({}) as PayloadMarker<object>

/**
 * Phantom payload marker used to declare the payload type for a
 * named variant inside {@link defineMsgs}. Returns a no-op token
 * the builder uses to type-thread its variant constructors. The
 * payload object itself is never instantiated at runtime — the
 * helper only forwards the `kind` plus the user-supplied payload.
 *
 * @typeParam P - The payload object type for the variant.
 *
 * @example
 * ```ts
 * const msg = defineMsgs({
 *   set: payload<{ value: number }>(),
 *   reset: null,
 * })
 * ```
 */
export function payload<P extends object>(): PayloadMarker<P> {
  // Brand a frozen empty object so the marker is referentially
  // distinguishable from `null` (the no-payload sentinel) at runtime
  // without leaking a constructor or any user-visible state.
  return PAYLOAD_MARKER as PayloadMarker<P>
}

/**
 * Spec object accepted by {@link defineMsgs}. Each key is a variant
 * tag; each value is either `null` (no payload) or a {@link payload}
 * marker carrying the payload type.
 */
export type MsgSpec = {
  readonly [K in string]: null | PayloadMarker<object>
}

/**
 * Variant constructor record returned by {@link defineMsgs}. For
 * each tag the spec defined as `null`, the entry is a zero-arg
 * function returning `{ kind }`. For each tag with a payload marker,
 * the entry takes the payload object and returns `{ kind, ...payload }`.
 *
 * @typeParam Spec - The spec object passed to {@link defineMsgs}.
 *
 * @remarks
 * The record also carries a phantom `_union` field whose type is the
 * closed `Msg` union for the spec. {@link MsgOf} reads that field; it
 * exists only at the type level and is `undefined` at runtime.
 */
export type MsgBuilder<Spec extends MsgSpec> = {
  readonly [K in keyof Spec & string]: Spec[K] extends PayloadMarker<infer P>
    ? (payload: P) => Msg<K, P>
    : () => Msg<K>
} & {
  /**
   * Phantom field carrying the closed `Msg` union for the spec.
   * Read with {@link MsgOf}. Always `undefined` at runtime.
   */
  readonly _union: {
    [K in keyof Spec & string]: Spec[K] extends PayloadMarker<infer P>
      ? Msg<K, P>
      : Msg<K>
  }[keyof Spec & string]
}

/**
 * Extract the closed `Msg` union from a builder produced by
 * {@link defineMsgs}.
 *
 * @typeParam B - A builder returned by {@link defineMsgs}.
 *
 * @example
 * ```ts
 * const msg = defineMsgs({ inc: null, set: payload<{ value: number }>() })
 * type CounterMsg = MsgOf<typeof msg>
 * //   ^? { kind: 'inc' } | { kind: 'set'; value: number }
 * ```
 */
export type MsgOf<B extends { readonly _union: unknown }> = B['_union']

/**
 * Build a typed variant-constructor record plus closed `Msg` union
 * from a record of `tag → payload?` declarations. The same record
 * shape pairs cleanly with `createUpdate`'s record-of-handlers, so
 * tags are declared once.
 *
 * @typeParam Spec - The spec record; keys are tags, values are `null`
 * (no payload) or {@link payload} markers.
 *
 * @param spec - The variant spec.
 * @returns A {@link MsgBuilder} whose entries are variant constructors.
 *
 * @remarks
 * Adding a tag to `spec` widens `MsgOf<typeof builder>`. Passing that
 * widened union to `createUpdate<MsgOf<...>>` makes the missing
 * handler a compile error at the call site, and a missing arm in a
 * `switch (msg.kind)` is a compile error at {@link assertNever}.
 *
 * @example
 * ```ts
 * const msg = defineMsgs({
 *   inc: null,
 *   dec: null,
 *   set: payload<{ value: number }>(),
 * })
 * type CounterMsg = MsgOf<typeof msg>
 *
 * msg.inc()             // { kind: 'inc' }
 * msg.set({ value: 3 }) // { kind: 'set'; value: 3 }
 * ```
 */
export function defineMsgs<Spec extends MsgSpec>(spec: Spec): MsgBuilder<Spec> {
  // Build one closure per tag. Each closure tags the user-supplied
  // payload (if any) with the variant's `kind`. The marker itself is
  // a phantom — it carries no runtime payload — so the constructor
  // only forwards what the caller passes in.
  const builder = {} as Record<string, unknown>
  for (const key of Object.keys(spec)) {
    const marker = spec[key as keyof Spec]
    if (marker === null) {
      // No-payload variant: zero-arg constructor returning `{ kind }`.
      builder[key] = () => ({ kind: key })
    } else {
      // Payload variant: spread the user's payload object first so
      // the variant's `kind` is authoritative and cannot be
      // overridden by a stray `kind` field on the payload object.
      builder[key] = (p: object) => ({ ...p, kind: key })
    }
  }
  // The phantom `_union` field is type-only; setting it to `undefined`
  // keeps the runtime shape minimal while the compile-time projection
  // still sees the closed union via the `MsgBuilder` type.
  builder._union = undefined as unknown
  return builder as MsgBuilder<Spec>
}

/**
 * Exhaustiveness probe for a `switch (msg.kind)`. Place at the
 * `default` arm; the parameter type `never` is satisfied only when
 * every variant has a matching `case`. Adding a tag to the union
 * without a `case` arm is a compile error at this call site.
 *
 * The runtime throw is belt-and-suspenders only — it cannot be
 * reached when the type-check passes.
 *
 * @param value - The post-narrowed message that should be `never`.
 * @throws Error citing the unmatched message variant.
 *
 * @example
 * ```ts
 * function update(msg: CounterMsg, g: Graph): void {
 *   switch (msg.kind) {
 *     case 'inc': return g.commit('inc', tx => ...)
 *     case 'dec': return g.commit('dec', tx => ...)
 *     case 'set': return g.commit('set', tx => tx.set(n, msg.value))
 *     default:    return assertNever(msg)
 *   }
 * }
 * ```
 */
export function assertNever(value: never): never {
  // Stringify defensively — a value that reaches here at runtime is
  // either a typing escape hatch or a non-TS caller, and either way
  // a readable diagnostic helps more than a `[object Object]`.
  throw new Error(`assertNever: unexpected Msg variant ${JSON.stringify(value)}`)
}
