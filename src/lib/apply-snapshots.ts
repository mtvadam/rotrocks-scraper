import { query, execute } from '@/lib/db'
import { createId } from '@paralleldrive/cuid2'
import { interpolateFloorValues } from '@/lib/value-interpolation'
import { isVolatileJump } from '@/lib/value-state'
import { bulkInsert } from '@/lib/bulk-write'

/**
 * Build a preview of how a batch of PriceSnapshot rows would translate into
 * updates to BrainrotMutationValue.
 *
 * NOTE on averaging: when multiple snapshots exist for the same (brainrot,
 * mutation), this function averages them. The cron-snapshot runner intentionally
 * passes only the IDs from a single run, so the average reduces to "just this
 * run's value" — i.e. "latest snapshot wins" with no cross-run averaging.
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

  const currentValueMap = new Map<string, number>()
  for (const v of currentValues) {
    currentValueMap.set(`${v.brainrotId}:${v.mutationId}`, v.robuxValue)
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

    // Average multiple snapshots for same mutation. When the caller passes
    // only one run's IDs (the cron case) this collapses to a single value.
    const snapshotByMutation = new Map<string, { sum: number; count: number; outlierCount: number; listingCount: number }>()
    for (const s of brainrotSnapshots) {
      if (s.robuxPrice === null) continue
      const existing = snapshotByMutation.get(s.mutationId)
      if (existing) {
        existing.sum += s.robuxPrice
        existing.count++
        existing.listingCount += s.listingCount ?? 0
        if (s.isOutlier) existing.outlierCount++
      } else {
        snapshotByMutation.set(s.mutationId, {
          sum: s.robuxPrice,
          count: 1,
          outlierCount: s.isOutlier ? 1 : 0,
          listingCount: s.listingCount ?? 0,
        })
      }
    }

    // Build entries for floor interpolation. Include ALL mutations with snapshot data
    // so we can detect when 2+ are stuck at Eldorado's floor (50 robux). Non-floor values
    // are never modified by interpolation — this is the only place interpolation is used.
    const interpEntries: { mutationId: string; mutationName: string; multiplier: number; robuxValue: number }[] = []
    for (const [mutId, data] of snapshotByMutation) {
      const avg = Math.round(data.sum / data.count)
      if (avg > 0) {
        const mut = allMutations.find(m => m.id === mutId)
        if (mut) interpEntries.push({ mutationId: mutId, mutationName: mut.name, multiplier: mut.multiplier, robuxValue: avg })
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
      const rawValue = snapData ? Math.round(snapData.sum / snapData.count) : null
      const isOutlier = snapData ? snapData.outlierCount === snapData.count : false
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

    // Compute isProjected: low-confidence flag for the price chart UI.
    for (const m of mutations) {
      if (!m.hasNewData) continue
      const reasons: string[] = []
      if (m.listingCount > 0 && m.listingCount < 5) {
        reasons.push(`only ${m.listingCount} listing${m.listingCount === 1 ? '' : 's'}`)
      }
      if (m.currentValue && m.finalValue && m.currentValue > 0) {
        const ratio = m.finalValue / m.currentValue
        if (ratio >= 2) reasons.push(`${ratio.toFixed(1)}x jump from R$${m.currentValue.toLocaleString()}`)
        else if (ratio <= 0.5) reasons.push(`${(1 / ratio).toFixed(1)}x drop from R$${m.currentValue.toLocaleString()}`)
      }
      if (m.suspicious && m.suspiciousReason) reasons.push(m.suspiciousReason)
      if (m.interpolatedValue !== null && m.rawValue !== m.interpolatedValue) {
        reasons.push('floor-interpolated from neighbors')
      }
      if (reasons.length > 0) {
        m.isProjected = true
        m.projectedReason = reasons.join('; ')
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
      })),
    }
  }).filter(b => b.values.length > 0)

  console.log('[apply] finalValues:', finalValues.length, 'brainrots, total mutations:', finalValues.reduce((s, b) => s + b.values.length, 0))
  for (const b of finalValues.slice(0, 5)) {
    console.log(`[apply]   ${b.brainrotName}: ${b.values.length} mutations -> [${b.values.map(v => v.robuxValue).join(', ')}]`)
  }

  // Flatten all upserts
  const allUpserts: { brainrotId: string; mutationId: string; robuxValue: number; isProjected: boolean; projectedReason: string | null }[] = []
  for (const b of finalValues) {
    for (const v of b.values) {
      allUpserts.push({
        brainrotId: b.brainrotId,
        mutationId: v.mutationId,
        robuxValue: v.robuxValue,
        isProjected: v.isProjected,
        projectedReason: v.projectedReason,
      })
    }
  }

  // Pre-load rarity per brainrot + current referenceValue/robuxValue per (brainrot, mutation)
  // so the upsert can compute volatile flag + populate previousValue/referenceValue.
  const brainrotIdsForApply = [...new Set(allUpserts.map(u => u.brainrotId))]
  const rarityByBrainrotId = new Map<string, string | null>()
  const currentValueByKey = new Map<string, { robuxValue: number; referenceValue: number | null }>()
  if (brainrotIdsForApply.length > 0) {
    const rarityPlaceholders = brainrotIdsForApply.map((_, i) => `$${i + 1}`).join(', ')
    const rarityRows = await query<{ id: string; rarity: string | null }>(
      `SELECT "id", "rarity" FROM "Brainrot" WHERE "id" IN (${rarityPlaceholders})`,
      brainrotIdsForApply
    )
    for (const r of rarityRows) rarityByBrainrotId.set(r.id, r.rarity)

    const currentRows = await query<{ brainrotId: string; mutationId: string; robuxValue: number; referenceValue: number | null }>(
      `SELECT "brainrotId", "mutationId", "robuxValue", "referenceValue"
       FROM "BrainrotMutationValue"
       WHERE "brainrotId" IN (${rarityPlaceholders})`,
      brainrotIdsForApply
    )
    for (const c of currentRows) {
      currentValueByKey.set(`${c.brainrotId}:${c.mutationId}`, { robuxValue: c.robuxValue, referenceValue: c.referenceValue })
    }
  }

  let volatileCount = 0
  const nowIso = new Date()
  const rows = allUpserts.map(u => {
    const rarity = rarityByBrainrotId.get(u.brainrotId) ?? null
    const existing = currentValueByKey.get(`${u.brainrotId}:${u.mutationId}`)
    const anchor = existing?.referenceValue ?? existing?.robuxValue ?? null
    const volatile = isVolatileJump({ newValue: u.robuxValue, referenceValue: anchor, rarity })
    const previousValue = existing?.robuxValue ?? null
    if (volatile) volatileCount++
    return [
      createId(), u.brainrotId, u.mutationId, u.robuxValue,
      u.robuxValue, previousValue, volatile, nowIso, nowIso,
    ]
  })

  console.log(`[apply] bulk upserting ${rows.length} rows in 500-row chunks…`)
  const t0 = Date.now()
  if (rows.length > 0) {
    await bulkInsert({
      table: 'BrainrotMutationValue',
      columns: ['id', 'brainrotId', 'mutationId', 'robuxValue', 'referenceValue', 'previousValue', 'volatile', 'createdAt', 'updatedAt'],
      rows,
      chunk: 500,
      onConflict: `("brainrotId","mutationId") DO UPDATE SET
        "robuxValue"     = EXCLUDED."robuxValue",
        "referenceValue" = EXCLUDED."referenceValue",
        "previousValue"  = EXCLUDED."previousValue",
        "volatile"       = EXCLUDED."volatile",
        "updatedAt"      = EXCLUDED."updatedAt"`,
    })
  }
  console.log(`[apply] bulk upsert done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
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

  // Step 2: for snapshots that actually got a BMV write, record the applied
  // robux value (chart reads this back) and the isProjected flag.
  const updatesByVariant = new Map<string, { value: number; isProjected: boolean; projectedReason: string | null; ids: string[] }>()
  for (const s of snapsToMark) {
    if (!appliedBrainrotIds.has(s.brainrotId)) continue
    const entry = appliedByKey.get(`${s.brainrotId}:${s.mutationId}`)
    if (!entry) continue
    const key = `${entry.value}|${entry.isProjected ? 1 : 0}|${entry.projectedReason ?? ''}`
    const slot = updatesByVariant.get(key) || { value: entry.value, isProjected: entry.isProjected, projectedReason: entry.projectedReason, ids: [] }
    slot.ids.push(s.id)
    updatesByVariant.set(key, slot)
  }

  for (const slot of updatesByVariant.values()) {
    if (slot.ids.length === 0) continue
    await execute(
      `UPDATE "PriceSnapshot"
       SET "appliedRobuxValue" = $1, "isProjected" = $2, "projectedReason" = $3
       WHERE "id" = ANY($4::text[])`,
      [slot.value, slot.isProjected, slot.projectedReason, slot.ids]
    )
  }
  const totalUpdated = [...updatesByVariant.values()].reduce((s, x) => s + x.ids.length, 0)
  const projectedCount = [...updatesByVariant.values()].filter(x => x.isProjected).reduce((s, x) => s + x.ids.length, 0)
  console.log(`[apply] marked ${allAppliedIds.length} snapshots applied; ${totalUpdated} with appliedRobuxValue recorded (${projectedCount} flagged projected)`)

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
