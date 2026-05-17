import { query, transaction } from '@/lib/db'

// Eldorado's listing floor. $0.50 USD = 50 robux (100 robux per USD). A mutation is
// "at floor" when its scraped/stored robuxValue equals this.
export const FLOOR_ROBUX_VALUE = 50

// Tiebreaker when two mutations share a multiplier (notably Rainbow and Divine both = 10).
// Index in this list is used as the secondary sort key. Case-insensitive.
const MUTATION_TIEBREAK_ORDER: Record<string, number> = {
  'default': 0, 'gold': 1, 'diamond': 2, 'bloodrot': 3, 'candy': 4,
  'lava': 5, 'galaxy': 6, 'yin yang': 7, 'radioactive': 8, 'cursed': 9,
  'rainbow': 10, 'divine': 11, 'cyber': 12,
}

export interface MutationValueEntry {
  mutationId: string
  mutationName: string
  multiplier: number
  robuxValue: number
}

/**
 * Floor-price interpolation.
 *
 * When 2+ mutations of a brainrot are stuck at Eldorado's floor ($0.50 USD = 50 robux),
 * the raw data can't tell them apart — each individually bottomed out. We distribute
 * them linearly across the mutation hierarchy so the highest-ranked floor mutation keeps
 * the floor value and lower-ranked ones fall proportionally.
 *
 * Algorithm:
 *   1. Collect entries where robuxValue === FLOOR_ROBUX_VALUE.
 *   2. Sort them by (multiplier ASC, tiebreak-order ASC). Rainbow ranks below Divine.
 *   3. For the k-th floor mutation out of N, assign round(k / N * FLOOR_ROBUX_VALUE).
 *   4. Non-floor entries are NOT touched.
 *
 * Example (Bison Giuppitere, 11 floor mutations):
 *   default → 5, gold → 9, diamond → 14, bloodrot → 18, candy → 23, lava → 27,
 *   galaxy → 32, yin yang → 36, rainbow → 41, divine → 45, cyber → 50.
 *   (Radioactive=700, Cursed=300 remain unchanged.)
 *
 * If fewer than 2 entries are at floor, the input is returned unchanged.
 */
export function interpolateFloorValues(entries: MutationValueEntry[]): MutationValueEntry[] {
  if (entries.length === 0) return entries

  const floorEntries = entries.filter(e => e.robuxValue === FLOOR_ROBUX_VALUE)
  if (floorEntries.length < 2) return entries

  const sortedFloor = [...floorEntries].sort((a, b) => {
    if (a.multiplier !== b.multiplier) return a.multiplier - b.multiplier
    const aRank = MUTATION_TIEBREAK_ORDER[a.mutationName.toLowerCase()] ?? 999
    const bRank = MUTATION_TIEBREAK_ORDER[b.mutationName.toLowerCase()] ?? 999
    return aRank - bRank
  })

  const N = sortedFloor.length
  const newValueById = new Map<string, number>()
  sortedFloor.forEach((e, idx) => {
    const k = idx + 1
    newValueById.set(e.mutationId, Math.round((k / N) * FLOOR_ROBUX_VALUE))
  })

  return entries.map(e => {
    const newVal = newValueById.get(e.mutationId)
    return newVal !== undefined ? { ...e, robuxValue: newVal } : e
  })
}

/**
 * Run floor-price interpolation on every brainrot that has stored mutation values.
 * Non-floor values are untouched; brainrots with <2 floor mutations are skipped.
 */
export async function interpolateAllBrainrotFloorValues(): Promise<{ updated: number; skipped: number }> {
  const mutations = await query<{ id: string; name: string; multiplier: number }>(
    `SELECT "id", "name", "multiplier" FROM "Mutation" WHERE "isActive" = true ORDER BY "multiplier" ASC`
  )

  const mutationMap = new Map(mutations.map(m => [m.id, m]))

  const allValues = await query<{ brainrotId: string; mutationId: string; robuxValue: number }>(
    `SELECT "brainrotId", "mutationId", "robuxValue" FROM "BrainrotMutationValue"`
  )

  const byBrainrot = new Map<string, { mutationId: string; robuxValue: number }[]>()
  for (const v of allValues) {
    let list = byBrainrot.get(v.brainrotId)
    if (!list) { list = []; byBrainrot.set(v.brainrotId, list) }
    list.push({ mutationId: v.mutationId, robuxValue: v.robuxValue })
  }

  let updated = 0
  let skipped = 0
  const updates: Array<{ brainrotId: string; mutationId: string; robuxValue: number }> = []

  for (const [brainrotId, values] of byBrainrot) {
    const entries: MutationValueEntry[] = values
      .map(v => {
        const mut = mutationMap.get(v.mutationId)
        if (!mut) return null
        return { mutationId: v.mutationId, mutationName: mut.name, multiplier: mut.multiplier, robuxValue: v.robuxValue }
      })
      .filter((e): e is MutationValueEntry => e !== null)

    if (entries.length < 2) { skipped++; continue }

    const interpolated = interpolateFloorValues(entries)

    let changed = false
    for (const interp of interpolated) {
      const original = entries.find(e => e.mutationId === interp.mutationId)
      if (original && original.robuxValue !== interp.robuxValue) {
        changed = true
        updates.push({ brainrotId, mutationId: interp.mutationId, robuxValue: interp.robuxValue })
      }
    }

    if (changed) updated++
    else skipped++
  }

  if (updates.length > 0) {
    const BATCH_SIZE = 500
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE)
      await transaction(async (client) => {
        for (const u of batch) {
          await client.query(
            `UPDATE "BrainrotMutationValue"
             SET "robuxValue" = $1, "updatedAt" = NOW()
             WHERE "brainrotId" = $2 AND "mutationId" = $3`,
            [u.robuxValue, u.brainrotId, u.mutationId]
          )
        }
      })
    }
  }

  return { updated, skipped }
}
