import { query, queryOne, execute } from '@/lib/db'
import { createId } from '@paralleldrive/cuid2'
import { interpolateFloorValues } from '@/lib/value-interpolation'
import { isVolatileJump } from '@/lib/value-state'
import { bulkInsert } from '@/lib/bulk-write'

// Projected-flag thresholds, measured against the anchor: the 30-day average
// of clean (non-projected) applied snapshots, computed fresh each run. An
// average can't ratchet along with bad data the way previousValue did, and it
// needs no stored state or manual upkeep — flagged applies are excluded, so a
// staircase of suspect values never drags the baseline down with it.
// Reason strings must keep the "N.Nx jump|drop from R$…" shape — that's what
// projectedMetaForPriceChart whitelists for the public chart.
const PROJECT_JUMP_RATIO = 1.5   // ≥1.5x above anchor → projected
const PROJECT_DROP_RATIO = 1 / 1.5 // ≤0.67x of anchor (33%+ drop) → projected
const ANCHOR_AVG_DAYS = 30
// Band used by the acceptance pass to judge whether recent applies sit at the
// new level (normal fluctuation range).
const ANCHOR_FOLLOW_HI = 1.25
const ANCHOR_FOLLOW_LO = 0.8
// Cheap items have coarse price ticks (R$25 → R$50 is one step = "2x"), so ratio
// thresholds alone drown the flag in noise. The anchor machinery only engages
// when the move is also at least this many robux; smaller moves always follow.
const PROJECT_MIN_DELTA_ROBUX = 1000
// ...unless the move is extreme: a cheap floor can never shift R$1,000, yet a
// 3x+ swing is projected pricing, not a coarse tick (observed: Los Cucarachas
// R$25 → R$95 wore no flag). Extreme ratios bypass the delta gate.
const PROJECT_EXTREME_RATIO = 3
// Acceptance: a flagged level stops being flagged once it has held for
// STABLE_ACCEPT_WINDOW recent applied snapshots with at most
// STABLE_ACCEPT_OUTLIERS wobbles outside the follow band — i.e. a genuine market
// repricing stops being "projected" after ~3 days at 4 scrapes/day, while a
// still-sliding staircase (values keep changing) never qualifies. Once applies
// stop being flagged they enter the 30-day average, which then converges on the
// new level on its own.
const STABLE_ACCEPT_WINDOW = 12
const STABLE_ACCEPT_OUTLIERS = 2
const STABLE_ACCEPT_LOOKBACK_DAYS = 14
// Mutations may trade slightly below their brainrot's Default (some markets
// genuinely price Gold under base), but never drastically below — the apply
// step clamps mutation values up to this fraction of Default.
const MUTATION_FLOOR_RATIO = 0.8

/**
 * Build a preview of how a batch of PriceSnapshot rows would translate into
 * updates to BrainrotMutationValue.
 *
 * When multiple snapshots exist for the same (brainrot, mutation), the
 * newest row by createdAt wins — never averaged.
 */
export async function buildPreview(snapshotIds: string[]) {
  // Fetch all active mutations
  const allMutations = await query<{ id: string; name: string; multiplier: number }>(
    `SELECT "id", "name", "multiplier" FROM "Mutation" WHERE "isActive" = true ORDER BY "multiplier" ASC`
  )

  // Fetch snapshots with brainrot and mutation info
  const placeholders = snapshotIds.map((_, i) => `$${i + 1}`).join(', ')
  const snapshots = await query<{
    id: string
    brainrotId: string
    mutationId: string
    usdPrice: number | null
    robuxPrice: number | null
    listingCount: number
    isOutlier: boolean
    usedForDemand: boolean
    appliedToValues: boolean
    source: string
    createdAt: Date
    brainrotBid: string
    brainrotName: string
    brainrotLocalImage: string | null
    mutationMid: string
    mutationName: string
    mutationMultiplier: number
  }>(
    `SELECT ps."id", ps."brainrotId", ps."mutationId", ps."usdPrice", ps."robuxPrice",
            ps."listingCount", ps."isOutlier", ps."usedForDemand", ps."appliedToValues",
            ps."source", ps."createdAt",
            b."id" AS "brainrotBid", b."name" AS "brainrotName", b."localImage" AS "brainrotLocalImage",
            m."id" AS "mutationMid", m."name" AS "mutationName", m."multiplier" AS "mutationMultiplier"
     FROM "PriceSnapshot" ps
     JOIN "Brainrot" b ON b."id" = ps."brainrotId"
     JOIN "Mutation" m ON m."id" = ps."mutationId"
     WHERE ps."id" IN (${placeholders})
       AND ps."robuxPrice" IS NOT NULL`,
    snapshotIds
  )

  // Get unique brainrot IDs from snapshots
  const brainrotIds = [...new Set(snapshots.map(s => s.brainrotId))]

  // Fetch current stored values for all these brainrots
  let currentValues: Array<{ brainrotId: string; mutationId: string; robuxValue: number }> = []
  if (brainrotIds.length > 0) {
    const bPlaceholders = brainrotIds.map((_, i) => `$${i + 1}`).join(', ')
    currentValues = await query(
      `SELECT "brainrotId", "mutationId", "robuxValue"
       FROM "BrainrotMutationValue"
       WHERE "brainrotId" IN (${bPlaceholders})`,
      brainrotIds
    )
  }

  // Anchor per pair: 30-day average of clean applied snapshots (flagged applies
  // excluded so bad data can't drag the baseline). Current batch isn't applied
  // yet, so it never pollutes its own anchor. Pairs with no clean history fall
  // back to the stored value below.
  let anchorRows: Array<{ brainrotId: string; mutationId: string; avgValue: number }> = []
  if (brainrotIds.length > 0) {
    const bPlaceholders = brainrotIds.map((_, i) => `$${i + 1}`).join(', ')
    anchorRows = await query(
      `SELECT "brainrotId", "mutationId", AVG("appliedRobuxValue")::float8 AS "avgValue"
       FROM "PriceSnapshot"
       WHERE "brainrotId" IN (${bPlaceholders})
         AND "appliedToValues" = true
         AND "isProjected" = false
         AND "appliedRobuxValue" IS NOT NULL
         AND "createdAt" >= NOW() - INTERVAL '${ANCHOR_AVG_DAYS} days'
       GROUP BY "brainrotId", "mutationId"`,
      brainrotIds
    )
  }

  const currentValueMap = new Map<string, number>()
  const anchorValueMap = new Map<string, number>()
  for (const a of anchorRows) {
    const avg = Math.round(a.avgValue)
    if (avg > 0) anchorValueMap.set(`${a.brainrotId}:${a.mutationId}`, avg)
  }
  for (const v of currentValues) {
    currentValueMap.set(`${v.brainrotId}:${v.mutationId}`, v.robuxValue)
    const key = `${v.brainrotId}:${v.mutationId}`
    if (!anchorValueMap.has(key) && v.robuxValue > 0) anchorValueMap.set(key, v.robuxValue)
  }

  // Group snapshots by brainrot
  const byBrainrot = new Map<string, typeof snapshots>()
  for (const s of snapshots) {
    let list = byBrainrot.get(s.brainrotId)
    if (!list) { list = []; byBrainrot.set(s.brainrotId, list) }
    list.push(s)
  }

  const brainrots = []

  for (const [brainrotId, brainrotSnapshots] of byBrainrot) {
    const first = brainrotSnapshots[0]

    // Latest snapshot wins per mutation (never averaged).
    const snapshotByMutation = new Map<string, {
      robuxPrice: number
      isOutlier: boolean
      listingCount: number
      createdAt: Date
    }>()
    for (const s of brainrotSnapshots) {
      if (s.robuxPrice === null) continue
      const ts = new Date(s.createdAt).getTime()
      const existing = snapshotByMutation.get(s.mutationId)
      if (!existing || ts > existing.createdAt.getTime()) {
        snapshotByMutation.set(s.mutationId, {
          robuxPrice: s.robuxPrice,
          isOutlier: s.isOutlier,
          listingCount: s.listingCount ?? 0,
          createdAt: s.createdAt,
        })
      }
    }

    // Build entries for floor interpolation. Include ALL mutations with snapshot data
    // so we can detect when 2+ are stuck at Eldorado's floor (50 robux). Non-floor values
    // are never modified by interpolation — this is the only place interpolation is used.
    const interpEntries: { mutationId: string; mutationName: string; multiplier: number; robuxValue: number }[] = []
    for (const [mutId, data] of snapshotByMutation) {
      if (data.robuxPrice > 0) {
        const mut = allMutations.find(m => m.id === mutId)
        if (mut) interpEntries.push({ mutationId: mutId, mutationName: mut.name, multiplier: mut.multiplier, robuxValue: data.robuxPrice })
      }
    }

    // Run floor-only interpolation
    console.log(`[buildPreview] ${first.brainrotName}: ${interpEntries.length} interp entries, values: [${interpEntries.map(e => e.robuxValue).join(', ')}]`)
    const interpolated = interpolateFloorValues(interpEntries)
    const interpMap = new Map(interpolated.map(v => [v.mutationId, v.robuxValue]))
    const changed = interpolated.filter((v) => v.robuxValue !== interpEntries.find(e => e.mutationId === v.mutationId)?.robuxValue)
    if (changed.length > 0) {
      console.log(`[buildPreview] ${first.brainrotName}: floor interpolation changed ${changed.length} values`)
    }

    // Build full mutation list
    const mutations = allMutations.map(mut => {
      const snapData = snapshotByMutation.get(mut.id)
      const currentStored = currentValueMap.get(`${brainrotId}:${mut.id}`) ?? null
      const rawValue = snapData ? snapData.robuxPrice : null
      const isOutlier = snapData ? snapData.isOutlier : false
      const hasNewData = rawValue !== null && rawValue > 0
      const interpolatedValue = interpMap.get(mut.id) ?? null
      const finalValue = interpolatedValue ?? rawValue ?? currentStored

      return {
        mutationId: mut.id,
        mutationName: mut.name,
        multiplier: mut.multiplier,
        currentValue: currentStored,
        rawValue,
        interpolatedValue,
        finalValue,
        changed: hasNewData && interpolatedValue !== null && rawValue !== interpolatedValue,
        isOutlier,
        hasNewData,
        noData: rawValue === null,
        suspicious: false as boolean,
        suspiciousReason: null as string | null,
        isProjected: false as boolean,
        projectedReason: null as string | null,
        // Anchor: 30-day clean-apply average (see buildPreview above). Computed
        // fresh each run — no stored state, nothing to ratchet, nothing manual.
        anchorValue: anchorValueMap.get(`${brainrotId}:${mut.id}`) ?? null,
        listingCount: snapData?.listingCount ?? 0,
      }
    })

    // Detect suspicious values: inversions, outlier jumps, and large changes vs stored
    const withData = mutations.filter(m => m.finalValue !== null && m.hasNewData)
    for (let i = 0; i < withData.length; i++) {
      const curr = withData[i]
      const prev = i > 0 ? withData[i - 1] : null
      const next = i < withData.length - 1 ? withData[i + 1] : null

      if (prev && curr.finalValue! < prev.finalValue! && curr.multiplier > prev.multiplier) {
        curr.suspicious = true
        curr.suspiciousReason = `Lower than ${prev.mutationName} (${prev.multiplier}x = R$${prev.finalValue!.toLocaleString()})`
      }

      if (next && curr.finalValue! > next.finalValue! && curr.multiplier < next.multiplier) {
        curr.suspicious = true
        curr.suspiciousReason = `Higher than ${next.mutationName} (${next.multiplier}x = R$${next.finalValue!.toLocaleString()})`
      }

      if (prev && next && prev.finalValue && next.finalValue && curr.finalValue) {
        const expected = prev.finalValue + (next.finalValue - prev.finalValue) *
          ((curr.multiplier - prev.multiplier) / (next.multiplier - prev.multiplier))
        if (expected > 0 && (curr.finalValue > expected * 2 || curr.finalValue < expected * 0.4)) {
          curr.suspicious = true
          curr.suspiciousReason = curr.suspiciousReason
            ? curr.suspiciousReason + '; '
            : ''
          curr.suspiciousReason += `Expected ~R$${Math.round(expected).toLocaleString()} based on neighbors`
        }
      }

      if (curr.currentValue && curr.finalValue && curr.currentValue > 0) {
        const ratio = curr.finalValue / curr.currentValue
        if (ratio > 3 || ratio < 0.33) {
          curr.suspicious = true
          curr.suspiciousReason = curr.suspiciousReason
            ? curr.suspiciousReason + '; '
            : ''
          curr.suspiciousReason += `R$${curr.finalValue.toLocaleString()} vs previous R$${curr.currentValue.toLocaleString()} (${ratio.toFixed(1)}x change)`
        } else if (ratio < 0.85) {
          curr.suspicious = true
          curr.suspiciousReason = curr.suspiciousReason
            ? curr.suspiciousReason + '; '
            : ''
          curr.suspiciousReason += `Declined ${Math.round((1 - ratio) * 100)}% from R$${curr.currentValue.toLocaleString()} -> R$${curr.finalValue.toLocaleString()}`
        }
      }
    }

    const hasSuspicious = mutations.some(v => v.suspicious)

    // isProjected is shown on the public price-history chart only for major moves.
    // Compared against the ANCHOR (30-day clean-apply average), not the previous
    // value — the previous value ratchets along with bad data, so a staircase
    // decline (e.g. 49.5k → 42.9k → 41.9k → 24.9k, each step under the old 50%
    // cutoff) was only ever flagged once. The average excludes flagged applies,
    // so suspect values can't drag it; genuine repricings un-flag via the
    // acceptance pass below and then converge the average on their own.
    for (const m of mutations) {
      if (!m.hasNewData || !m.finalValue) continue
      const anchor = m.anchorValue
      if (!anchor || anchor <= 0) continue
      const ratio = m.finalValue / anchor
      const extreme = ratio >= PROJECT_EXTREME_RATIO || ratio <= 1 / PROJECT_EXTREME_RATIO
      if (!extreme && Math.abs(m.finalValue - anchor) < PROJECT_MIN_DELTA_ROBUX) continue
      if (ratio >= PROJECT_JUMP_RATIO) {
        m.isProjected = true
        m.projectedReason = `${ratio.toFixed(1)}x jump from R$${anchor.toLocaleString()}`
      } else if (ratio <= PROJECT_DROP_RATIO) {
        m.isProjected = true
        m.projectedReason = `${(1 / ratio).toFixed(1)}x drop from R$${anchor.toLocaleString()}`
      }
    }

    brainrots.push({
      brainrotId,
      brainrotName: first.brainrotName,
      localImage: first.brainrotLocalImage,
      hasChanges: mutations.some(v => v.changed),
      hasSuspicious,
      mutations,
    })
  }

  // Acceptance pass: for every flagged pair, check whether the deviated level
  // has actually held across recent applied snapshots. If it has, treat it as a
  // genuine market move and clear the flag — the cleared applies then feed the
  // 30-day average, which converges on the new level. Batched into one query.
  const frozen: Array<{ brainrotId: string; mutation: (typeof brainrots)[number]['mutations'][number] }> = []
  for (const b of brainrots) {
    for (const m of b.mutations) {
      if (m.isProjected && m.finalValue) frozen.push({ brainrotId: b.brainrotId, mutation: m })
    }
  }
  if (frozen.length > 0) {
    const candidateBrainrotIds = [...new Set(frozen.map(f => f.brainrotId))]
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - STABLE_ACCEPT_LOOKBACK_DAYS)
    const recent = await query<{ brainrotId: string; mutationId: string; appliedRobuxValue: number }>(
      `SELECT "brainrotId", "mutationId", "appliedRobuxValue" FROM (
         SELECT "brainrotId", "mutationId", "appliedRobuxValue",
                ROW_NUMBER() OVER (PARTITION BY "brainrotId", "mutationId" ORDER BY "createdAt" DESC) AS rn
         FROM "PriceSnapshot"
         WHERE "brainrotId" = ANY($1::text[])
           AND "appliedToValues" = true
           AND "appliedRobuxValue" IS NOT NULL
           AND "createdAt" >= $2
           AND NOT ("id" = ANY($3::text[]))
       ) t WHERE rn <= ${STABLE_ACCEPT_WINDOW}`,
      [candidateBrainrotIds, cutoff, snapshotIds]
    )
    const historyByPair = new Map<string, number[]>()
    for (const r of recent) {
      const key = `${r.brainrotId}:${r.mutationId}`
      let list = historyByPair.get(key)
      if (!list) { list = []; historyByPair.set(key, list) }
      list.push(r.appliedRobuxValue)
    }
    for (const { brainrotId, mutation: m } of frozen) {
      const history = historyByPair.get(`${brainrotId}:${m.mutationId}`) ?? []
      if (history.length < STABLE_ACCEPT_WINDOW) continue
      const inBand = history.filter(v => {
        const r = v / m.finalValue!
        return r >= ANCHOR_FOLLOW_LO && r <= ANCHOR_FOLLOW_HI
      }).length
      if (inBand >= STABLE_ACCEPT_WINDOW - STABLE_ACCEPT_OUTLIERS) {
        m.isProjected = false
        m.projectedReason = null
      }
    }
  }

  brainrots.sort((a, b) => {
    if (a.hasSuspicious !== b.hasSuspicious) return a.hasSuspicious ? -1 : 1
    if (a.hasChanges !== b.hasChanges) return a.hasChanges ? -1 : 1
    return a.brainrotName.localeCompare(b.brainrotName)
  })

  return { brainrots, totalSnapshots: snapshots.length }
}

export interface ApplySnapshotsOptions {
  snapshotIds: string[]
  /** If undefined or empty, applies ALL brainrots in the snapshot batch. */
  verifiedBrainrotIds?: string[]
  /** brainrotId -> mutationId -> overridden robuxValue */
  overrides?: Record<string, Record<string, number>>
}

export interface ApplySnapshotsResult {
  brainrotsUpdated: number
  valuesUpdated: number
  fullyApplied: boolean
  totalSnapshots: number
  appliedSnapshotIds: number
  volatileCount: number
}

/**
 * Apply a batch of PriceSnapshot rows to BrainrotMutationValue.
 *
 * This is the core logic shared by:
 *   - app/api/admin/price-snapshots/apply/route.ts (admin clicks "Apply")
 *   - scripts/cron-snapshot.ts                    (EC2 cron auto-apply)
 *
 * Pure DB work — no HTTP, no auth. Caller is responsible for permissions.
 */
export async function applySnapshots(opts: ApplySnapshotsOptions): Promise<ApplySnapshotsResult> {
  const { snapshotIds, verifiedBrainrotIds, overrides } = opts

  if (!snapshotIds?.length) {
    return { brainrotsUpdated: 0, valuesUpdated: 0, fullyApplied: false, totalSnapshots: 0, appliedSnapshotIds: 0, volatileCount: 0 }
  }

  const preview = await buildPreview(snapshotIds)
  console.log('[apply] preview built:', preview.brainrots.length, 'brainrots,', preview.totalSnapshots, 'snapshots')

  // Filter to only verified brainrots if specified
  const brainrotsToApply = verifiedBrainrotIds && verifiedBrainrotIds.length > 0
    ? preview.brainrots.filter(b => verifiedBrainrotIds.includes(b.brainrotId))
    : preview.brainrots
  console.log('[apply] brainrotsToApply:', brainrotsToApply.length, 'verified:', verifiedBrainrotIds?.length ?? 'all')

  const finalValues = brainrotsToApply.map(b => {
    const brainrotOverrides = overrides?.[b.brainrotId]
    const values = b.mutations
      .filter(v => (v.hasNewData || brainrotOverrides?.[v.mutationId] !== undefined) && (brainrotOverrides?.[v.mutationId] ?? v.finalValue) !== null)
      .map(v => ({
        mutationId: v.mutationId,
        mutationName: v.mutationName,
        robuxValue: (brainrotOverrides?.[v.mutationId] ?? v.finalValue) as number,
        rawValue: v.rawValue,
        interpolatedValue: v.interpolatedValue,
        currentValue: v.currentValue,
        hasNewData: v.hasNewData,
        changed: v.changed,
        // Admin overrides clear the projected flag — manual values are trusted.
        isProjected: brainrotOverrides?.[v.mutationId] !== undefined ? false : v.isProjected,
        projectedReason: brainrotOverrides?.[v.mutationId] !== undefined ? null : v.projectedReason,
        anchorValue: v.anchorValue,
      }))

    const interpolated = values.filter(v => v.interpolatedValue !== null && v.interpolatedValue !== v.rawValue)
    if (interpolated.length > 0) {
      console.log(`[apply] ${b.brainrotName}: ${interpolated.length} interpolated mutations:`)
      for (const v of interpolated) {
        console.log(`  ${v.mutationName}: raw=${v.rawValue} -> interp=${v.interpolatedValue} -> saving=${v.robuxValue} (was ${v.currentValue})`)
      }
    }

    return {
      brainrotId: b.brainrotId,
      brainrotName: b.brainrotName,
      values: values.map(v => ({
        mutationId: v.mutationId,
        robuxValue: v.robuxValue,
        isProjected: v.isProjected,
        projectedReason: v.projectedReason,
        anchorValue: v.anchorValue,
      })),
    }
  }).filter(b => b.values.length > 0)

  console.log('[apply] finalValues:', finalValues.length, 'brainrots, total mutations:', finalValues.reduce((s, b) => s + b.values.length, 0))
  for (const b of finalValues.slice(0, 5)) {
    console.log(`[apply]   ${b.brainrotName}: ${b.values.length} mutations -> [${b.values.map(v => v.robuxValue).join(', ')}]`)
  }

  // Flatten all upserts
  const allUpserts: { brainrotId: string; mutationId: string; robuxValue: number; isProjected: boolean; projectedReason: string | null; anchorValue: number | null }[] = []
  for (const b of finalValues) {
    for (const v of b.values) {
      allUpserts.push({
        brainrotId: b.brainrotId,
        mutationId: v.mutationId,
        robuxValue: v.robuxValue,
        isProjected: v.isProjected,
        projectedReason: v.projectedReason,
        anchorValue: v.anchorValue,
      })
    }
  }

  // Pre-load rarity per brainrot + current robuxValue per (brainrot, mutation)
  // so the upsert can compute the volatile flag + populate previousValue.
  const brainrotIdsForApply = [...new Set(allUpserts.map(u => u.brainrotId))]
  const rarityByBrainrotId = new Map<string, string | null>()
  const currentValueByKey = new Map<string, { robuxValue: number }>()
  if (brainrotIdsForApply.length > 0) {
    const rarityPlaceholders = brainrotIdsForApply.map((_, i) => `$${i + 1}`).join(', ')
    const rarityRows = await query<{ id: string; rarity: string | null }>(
      `SELECT "id", "rarity" FROM "Brainrot" WHERE "id" IN (${rarityPlaceholders})`,
      brainrotIdsForApply
    )
    for (const r of rarityRows) rarityByBrainrotId.set(r.id, r.rarity)

    const currentRows = await query<{ brainrotId: string; mutationId: string; robuxValue: number }>(
      `SELECT "brainrotId", "mutationId", "robuxValue"
       FROM "BrainrotMutationValue"
       WHERE "brainrotId" IN (${rarityPlaceholders})`,
      brainrotIdsForApply
    )
    for (const c of currentRows) {
      currentValueByKey.set(`${c.brainrotId}:${c.mutationId}`, { robuxValue: c.robuxValue })
    }
  }

  let volatileCount = 0
  const nowIso = new Date()
  const rows = allUpserts.map(u => {
    const rarity = rarityByBrainrotId.get(u.brainrotId) ?? null
    const existing = currentValueByKey.get(`${u.brainrotId}:${u.mutationId}`)
    const anchor = u.anchorValue ?? existing?.robuxValue ?? null
    const volatile = isVolatileJump({ newValue: u.robuxValue, referenceValue: anchor, rarity })
    const previousValue = existing?.robuxValue ?? null
    if (volatile) volatileCount++
    return [
      createId(), u.brainrotId, u.mutationId, u.robuxValue,
      previousValue, volatile, nowIso, nowIso,
    ]
  })

  console.log(`[apply] bulk upserting ${rows.length} rows in 500-row chunks…`)
  const t0 = Date.now()
  if (rows.length > 0) {
    await bulkInsert({
      table: 'BrainrotMutationValue',
      columns: ['id', 'brainrotId', 'mutationId', 'robuxValue', 'previousValue', 'volatile', 'createdAt', 'updatedAt'],
      rows,
      chunk: 500,
      onConflict: `("brainrotId","mutationId") DO UPDATE SET
        "robuxValue"     = EXCLUDED."robuxValue",
        "previousValue"  = EXCLUDED."previousValue",
        "volatile"       = EXCLUDED."volatile",
        "updatedAt"      = EXCLUDED."updatedAt"`,
    })
  }
  console.log(`[apply] bulk upsert done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // Invariant: a mutation can trade a BIT below its brainrot's Default (some
  // markets genuinely price Gold under Default), but never drastically below —
  // that's always a fossil or bad data. Clamp every mutation row of the
  // touched brainrots up to MUTATION_FLOOR_RATIO x the (possibly just updated)
  // Default. This also heals stale fossil rows whose mutation market died
  // long ago (e.g. La Supreme Combinasion Yin Yang stuck at a $9.99 lone-
  // listing apply from May while Default sat at $41.99) whenever their
  // brainrot gets any update at all.
  if (brainrotIdsForApply.length > 0) {
    const clamped = await execute(
      `UPDATE "BrainrotMutationValue" bv
       SET "robuxValue" = ROUND(d."robuxValue" * ${MUTATION_FLOOR_RATIO}), "updatedAt" = NOW()
       FROM "BrainrotMutationValue" d, "Mutation" dm
       WHERE dm."id" = d."mutationId" AND dm."name" = 'Default'
         AND d."brainrotId" = bv."brainrotId"
         AND bv."mutationId" <> d."mutationId"
         AND bv."brainrotId" = ANY($1::text[])
         AND bv."robuxValue" < ROUND(d."robuxValue" * ${MUTATION_FLOOR_RATIO})`,
      [brainrotIdsForApply]
    )
    if (clamped > 0) console.log(`[apply] clamped ${clamped} mutation values up to ${MUTATION_FLOOR_RATIO}x their Default`)
  }
  if (volatileCount > 0) console.log(`[apply] flagged ${volatileCount} volatile value changes`)

  // Mark snapshots as applied AND record the interpolated value per (brainrot, mutation)
  // so the price-history chart can show what was actually saved (single source of truth).
  const appliedByKey = new Map<string, { value: number; isProjected: boolean; projectedReason: string | null }>()
  for (const u of allUpserts) {
    appliedByKey.set(`${u.brainrotId}:${u.mutationId}`, {
      value: u.robuxValue,
      isProjected: u.isProjected,
      projectedReason: u.projectedReason,
    })
  }

  const appliedBrainrotIds = new Set(brainrotsToApply.map(b => b.brainrotId))
  const snapsToMark = await query<{ id: string; brainrotId: string; mutationId: string }>(
    `SELECT "id", "brainrotId", "mutationId" FROM "PriceSnapshot" WHERE "id" = ANY($1::text[])`,
    [snapshotIds]
  )

  // Step 1: mark EVERY snapshot that belongs to a verified brainrot as applied.
  // A reviewed batch is reviewed regardless of which mutations had data.
  const allAppliedIds = snapsToMark.filter(s => appliedBrainrotIds.has(s.brainrotId)).map(s => s.id)
  if (allAppliedIds.length > 0) {
    await execute(
      `UPDATE "PriceSnapshot" SET "appliedToValues" = true WHERE "id" = ANY($1::text[])`,
      [allAppliedIds]
    )
  }

  // Step 2: record appliedRobuxValue + isProjected per snapshot in bulk (VALUES join).
  // The old per-variant loop issued one UPDATE per unique projectedReason string —
  // often 200+ round-trips that exhaust Supabase's 15-session pooler limit.
  const detailRows: Array<{ id: string; value: number; isProjected: boolean; projectedReason: string | null }> = []
  for (const s of snapsToMark) {
    if (!appliedBrainrotIds.has(s.brainrotId)) continue
    const entry = appliedByKey.get(`${s.brainrotId}:${s.mutationId}`)
    if (!entry) continue
    detailRows.push({
      id: s.id,
      value: entry.value,
      isProjected: entry.isProjected,
      projectedReason: entry.projectedReason,
    })
  }

  if (detailRows.length > 0) {
    console.log(`[apply] bulk marking ${detailRows.length} snapshots with appliedRobuxValue…`)
    const t1 = Date.now()
    await bulkMarkSnapshotAppliedValues(detailRows)
    console.log(`[apply] bulk mark done in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  }
  const totalUpdated = detailRows.length
  const projectedCount = detailRows.filter(r => r.isProjected).length
  console.log(`[apply] marked ${allAppliedIds.length} snapshots applied; ${totalUpdated} with appliedRobuxValue recorded (${projectedCount} flagged projected)`)

  // Same UTC day may have multiple imports (e.g. EC2 cron + manual). Only this batch
  // should feed demand — older same-day rows are deactivated so charts/demand use latest.
  const deactivated = await deactivateOlderSameDaySnapshots(snapshotIds)
  if (deactivated > 0) {
    console.log(`[apply] deactivated ${deactivated} older same-day snapshots from demand`)
  }

  const allApplied = !verifiedBrainrotIds || verifiedBrainrotIds.length === 0 || verifiedBrainrotIds.length >= preview.brainrots.length

  return {
    brainrotsUpdated: finalValues.length,
    valuesUpdated: allUpserts.length,
    fullyApplied: allApplied,
    totalSnapshots: preview.totalSnapshots,
    appliedSnapshotIds: allAppliedIds.length,
    volatileCount,
  }
}

/** Turn off usedForDemand on other imports from the same UTC day as this batch. */
async function deactivateOlderSameDaySnapshots(snapshotIds: string[]): Promise<number> {
  if (snapshotIds.length === 0) return 0

  const dayRow = await queryOne<{ day: string }>(
    `SELECT to_char(MAX("createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day
     FROM "PriceSnapshot" WHERE "id" = ANY($1::text[])`,
    [snapshotIds]
  )
  if (!dayRow?.day) return 0

  return execute(
    `UPDATE "PriceSnapshot"
     SET "usedForDemand" = false
     WHERE "usedForDemand" = true
       AND NOT ("id" = ANY($1::text[]))
       AND to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $2`,
    [snapshotIds, dayRow.day]
  )
}

/** Bulk-update appliedRobuxValue / isProjected / projectedReason in chunked VALUES joins. */
async function bulkMarkSnapshotAppliedValues(
  rows: Array<{ id: string; value: number; isProjected: boolean; projectedReason: string | null }>
) {
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const values: unknown[] = []
    const tuples: string[] = []
    for (let j = 0; j < slice.length; j++) {
      const r = slice[j]
      const b = j * 4 + 1
      tuples.push(`($${b}::text, $${b + 1}::int, $${b + 2}::boolean, $${b + 3}::text)`)
      values.push(r.id, r.value, r.isProjected, r.projectedReason)
    }
    await execute(
      `UPDATE "PriceSnapshot" AS ps
       SET "appliedRobuxValue" = v.robux,
           "isProjected" = v.proj,
           "projectedReason" = v.reason
       FROM (VALUES ${tuples.join(', ')}) AS v(id, robux, proj, reason)
       WHERE ps."id" = v.id`,
      values
    )
  }
}
