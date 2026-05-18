import { query, queryOne, execute } from '@/lib/db'
import { shouldScrapeBrainrot } from '@/lib/price-fetcher'

type DemandLevelDB = 'TERRIBLE' | 'LOW' | 'NORMAL' | 'HIGH' | 'AMAZING'
type TrendIndicatorDB = 'LOWERING' | 'STABLE' | 'RISING'

interface DemandResult {
  demand: DemandLevelDB
  trend: TrendIndicatorDB
  confidence: number
  dataPoints: number
  avgValue: number
  latestValue: number
}

const MIN_DAYS_FOR_DEMAND = 2

/**
 * Bulk calculate demand for all brainrots (base) AND brainrot+mutation combos.
 * Updates both Brainrot.demand/trend and BrainrotMutationValue.demand/trend.
 */
export async function calculateAllDemand(): Promise<{ updated: number; skipped: number }> {
  const [brainrots, mutationValues, allSnapshots, defaultMutation] = await Promise.all([
    query<{ id: string; name: string; rarity: string | null; demand: DemandLevelDB; trend: TrendIndicatorDB }>(
      `SELECT "id", "name", "rarity", "demand", "trend" FROM "Brainrot" WHERE "isActive" = true`
    ),
    query<{ brainrotId: string; mutationId: string; demand: DemandLevelDB; trend: TrendIndicatorDB }>(
      `SELECT "brainrotId", "mutationId", "demand", "trend" FROM "BrainrotMutationValue"`
    ),
    query<{ brainrotId: string; mutationId: string; robuxPrice: number | null; createdAt: Date }>(
      `SELECT "brainrotId", "mutationId", "robuxPrice", "createdAt"
       FROM "PriceSnapshot"
       WHERE "robuxPrice" IS NOT NULL AND "robuxPrice" > 0 AND "usedForDemand" = true
       ORDER BY "createdAt" ASC`
    ),
    queryOne<{ id: string }>(
      `SELECT "id" FROM "Mutation" WHERE "isActive" = true ORDER BY "multiplier" ASC LIMIT 1`
    ),
  ])

  // Group snapshots by brainrotId, then by mutationId
  const snapshotsByBrainrot = new Map<string, Map<string, { robuxPrice: number; createdAt: Date }[]>>()
  for (const s of allSnapshots) {
    if (s.robuxPrice === null) continue
    let byMutation = snapshotsByBrainrot.get(s.brainrotId)
    if (!byMutation) {
      byMutation = new Map()
      snapshotsByBrainrot.set(s.brainrotId, byMutation)
    }
    const mutKey = s.mutationId
    let list = byMutation.get(mutKey)
    if (!list) {
      list = []
      byMutation.set(mutKey, list)
    }
    list.push({ robuxPrice: s.robuxPrice, createdAt: s.createdAt })
  }

  const defaultMutationId = defaultMutation?.id
  let updated = 0
  let skipped = 0

  // Reset demand/trend for brainrots that aren't scrape-eligible. Without this,
  // stale values from old scrape rounds (e.g. Cocofanto before BG was filtered out)
  // keep showing forever because the snapshots feeding them still exist and have
  // usedForDemand=true.
  for (const brainrot of brainrots) {
    if (shouldScrapeBrainrot(brainrot.rarity, brainrot.name)) continue
    if (brainrot.demand === 'NORMAL' && brainrot.trend === 'STABLE') continue
    await execute(
      `UPDATE "Brainrot" SET "demand" = 'NORMAL', "trend" = 'STABLE', "updatedAt" = NOW() WHERE "id" = $1`,
      [brainrot.id]
    )
  }

  // 1. Update base brainrot demand/trend (using default mutation snapshots)
  for (const brainrot of brainrots) {
    if (!shouldScrapeBrainrot(brainrot.rarity, brainrot.name)) { skipped++; continue }
    const byMutation = snapshotsByBrainrot.get(brainrot.id)
    if (!byMutation) { skipped++; continue }

    let snapshots = defaultMutationId ? byMutation.get(defaultMutationId) : undefined
    if (!snapshots || snapshots.length < 2) {
      let bestKey: string | undefined
      let bestCount = 0
      for (const [key, list] of byMutation) {
        if (list.length > bestCount) { bestCount = list.length; bestKey = key }
      }
      if (bestKey) snapshots = byMutation.get(bestKey)
    }

    if (!snapshots || snapshots.length < 2) { skipped++; continue }

    const uniqueDays = new Set(snapshots.map(s => s.createdAt.toISOString().split('T')[0]))
    if (uniqueDays.size < MIN_DAYS_FOR_DEMAND) { skipped++; continue }

    const dailyValues = deduplicateByDay(snapshots.map(s => ({ value: s.robuxPrice, date: s.createdAt })))
    const result = computeDemandFromSnapshots(dailyValues)

    if (result && (result.demand !== brainrot.demand || result.trend !== brainrot.trend)) {
      await execute(
        `UPDATE "Brainrot" SET "demand" = $1, "trend" = $2, "updatedAt" = NOW() WHERE "id" = $3`,
        [result.demand, result.trend, brainrot.id]
      )
      updated++
    } else {
      skipped++
    }
  }

  // 2. Update per-mutation demand/trend for each BrainrotMutationValue
  const mvLookup = new Map<string, { demand: DemandLevelDB; trend: TrendIndicatorDB }>()
  for (const mv of mutationValues) {
    mvLookup.set(`${mv.brainrotId}:${mv.mutationId}`, { demand: mv.demand, trend: mv.trend })
  }

  for (const [brainrotId, byMutation] of snapshotsByBrainrot) {
    for (const [mutationId, snapshots] of byMutation) {
      if (snapshots.length < 2) continue

      const uniqueDays = new Set(snapshots.map(s => s.createdAt.toISOString().split('T')[0]))
      if (uniqueDays.size < MIN_DAYS_FOR_DEMAND) continue

      const key = `${brainrotId}:${mutationId}`
      const existing = mvLookup.get(key)
      if (!existing) continue // No BrainrotMutationValue row for this combo

      const dailyValues = deduplicateByDay(snapshots.map(s => ({ value: s.robuxPrice, date: s.createdAt })))
      const result = computeDemandFromSnapshots(dailyValues)

      if (result && (result.demand !== existing.demand || result.trend !== existing.trend)) {
        await execute(
          `UPDATE "BrainrotMutationValue"
           SET "demand" = $1, "trend" = $2, "updatedAt" = NOW()
           WHERE "brainrotId" = $3 AND "mutationId" = $4`,
          [result.demand, result.trend, brainrotId, mutationId]
        )
        updated++
      }
    }
  }

  return { updated, skipped }
}

/**
 * Deduplicate snapshots by day — keep the latest snapshot from each calendar day.
 */
function deduplicateByDay(data: { value: number; date: Date }[]): { value: number; date: Date }[] {
  const dayMap = new Map<string, { value: number; date: Date }>()

  for (const d of data) {
    const dayKey = d.date.toISOString().split('T')[0]
    const existing = dayMap.get(dayKey)
    if (!existing || d.date.getTime() > existing.date.getTime()) {
      dayMap.set(dayKey, { value: d.value, date: d.date })
    }
  }

  return Array.from(dayMap.values()).sort((a, b) => a.date.getTime() - b.date.getTime())
}

/**
 * Core algorithm: compute demand level and trend from daily price averages.
 */
function computeDemandFromSnapshots(
  data: { value: number; date: Date }[]
): DemandResult | null {
  if (data.length < 2) return null

  const values = data.map(d => d.value)
  const latestValue = values[values.length - 1]
  const avgValue = values.reduce((sum, v) => sum + v, 0) / values.length

  const recentCount = Math.min(3, Math.floor(values.length / 2))
  const recentValues = values.slice(-recentCount)
  const priorValues = values.slice(0, -recentCount)

  const recentAvg = recentValues.reduce((s, v) => s + v, 0) / recentValues.length
  const priorAvg = priorValues.length > 0
    ? priorValues.reduce((s, v) => s + v, 0) / priorValues.length
    : avgValue

  const changePercent = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0

  let trend: TrendIndicatorDB = 'STABLE'
  if (changePercent > 5) trend = 'RISING'
  else if (changePercent < -5) trend = 'LOWERING'

  const deviationFromAvg = avgValue > 0 ? ((latestValue - avgValue) / avgValue) * 100 : 0

  let demand: DemandLevelDB = 'NORMAL'

  if (deviationFromAvg > 15 && trend === 'RISING') {
    demand = 'AMAZING'
  } else if (deviationFromAvg > 8 || (deviationFromAvg > 0 && trend === 'RISING')) {
    demand = 'HIGH'
  } else if (deviationFromAvg < -15 && trend === 'LOWERING') {
    demand = 'TERRIBLE'
  } else if (deviationFromAvg < -8 || (deviationFromAvg < 0 && trend === 'LOWERING')) {
    demand = 'LOW'
  }

  const confidence = Math.min(1, data.length / 14)

  return { demand, trend, confidence, dataPoints: data.length, avgValue: Math.round(avgValue), latestValue }
}
