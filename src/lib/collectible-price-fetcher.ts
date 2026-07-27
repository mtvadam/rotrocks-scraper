import { query, execute } from '@/lib/db'
import {
  titleMatchesBrainrot,
  isFraudTitle,
  pickFloorPrice,
  FETCH_HEADERS,
  type PriceWithSeller,
} from '@/lib/price-fetcher'

// Eldorado price scraper for the tradeable collectible catalogs (Gear + BaseSkin).
//
// Unlike brainrots, Eldorado has no per-item trade environment for these — the
// categories are flat: base skins live under te_v0="Base Skins" and gears under
// te_v0="Other" (a grab-bag that also holds tips/private-server junk). Items are
// identified purely by listing title, so each catalog item is fetched via
// searchQuery within its category and matched by name words.
//
// Values are written straight onto Gear.robuxValue / BaseSkin.robuxValue (no
// snapshot/review pipeline) — these are cheap commodity items with deep, liquid
// markets, and the same trust + floor-picking rules as brainrots apply.

const TE_V0_BY_TABLE = { Gear: 'Other', BaseSkin: 'Base Skins' } as const
type CollectibleTable = keyof typeof TE_V0_BY_TABLE

const SEARCH_PAGES = 2
const MIN_TRUSTED_LISTINGS = 3
const USD_TO_ROBUX = 100

export interface CollectiblePriceResult {
  table: CollectibleTable
  id: string
  name: string
  usdPrice: number | null
  robuxPrice: number | null
  listingCount: number
  error?: string
}

interface RawOffer {
  offer: {
    id: string
    userId: string
    offerTitle: string
    pricePerUnitInUSD: { amount: number }
  }
  userOrderInfo: { feedbackScore: number; ratingCount: number } | null
}

async function fetchCategoryOffers(
  teV0: string,
  searchQuery: string,
  signal?: AbortSignal
): Promise<RawOffer[]> {
  const all: RawOffer[] = []
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    const params = new URLSearchParams({
      gameId: '259',
      category: 'CustomItem',
      tradeEnvironmentValue0: teV0,
      searchQuery,
      pageIndex: String(page),
      pageSize: '24',
      offerSortingCriterion: 'Price',
      isAscending: 'true',
      useMinPurchasePrice: 'false',
      // Without this the API omits userOrderInfo entirely (null for every
      // seller), which silently zeroes the trust filter.
      includeDeliveryMedians: 'true',
    })
    let response = await fetch(
      `https://www.eldorado.gg/api/v1/item-management/offers?${params.toString()}`,
      { headers: FETCH_HEADERS, signal }
    )
    let retries = 0
    while (response.status === 429 && retries < 3) {
      const retryAfter = parseInt(response.headers.get('retry-after') || String(3 * Math.pow(2, retries)), 10)
      await new Promise(r => setTimeout(r, retryAfter * 1000))
      response = await fetch(
        `https://www.eldorado.gg/api/v1/item-management/offers?${params.toString()}`,
        { headers: FETCH_HEADERS, signal }
      )
      retries++
    }
    if (!response.ok) break
    const data = await response.json() as { results?: RawOffer[]; totalPages?: number }
    if (!data.results?.length) break
    all.push(...data.results)
    if (page >= (data.totalPages ?? 1)) break
  }
  return all
}

// A listing "belongs" to the catalog item whose full name appears in the title
// with the MOST words. Search for "Easter" also surfaces "Bunny Basket 🧺 |
// Easter Collector Skin" — that listing is a Bunny Basket, and pricing it as
// Easter would drag the Easter floor to Bunny Basket levels. If any other
// catalog name with more words fully matches the title, reject.
function claimedByOtherCatalogItem(title: string, itemName: string, catalogNames: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '')
  const titleWords = new Set(norm(title).split(/\s+/).filter(Boolean))
  const wordsOf = (name: string) => norm(name).split(/\s+/).filter(w => w.length >= 2)
  const itemWordCount = wordsOf(itemName).length
  for (const other of catalogNames) {
    if (other === itemName) continue
    const otherWords = wordsOf(other)
    if (otherWords.length <= itemWordCount) continue
    if (otherWords.every(w => titleWords.has(w))) return true
  }
  return false
}

export async function fetchAllCollectiblePrices(opts?: {
  fetchTimeout?: number
  itemDelay?: number
}): Promise<CollectiblePriceResult[]> {
  const { fetchTimeout = 30000, itemDelay = 500 } = opts ?? {}
  const results: CollectiblePriceResult[] = []

  for (const table of Object.keys(TE_V0_BY_TABLE) as CollectibleTable[]) {
    const items = await query<{ id: string; name: string }>(
      `SELECT "id", "name" FROM "${table}" WHERE "isActive" = true AND "tradable" = true ORDER BY "name"`
    )
    const catalogNames = items.map(i => i.name)
    const teV0 = TE_V0_BY_TABLE[table]

    for (const item of items) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), fetchTimeout)
        let offers: RawOffer[]
        try {
          offers = await fetchCategoryOffers(teV0, item.name, controller.signal)
        } finally {
          clearTimeout(timer)
        }

        const trusted = offers.filter(o =>
          o.userOrderInfo != null &&
          o.userOrderInfo.feedbackScore >= 85 &&
          o.userOrderInfo.ratingCount >= 10 &&
          titleMatchesBrainrot(o.offer.offerTitle, item.name) &&
          !isFraudTitle(o.offer.offerTitle) &&
          !claimedByOtherCatalogItem(o.offer.offerTitle, item.name, catalogNames)
        )

        const sellers: PriceWithSeller[] = trusted.map(o => ({
          price: o.offer.pricePerUnitInUSD.amount,
          rc: o.userOrderInfo!.ratingCount,
          fb: o.userOrderInfo!.feedbackScore,
          sellerId: o.offer.userId,
        }))
        const { price, count } = pickFloorPrice(sellers)

        if (price !== null && count >= MIN_TRUSTED_LISTINGS) {
          results.push({
            table, id: item.id, name: item.name,
            usdPrice: price,
            robuxPrice: Math.round(price * USD_TO_ROBUX),
            listingCount: count,
          })
        } else {
          results.push({
            table, id: item.id, name: item.name,
            usdPrice: null, robuxPrice: null, listingCount: count,
            error: `only ${count} trusted listings (need ${MIN_TRUSTED_LISTINGS})`,
          })
        }
      } catch (err) {
        results.push({
          table, id: item.id, name: item.name,
          usdPrice: null, robuxPrice: null, listingCount: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      await new Promise(r => setTimeout(r, itemDelay))
    }
  }

  return results
}

/** Write priced results onto Gear/BaseSkin.robuxValue. Unpriced items are left untouched. */
export async function applyCollectiblePrices(
  results: CollectiblePriceResult[]
): Promise<{ updated: number; skipped: number }> {
  let updated = 0
  let skipped = 0
  for (const r of results) {
    if (r.robuxPrice === null) { skipped++; continue }
    await execute(
      `UPDATE "${r.table}" SET "robuxValue" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
      [r.robuxPrice, r.id]
    )
    updated++
  }
  return { updated, skipped }
}
