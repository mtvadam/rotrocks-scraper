// Shared helper for classifying a BrainrotMutationValue into a display state.
// Consumed by both server (to enrich API responses) and client (to render badges).
// No DB or Next.js imports — pure logic so it can live in either runtime.

export const STALE_THRESHOLD_DAYS = 7

export const VOLATILE_THRESHOLDS: Record<string, number> = {
  OG: 0.30,
  Secret: 0.20,
  // Everything else falls through to the default.
}
export const DEFAULT_VOLATILE_THRESHOLD = 0.20

export function volatileThresholdFor(rarity: string | null | undefined): number {
  if (!rarity) return DEFAULT_VOLATILE_THRESHOLD
  return VOLATILE_THRESHOLDS[rarity] ?? DEFAULT_VOLATILE_THRESHOLD
}

export type ValueState = 'fresh' | 'stale' | 'volatile'

export interface ValueStateInput {
  robuxValue: number
  previousValue?: number | null
  volatile?: boolean | null
  updatedAt: Date | string
}

export interface ValueStateResult {
  state: ValueState
  ageInDays: number
  previousValue: number | null
  changePct: number | null // signed — negative means decline
  anchorDate: string       // ISO date of the last update
}

/**
 * Classify a stored mutation value into fresh / stale / volatile.
 *
 * - `volatile` takes precedence over `stale` — a jump matters more than age.
 * - `stale` kicks in once the value hasn't been updated for STALE_THRESHOLD_DAYS.
 * - `fresh` is the default.
 *
 * No drift projection. A stale value is the last-known real value, just flagged.
 */
export function computeValueState(input: ValueStateInput): ValueStateResult {
  const updated = typeof input.updatedAt === 'string' ? new Date(input.updatedAt) : input.updatedAt
  const ageMs = Date.now() - updated.getTime()
  const ageInDays = ageMs / (1000 * 60 * 60 * 24)

  const previousValue = input.previousValue ?? null
  const changePct = previousValue !== null && previousValue > 0
    ? (input.robuxValue - previousValue) / previousValue
    : null

  let state: ValueState = 'fresh'
  if (input.volatile) state = 'volatile'
  else if (ageInDays >= STALE_THRESHOLD_DAYS) state = 'stale'

  return {
    state,
    ageInDays,
    previousValue,
    changePct,
    anchorDate: updated.toISOString(),
  }
}

/**
 * Compute whether a new scrape value should be flagged volatile, given the current
 * anchor (referenceValue) and rarity. Used by the apply flow.
 */
export function isVolatileJump(params: {
  newValue: number
  referenceValue: number | null | undefined
  rarity: string | null | undefined
}): boolean {
  if (!params.referenceValue || params.referenceValue <= 0) return false
  const delta = Math.abs(params.newValue - params.referenceValue) / params.referenceValue
  return delta > volatileThresholdFor(params.rarity)
}
