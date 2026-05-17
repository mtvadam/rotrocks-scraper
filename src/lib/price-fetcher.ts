import { query } from '@/lib/db'

// Eldorado library API – returns all brainrots listed on their marketplace
interface EldoradoTradeEnv {
  id: string
  name: string
  value: string
  childTradeEnvironments: EldoradoTradeEnv[]
}

interface EldoradoLibrary {
  tradeEnvironments: EldoradoTradeEnv[]
}

interface EldoradoBrainrot {
  name: string
  rarity: string
}

async function fetchEldoradoBrainrotList(): Promise<EldoradoBrainrot[]> {
  const res = await fetch('https://www.eldorado.gg/api/library/259/CustomItem', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Eldorado library API: HTTP ${res.status}`)
  const data: EldoradoLibrary = await res.json()

  const brainrots: EldoradoBrainrot[] = []
  const brainrotType = data.tradeEnvironments?.find(te => te.value === 'Brainrot')
  if (!brainrotType) return brainrots

  for (const rarity of brainrotType.childTradeEnvironments) {
    for (const brainrot of rarity.childTradeEnvironments) {
      if (brainrot.value && brainrot.value !== 'Other') {
        brainrots.push({ name: brainrot.value, rarity: rarity.value })
      }
    }
  }
  return brainrots
}

interface EldoradoAttr {
  value: string
  name: string
  id: string
}

interface EldoradoOffer {
  offer: {
    id: string
    // Seller's user UUID. Same seller can post multiple listings — we dedupe
    // by this in pickFloorPrice to prevent one account from filling the
    // lowest N slots and defeating rule E's lone-undercutter detection.
    userId: string
    offerTitle: string
    pricePerUnitInUSD: { amount: number; currency: string }
    quantity: number
    offerAttributeIdValues: EldoradoAttr[]
  }
  userOrderInfo: {
    feedbackScore: number
    ratingCount: number
  }
}

interface EldoradoResponse {
  pageIndex: number
  totalPages: number
  recordCount: number
  pageSize: number
  results: EldoradoOffer[]
}

export interface PriceResult {
  brainrotId: string
  brainrotName: string
  mutation: string
  mutationId: string
  usdPrice: number | null
  robuxPrice: number | null
  listingCount: number
  isOutlier: boolean
  error?: string
}

function getMinListings(rarity: string, mutationName: string): number {
  const isRareMutation = !['Default', 'Gold'].includes(mutationName)
  const r = rarity.toLowerCase()
  if (r === 'og') return isRareMutation ? 1 : 3
  if (r === 'secret') return isRareMutation ? 3 : 10
  if (r === 'brainrot god' || r === 'god') return isRareMutation ? 3 : 8
  if (r === 'legendary') return isRareMutation ? 5 : 10
  if (r === 'mythic') return isRareMutation ? 3 : 8
  if (r === 'epic') return isRareMutation ? 5 : 10
  return isRareMutation ? 2 : 5
}

const STOP_WORDS = new Set(['and', 'the', 'of', 'a', 'an', 'in', 'on', 'my', 'no'])

function titleMatchesBrainrot(title: string, brainrotName: string): boolean {
  const titleLower = title.toLowerCase()
  const titleWords = titleLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean)
  // Dedupe name words so "Love Love Bear" requires both "love" and "bear" (not "love" twice).
  // Without dedupe, "Love Love Love Sahur" matches "Love Love Bear" via two "love" hits.
  const nameWords = Array.from(new Set(
    brainrotName.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
  ))

  if (nameWords.length === 0) return false

  let matchCount = 0
  for (const word of nameWords) {
    const found = titleWords.some(tw =>
      tw === word || (tw.length >= 3 && tw.startsWith(word)) || (tw.length >= 3 && word.startsWith(tw))
    )
    if (found) matchCount++
  }

  const threshold = nameWords.length <= 2 ? nameWords.length : Math.ceil(nameWords.length * 0.6)
  return matchCount >= threshold
}

// Rarity-based minimum USD price to filter out fraud/bait listings.
// Eldorado's API supports lowestPrice server-side which saves bandwidth.
const RARITY_MIN_USD: Record<string, number> = {
  'OG': 50,            // OG brainrots are never legitimately < $50
  'Brainrot God': 1,   // Gods are never < $1
  'God': 1,
  'Secret': 0.5,       // Secrets at $0.50 are suspicious but possible
}

// Only Secret and OG brainrots are scraped by default — Eldorado market liquidity for
// lower rarities is typically too thin to be useful. Add specific names to the allowlist
// below to opt them in anyway.
export const SCRAPE_RARITIES = new Set(['Secret', 'OG'])
export const MANUAL_SCRAPE_ALLOWLIST = new Set<string>([
  'Raccooni Jandelini',
  'Centrucci Nuclucci',
  'Rhino Helicopterino',
  'Pineaplino',
  'Cola Cat',
  'Lazy Ducky'
])
export function shouldScrapeBrainrot(rarity: string | null | undefined, name: string): boolean {
  if (rarity && SCRAPE_RARITIES.has(rarity)) return true
  if (MANUAL_SCRAPE_ALLOWLIST.has(name)) return true
  return false
}

// Title patterns that indicate the listing is NOT a real sale (roulettes, indexes, etc.)
// `\bfor\b` catches the "selling X FOR Y" / "FOR Z" trade-bait pattern that
// matches the searchQuery scrape on the wrong brainrot — e.g. a Gold Gold Gold
// listing titled "...DIVINER FOR DUGGY BROS..." was being attributed to Duggy.
//
// craft/recipe/material/ingredient/bundle/set drop listings tied to crafted
// brainrots (Los Hackers, Tictac Sahur, etc.). Their searchQuery results get
// poisoned by ingredient listings — e.g. "1x1x1x1 | NEW LOS HACKERS CRAFT" is
// a 1x1x1x1 listing whose seller advertises Los Hackers as the craft target.
// Any of these words means the listing is an ingredient or recipe-bundle, not
// the actual finished brainrot.
const FRAUD_TITLE_PATTERNS = [
  /roulette/i,
  /\brandom\b/i,
  /\bgamble\b/i,
  /\blottery\b/i,
  /\bindex/i,
  /\bspin\b/i,
  /\bmystery\b.*\bbox\b/i,
  /\bfor\b/i,
  /\bcraft(s|ing|ed|er)?\b/i,
  /\brecipe\b/i,
  /\bmaterial(s)?\b/i,
  /\bingredient(s)?\b/i,
  /\bbundle\b/i,
  /\bfull\s*set\b/i,
]

function isFraudTitle(title: string): boolean {
  return FRAUD_TITLE_PATTERNS.some(p => p.test(title))
}

// Mutation slug map for Eldorado's steal-a-brainrot-mutations filter
function mutationToSlug(name: string): string {
  if (name.toLowerCase() === 'default') return 'none'
  return name.toLowerCase().replace(/\s+/g, '-')
}

// Rule E — reject a lone lowest price if no other listing falls within 1.25× of it.
// Targets the "quick seller undercutting everyone" pattern: one cheap listing with a
// big gap up to the rest. Disabled for markets with <3 listings (too little signal).
// Repeats until the current lowest has a companion, which handles cascading outliers.
//
// Reputation override: skip the drop when the lowest-priced seller has decent
// established reputation (rc >= 50 + fb >= 99%). Rule E was designed to catch
// new-account undercutters; a 50+ rated seller at 99%+ is past that bar.
const RULE_E_COMPANION_RATIO = 1.25
const RULE_E_FP_EPSILON = 1.01
const RULE_E_MIN_PRICES = 3
const RULE_E_TRUST_OVERRIDE_RC = 50
const RULE_E_TRUST_OVERRIDE_FB = 99

interface PriceWithSeller { price: number; rc: number; fb: number; sellerId: string }

function dropUnsupportedLowestPrices(sortedAsc: PriceWithSeller[]): PriceWithSeller[] {
  if (sortedAsc.length < RULE_E_MIN_PRICES) return sortedAsc
  let arr = sortedAsc
  while (arr.length >= 2 && arr[1].price > arr[0].price * RULE_E_COMPANION_RATIO * RULE_E_FP_EPSILON) {
    // Trust override: don't drop the lowest if its seller has very high reputation.
    // Rule E exists to catch new-account undercutters; a 6754-rated 99.8% seller
    // pricing a vanilla listing below trait-bundle listings is a real market floor.
    if (arr[0].rc >= RULE_E_TRUST_OVERRIDE_RC && arr[0].fb >= RULE_E_TRUST_OVERRIDE_FB) break
    arr = arr.slice(1)
    if (arr.length < RULE_E_MIN_PRICES) break
  }
  return arr
}

// Collapse the trusted ladder to one entry per seller (their cheapest listing).
// Prevents a single account from filling the lowest N slots and defeating rule
// E's lone-undercutter detection — observed in the wild on Dragon Cannelloni
// Default where one seller posted two listings at $23 while the rest of the
// market sat at $33+. With per-seller dedup, rule E sees the true single-seller
// $23 vs the next seller's $33 ($33 > $23 × 1.2625) and drops it.
function dedupBySeller(trusted: PriceWithSeller[]): PriceWithSeller[] {
  const cheapestBySeller = new Map<string, PriceWithSeller>()
  for (const t of trusted) {
    const existing = cheapestBySeller.get(t.sellerId)
    if (!existing || t.price < existing.price) {
      cheapestBySeller.set(t.sellerId, t)
    }
  }
  return [...cheapestBySeller.values()]
}

// Picks the lowest trusted price after rejecting obvious outliers:
//   1. Dedupe by seller (keep each seller's cheapest listing).
//   2. Drop anything below median × 0.2 (kills extreme fraud listings).
//   3. Apply rule E — reject unsupported lowest price (with reputation override).
// `candidatesAsc` is the post-filter sorted price ladder, returned so the
// monotonic-constraint pass at the end of the run can walk past inversions
// (e.g. Diamond < Gold) without re-fetching from Eldorado.
function pickFloorPrice(trusted: PriceWithSeller[]): { price: number | null; count: number; candidatesAsc: number[] } {
  if (trusted.length === 0) return { price: null, count: 0, candidatesAsc: [] }
  const deduped = dedupBySeller(trusted)
  const sorted = [...deduped].sort((a, b) => a.price - b.price)
  const median = sorted[Math.floor(sorted.length / 2)].price
  const afterMedian = sorted.length >= 3 ? sorted.filter(s => s.price >= median * 0.2) : sorted
  const afterRuleE = dropUnsupportedLowestPrices(afterMedian)
  if (afterRuleE.length === 0) return { price: null, count: 0, candidatesAsc: [] }
  return { price: afterRuleE[0].price, count: afterRuleE.length, candidatesAsc: afterRuleE.map(s => s.price) }
}

// Mutations whose trusted-price ladders we keep around for the post-run
// monotonic-constraint sweep. We currently enforce only Gold < Diamond — Default
// is intentionally NOT constrained because some brainrots price Default above
// Gold on the market (e.g. La Easter Grande), and forcing Gold up swaps
// well-supported listings for noise. Gold needs to be captured as the
// predecessor reference for Diamond.
// To re-enable Default < Gold: add 'default' back to this Set AND uncomment the
// walkUp(gold, ...) block in the post-run sweep below.
const CONSTRAINT_MUTATIONS = new Set([/* 'default', */ 'gold', 'diamond'])

// Run a fetch once, and on failure wait 1.5s and retry a second time. Used by
// Phase 2 / Phase 3 loops so transient Eldorado hiccups don't become silent 'errors'.
async function onceAndRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[price-fetcher] retry ${label}: ${msg}`)
    await new Promise(r => setTimeout(r, 1500))
    return await fn()
  }
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.eldorado.gg/',
}

// Returns the mutation slug encoded in an offer's `Mutations` attribute, lowercased
// and hyphenated to match the same format `mutationToSlug` uses elsewhere. Missing /
// "None" → 'none' (Default). Used to verify each listing actually belongs to the
// mutation bucket we asked for — Eldorado returns ALL mutations when no
// `steal-a-brainrot-mutations` param is sent, so the Default fetch otherwise
// includes Gold/Diamond/Cursed listings and the title filter passes them through
// (e.g. "Diamond Strawberry Elephant" still contains "Strawberry Elephant" and
// would otherwise drag the Default floor down to a Diamond's price).
function getOfferMutationSlug(offer: EldoradoOffer): string {
  const attr = offer.offer.offerAttributeIdValues.find(a => a.name === 'Mutations')
  const value = attr?.value
  if (!value || value === 'None') return 'none'
  return value.toLowerCase().replace(/\s+/g, '-')
}

// Re-used by both te_v2 (Mode A) and searchQuery (Mode B) paths. Centralised here so
// fraud + title + seller + mutation rules are applied identically regardless of
// fetch mode.
function filterTrustedOffers(offers: EldoradoOffer[], brainrotName: string, mutationSlug: string): EldoradoOffer[] {
  return offers.filter(o =>
    o.userOrderInfo &&
    o.userOrderInfo.feedbackScore >= 85 &&
    o.userOrderInfo.ratingCount >= 10 &&
    titleMatchesBrainrot(o.offer.offerTitle, brainrotName) &&
    !isFraudTitle(o.offer.offerTitle) &&
    getOfferMutationSlug(o) === mutationSlug
  )
}

// Paginated searchQuery fetch for brainrots NOT in Eldorado's categorised library.
// Eldorado's search is fuzzier (matches description text too), so the first page is often
// dominated by unrelated cheap listings. We page through everything until totalPages is
// reached or MAX_PAGES hits — downstream title-filter rejects the noise.
// 3 pages × 24 listings = 72 per mutation. Real listings for uncategorised
// brainrots that are in Eldorado's inventory show up well within this; going deeper
// just burns requests chasing noise.
const SEARCH_MAX_PAGES = 3
async function fetchOffersViaSearchAllPages(
  brainrotName: string,
  mutationSlug: string,
  rarity: string,
  signal?: AbortSignal
): Promise<EldoradoOffer[]> {
  const all: EldoradoOffer[] = []
  for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      gameId: '259',
      category: 'CustomItem',
      searchQuery: brainrotName,
      pageIndex: String(page),
      pageSize: '24',
      offerSortingCriterion: 'Price',
      isAscending: 'true',
      useMinPurchasePrice: 'false',
      'numericAttributeFilters[0].attributeId': 'steal-a-brainrot-ms-numeric',
      includeDeliveryMedians: 'true',
    })

    // Only include mutation filter if not "none" (default)
    if (mutationSlug !== 'none') {
      params.set('steal-a-brainrot-mutations', mutationSlug)
    }

    const minPrice = RARITY_MIN_USD[rarity]
    if (minPrice) params.set('lowestPrice', String(minPrice))

    let response = await fetch(
      `https://www.eldorado.gg/api/v1/item-management/offers?${params.toString()}`,
      { headers: FETCH_HEADERS, signal }
    )
    let retries = 0
    while (response.status === 429 && retries < 3) {
      // Exponential backoff: 3s, 6s, 12s. Honour server's retry-after header if present.
      const retryAfter = parseInt(response.headers.get('retry-after') || String(3 * Math.pow(2, retries)), 10)
      await new Promise(r => setTimeout(r, retryAfter * 1000))
      response = await fetch(
        `https://www.eldorado.gg/api/v1/item-management/offers?${params.toString()}`,
        { headers: FETCH_HEADERS, signal }
      )
      retries++
    }
    if (!response.ok) break
    const data: EldoradoResponse = await response.json()
    if (!data.results?.length) break
    all.push(...data.results)
    if (page >= (data.totalPages ?? 1)) break
  }
  return all
}

// How many pages of te_v2 listings to fetch per mutation. For non-default
// mutations the server-side `steal-a-brainrot-mutations` filter keeps page 1
// almost entirely on-target, so 1 page (24 listings) is plenty. For Default
// the API has no "no mutation" filter and returns ALL mutations sorted by
// price — for popular brainrots the cheapest 24 are dominated by mutated
// listings, low-rep sellers and fraud titles, and the trusted Default
// listings don't surface until page 2-4. Paginate until we have enough
// trusted matches (or hit the page cap).
const DEFAULT_MAX_PAGES = 6
const MUTATION_MAX_PAGES = 1

// Fetch offers for a specific brainrot + mutation combo (Mode A — te_v2).
// For Default, paginates up to DEFAULT_MAX_PAGES and short-circuits as soon
// as we've collected enough trusted matching offers to satisfy the
// per-rarity minListings threshold. For non-default mutations, fetches a
// single page since the server-side filter is reliable.
async function fetchOffersForMutation(
  brainrotName: string,
  mutationSlug: string,
  rarity: string,
  signal?: AbortSignal,
  minTrusted?: number
): Promise<EldoradoOffer[]> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.eldorado.gg/',
  }

  const maxPages = mutationSlug === 'none' ? DEFAULT_MAX_PAGES : MUTATION_MAX_PAGES
  const all: EldoradoOffer[] = []

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      gameId: '259',
      category: 'CustomItem',
      tradeEnvironmentValue2: brainrotName,
      pageIndex: String(page),
      pageSize: '24',
      offerSortingCriterion: 'Price',
      isAscending: 'true',
      useMinPurchasePrice: 'false',
      'numericAttributeFilters[0].attributeId': 'steal-a-brainrot-ms-numeric',
      includeDeliveryMedians: 'true',
    })

    // Only include mutation filter if not "none" (default)
    if (mutationSlug !== 'none') {
      params.set('steal-a-brainrot-mutations', mutationSlug)
    }

    const minPrice = RARITY_MIN_USD[rarity]
    if (minPrice) params.set('lowestPrice', String(minPrice))

    let response = await fetch(
      `https://www.eldorado.gg/api/v1/item-management/offers?${params.toString()}`,
      { headers, signal }
    )

    // Retry 429
    let retries = 0
    while (response.status === 429 && retries < 3) {
      const retryAfter = parseInt(response.headers.get('retry-after') || String(30 + retries * 30), 10)
      console.log(`[price-fetcher] 429 for ${brainrotName}/${mutationSlug} p${page}, waiting ${retryAfter}s`)
      await new Promise(r => setTimeout(r, retryAfter * 1000))
      response = await fetch(
        `https://www.eldorado.gg/api/v1/item-management/offers?${params.toString()}`,
        { headers, signal }
      )
      retries++
    }

    if (!response.ok) break
    const data: EldoradoResponse = await response.json()
    if (!data.results?.length) break
    all.push(...data.results)
    if (page >= (data.totalPages ?? 1)) break

    // Short-circuit: stop paginating once we have enough trusted matches.
    if (minTrusted != null) {
      const trustedCount = filterTrustedOffers(all, brainrotName, mutationSlug).length
      if (trustedCount >= minTrusted) break
    }
  }
  return all
}

export interface FetchOptions {
  onProgress?: (fetched: number, total: number) => void | Promise<void>
  batchSize?: number
  batchDelay?: number
  fetchTimeout?: number
  // Optional external buffer that the fetcher pushes each completed batch into
  // BEFORE awaiting the next round-trip. Lets the caller bulk-insert whatever
  // accumulated even if the run is cancelled mid-Phase 3 (most common with
  // long 429 backoffs). When provided, this is the same array as the returned
  // results — the caller has live access to it.
  accumulator?: PriceResult[]
}

export async function fetchAllBrainrotPrices(
  onProgressOrOpts?: ((fetched: number, total: number) => void | Promise<void>) | FetchOptions
): Promise<PriceResult[]> {
  const opts: FetchOptions = typeof onProgressOrOpts === 'function'
    ? { onProgress: onProgressOrOpts }
    : onProgressOrOpts ?? {}

  const { onProgress, batchSize = 3, batchDelay = 1000, fetchTimeout = 15000, accumulator } = opts

  // 1. Fetch brainrot list dynamically from Eldorado
  let eldoradoList: EldoradoBrainrot[] = []
  try {
    eldoradoList = await fetchEldoradoBrainrotList()
    console.log(`[price-fetcher] Fetched ${eldoradoList.length} brainrots from Eldorado`)
  } catch (err) {
    console.error('[price-fetcher] Failed to fetch Eldorado brainrot list:', err)
  }

  // 2. Get DB brainrots and mutations
  const dbBrainrots = await query<{ id: string; name: string; rarity: string | null }>(
    `SELECT "id", "name", "rarity" FROM "Brainrot" WHERE "isActive" = true`
  )

  const mutations = await query<{ id: string; name: string }>(
    `SELECT "id", "name" FROM "Mutation" ORDER BY "multiplier" ASC`
  )

  const mutationByName = new Map<string, { id: string; name: string }>()
  for (const m of mutations) {
    mutationByName.set(m.name.toLowerCase(), m)
  }

  // 3. Match Eldorado names to DB records using fuzzy matching
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  const dbByExact = new Map(dbBrainrots.map(b => [b.name.toLowerCase(), b]))
  const dbByNormalized = new Map(dbBrainrots.map(b => [normalize(b.name), b]))

  function levenshtein(a: string, b: string): number {
    if (a.length === 0) return b.length
    if (b.length === 0) return a.length
    const matrix: number[][] = []
    for (let i = 0; i <= b.length; i++) matrix[i] = [i]
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = b[i - 1] === a[j - 1] ? 0 : 1
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
      }
    }
    return matrix[b.length][a.length]
  }

  function findBestMatch(eldName: string) {
    const exact = dbByExact.get(eldName.toLowerCase())
    if (exact) return exact
    const norm = normalize(eldName)
    const normalized = dbByNormalized.get(norm)
    if (normalized) return normalized
    const maxDist = norm.length >= 6 ? 2 : 1
    let bestDb = null
    let bestDist = Infinity
    for (const db of dbBrainrots) {
      const dist = levenshtein(norm, normalize(db.name))
      if (dist < bestDist && dist <= maxDist) {
        bestDist = dist
        bestDb = db
      }
    }
    return bestDb
  }

  type MatchedBrainrot = { id: string; name: string; rarity: string; eldoradoName: string }
  // Categorised: found in Eldorado's library → use te_v2 strict filter (Phase 1 + Phase 2).
  // Uncategorised: passes rarity/allowlist but missing from Eldorado's library (e.g.
  //   Love Love Bear) → use paginated searchQuery (Phase 3).
  const matched: MatchedBrainrot[] = []
  const uncategorized: MatchedBrainrot[] = []
  const usedIds = new Set<string>()

  // Only scrape Secret + OG + manual allowlist.
  const scrapable = dbBrainrots.filter(b => shouldScrapeBrainrot(b.rarity, b.name))

  if (eldoradoList.length > 0) {
    // Reverse match: which Eldorado entries point at which scrapable DB rows
    const dbById = new Map(scrapable.map(b => [b.id, b]))
    for (const eld of eldoradoList) {
      const db = findBestMatch(eld.name)
      if (db && dbById.has(db.id) && !usedIds.has(db.id)) {
        matched.push({ id: db.id, name: db.name, rarity: eld.rarity, eldoradoName: eld.name })
        usedIds.add(db.id)
      }
    }
    // Anything scrapable that we couldn't tie to Eldorado → uncategorised path
    for (const b of scrapable) {
      if (!usedIds.has(b.id)) {
        uncategorized.push({ id: b.id, name: b.name, rarity: b.rarity ?? '', eldoradoName: b.name })
      }
    }
    console.log(`[price-fetcher] Scrapable: ${scrapable.length} (${matched.length} categorised, ${uncategorized.length} uncategorised)`)
    if (uncategorized.length > 0 && uncategorized.length <= 20) {
      console.log(`[price-fetcher] Uncategorised: ${uncategorized.map(u => u.name).join(', ')}`)
    }
  } else {
    // Eldorado library fetch failed — fall back to paginated searchQuery for everything.
    for (const b of scrapable) {
      uncategorized.push({ id: b.id, name: b.name, rarity: b.rarity ?? '', eldoradoName: b.name })
    }
    console.warn(`[price-fetcher] Eldorado library unavailable — treating all ${scrapable.length} scrapable brainrots as uncategorised`)
  }

  // Phase 1: quick unfiltered fetch per brainrot (page 1 only) to grab common mutations.
  // Phase 2: per-mutation queries ONLY for mutations not seen in phase 1.
  // This cuts API calls significantly for brainrots with few total listings.

  console.log(`[price-fetcher] Phase 1: quick scan of ${matched.length} brainrots...`)
  const phase1Results = new Map<string, Map<string, { offers: EldoradoOffer[] }>>() // brainrotId → mutName → offers

  for (let i = 0; i < matched.length; i += batchSize) {
    const batch = matched.slice(i, i + batchSize)
    await Promise.all(batch.map(async (brainrot) => {
      try {
        // Match phase 2's params exactly. useMinPurchasePrice=false +
        // numericAttributeFilters + includeDeliveryMedians are what cause
        // Eldorado to populate userOrderInfo on each result; without them
        // every offer comes back with null seller info and the downstream
        // filterTrustedOffers throws every offer away, wasting the phase 1
        // shortcut entirely.
        const params = new URLSearchParams({
          gameId: '259',
          category: 'CustomItem',
          tradeEnvironmentValue2: brainrot.eldoradoName,
          pageIndex: '1',
          pageSize: '24',
          offerSortingCriterion: 'Price',
          isAscending: 'true',
          useMinPurchasePrice: 'false',
          'numericAttributeFilters[0].attributeId': 'steal-a-brainrot-ms-numeric',
          includeDeliveryMedians: 'true',
        })
        const minPrice = RARITY_MIN_USD[brainrot.rarity]
        if (minPrice) params.set('lowestPrice', String(minPrice))

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), fetchTimeout)
        const response = await fetch(
          `https://www.eldorado.gg/api/v1/item-management/offers?${params}`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json', 'Referer': 'https://www.eldorado.gg/' }, signal: controller.signal }
        )
        clearTimeout(timer)
        if (!response.ok) return
        const data: EldoradoResponse = await response.json()
        if (!data.results?.length) return

        const byMut = new Map<string, { offers: EldoradoOffer[] }>()
        for (const offer of data.results) {
          const mutAttr = offer.offer.offerAttributeIdValues.find(a => a.name === 'Mutations')
          const mutName = (mutAttr?.value === 'None' ? 'Default' : mutAttr?.value) || 'Default'
          const key = mutName.toLowerCase()
          if (!byMut.has(key)) byMut.set(key, { offers: [] })
          byMut.get(key)!.offers.push(offer)
        }
        phase1Results.set(brainrot.id, byMut)
      } catch { /* timeout or network error — will be retried in phase 2 */ }
    }))
    if (i + batchSize < matched.length) await new Promise(r => setTimeout(r, batchDelay))
  }

  // Determine which (brainrot, mutation) combos still need individual queries.
  // Phase 1's tradeEnvironmentValue2 fetch returns the 24 cheapest mixed-mutation
  // listings — for popular brainrots those are dominated by mutations, low-rep
  // sellers and fraud titles, so a Phase 1 bucket can have 1-2 offers that all
  // fail the trust filter. We only skip Phase 2 when the bucket has enough
  // TRUSTED matching offers to satisfy the per-rarity minListings threshold;
  // otherwise the picked floor would be undersampled (e.g. a single $250
  // listing standing in for the real Default market floor of $674+).
  const phase1Skip = new Set<string>() // `${brainrotId}:${mutKey}`
  let skippedFromPhase1 = 0
  const combinations: { brainrot: MatchedBrainrot; mutation: typeof mutations[0] }[] = []
  for (const brainrot of matched) {
    const p1 = phase1Results.get(brainrot.id)
    for (const mutation of mutations) {
      const mutKey = mutation.name.toLowerCase()
      const minListings = getMinListings(brainrot.rarity, mutation.name)
      const bucket = p1?.get(mutKey)
      const trustedCount = bucket
        ? filterTrustedOffers(bucket.offers, brainrot.eldoradoName, mutationToSlug(mutation.name)).length
        : 0
      if (trustedCount >= minListings) {
        skippedFromPhase1++
        phase1Skip.add(`${brainrot.id}:${mutKey}`)
      } else {
        combinations.push({ brainrot, mutation })
      }
    }
  }

  console.log(`[price-fetcher] Phase 1 covered ${skippedFromPhase1} combos. Phase 2: ${combinations.length} remaining.`)

  // If the caller passed an accumulator, share that array as `results`. That way
  // partial Phase 1/2/3 progress is visible to the caller even if the run is
  // cancelled later — the bulk-insert step in the trigger can save whatever
  // got pushed before the throw.
  const results: PriceResult[] = accumulator ?? []
  // Trusted-price ladder per (brainrotId, mutKey) for Default/Gold/Diamond. Used by
  // the post-run monotonic-constraint sweep to walk Gold/Diamond up past their
  // predecessor's floor instead of re-fetching.
  const candidatesByCombo = new Map<string, number[]>()
  // Brainrot rarity lookup so the constraint sweep can recompute isOutlier correctly.
  const rarityById = new Map(dbBrainrots.map(b => [b.id, b.rarity ?? '']))
  const BATCH_SIZE = batchSize
  const BATCH_DELAY = batchDelay

  const totalCombos = matched.length * mutations.length
  console.log(`[price-fetcher] Phase 2: fetching ${combinations.length}/${totalCombos} combos`)

  if (onProgress) {
    await onProgress(0, totalCombos)
  }

  let totalWithPrices = 0
  let totalNullPrices = 0
  let totalErrors = 0

  // Process Phase 1 results into PriceResults — but only for combos we
  // committed to skipping (i.e. had >= minListings trusted matches). Any
  // under-sampled combo is being re-fetched in Phase 2 below; pushing here
  // would double-count it.
  for (const brainrot of matched) {
    const p1 = phase1Results.get(brainrot.id)
    if (!p1) continue
    for (const mutation of mutations) {
      const mutKey = mutation.name.toLowerCase()
      if (!phase1Skip.has(`${brainrot.id}:${mutKey}`)) continue
      const p1Data = p1.get(mutKey)
      if (!p1Data) continue

      const trusted = filterTrustedOffers(p1Data.offers, brainrot.eldoradoName, mutationToSlug(mutation.name))
      const { price, count, candidatesAsc } = pickFloorPrice(trusted.map(o => ({ price: o.offer.pricePerUnitInUSD.amount, rc: o.userOrderInfo.ratingCount, fb: o.userOrderInfo.feedbackScore, sellerId: o.offer.userId })))

      const minListings = getMinListings(brainrot.rarity, mutation.name)
      if (price !== null) totalWithPrices++; else totalNullPrices++

      if (CONSTRAINT_MUTATIONS.has(mutKey)) {
        candidatesByCombo.set(`${brainrot.id}:${mutKey}`, candidatesAsc)
      }

      results.push({
        brainrotId: brainrot.id, brainrotName: brainrot.name,
        mutation: mutation.name, mutationId: mutation.id,
        usdPrice: price, robuxPrice: price !== null ? Math.round(price * 100) : null,
        listingCount: count, isOutlier: count < minListings,
      })
    }
  }

  // (No per-phase saves — the trigger does one bulk INSERT at the end.)

  for (let i = 0; i < combinations.length; i += BATCH_SIZE) {
    const batch = combinations.slice(i, i + BATCH_SIZE)

    // Fetch each (brainrot, mutation) combo in parallel (with one retry on failure)
    const batchResults = await Promise.all(
      batch.map(async ({ brainrot, mutation }): Promise<PriceResult> => {
        const label = `${brainrot.name}/${mutation.name}`
        const slug = mutationToSlug(mutation.name)
        try {
          return await onceAndRetry(async () => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), fetchTimeout)
            try {
              const minListings = getMinListings(brainrot.rarity, mutation.name)
              const offers = await fetchOffersForMutation(brainrot.eldoradoName, slug, brainrot.rarity, controller.signal, minListings)
              const trusted = filterTrustedOffers(offers, brainrot.eldoradoName, slug)
              const { price, count, candidatesAsc } = pickFloorPrice(trusted.map(o => ({ price: o.offer.pricePerUnitInUSD.amount, rc: o.userOrderInfo.ratingCount, fb: o.userOrderInfo.feedbackScore, sellerId: o.offer.userId })))
              const mutKeyLower = mutation.name.toLowerCase()
              if (CONSTRAINT_MUTATIONS.has(mutKeyLower)) {
                candidatesByCombo.set(`${brainrot.id}:${mutKeyLower}`, candidatesAsc)
              }
              return {
                brainrotId: brainrot.id,
                brainrotName: brainrot.name,
                mutation: mutation.name,
                mutationId: mutation.id,
                usdPrice: price,
                robuxPrice: price !== null ? Math.round(price * 100) : null,
                listingCount: count,
                isOutlier: count < minListings,
              }
            } finally {
              clearTimeout(timer)
            }
          }, label)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[price-fetcher] FAIL (phase 2) ${label}: ${msg}`)
          return {
            brainrotId: brainrot.id,
            brainrotName: brainrot.name,
            mutation: mutation.name,
            mutationId: mutation.id,
            usdPrice: null,
            robuxPrice: null,
            listingCount: 0,
            isOutlier: true,
            error: msg,
          }
        }
      })
    )

    for (const r of batchResults) {
      if (r.robuxPrice !== null) totalWithPrices++
      else totalNullPrices++
      if (r.error) totalErrors++
    }

    // Log first batch
    if (i === 0) {
      const pricedSample = batchResults.filter(r => r.robuxPrice !== null)
      console.log(`[price-fetcher] First batch: ${pricedSample.length}/${batchResults.length} priced`)
      for (const r of pricedSample.slice(0, 3)) {
        console.log(`  ${r.brainrotName} ${r.mutation}: $${r.usdPrice} → R$${r.robuxPrice} (${r.listingCount} listings)`)
      }
    }

    results.push(...batchResults)

    if (onProgress) {
      await onProgress(Math.min(skippedFromPhase1 + i + BATCH_SIZE, totalCombos), totalCombos)
    }

    if (i > 0 && i % 100 === 0) {
      console.log(`[price-fetcher] Phase 2 progress: ${i}/${combinations.length}, ${totalWithPrices} priced, ${totalErrors} errors`)
    }

    if (i + BATCH_SIZE < combinations.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY))
    }
  }

  // Phase 3: searchQuery pagination for uncategorised brainrots (not in Eldorado's library)
  if (uncategorized.length > 0) {
    const phase3Combos: { brainrot: MatchedBrainrot; mutation: typeof mutations[0] }[] = []
    for (const brainrot of uncategorized) {
      for (const mutation of mutations) {
        phase3Combos.push({ brainrot, mutation })
      }
    }
    console.log(`[price-fetcher] Phase 3: ${phase3Combos.length} combos across ${uncategorized.length} uncategorised brainrots`)

    for (let i = 0; i < phase3Combos.length; i += BATCH_SIZE) {
      const batch = phase3Combos.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.map(async ({ brainrot, mutation }): Promise<PriceResult> => {
          const label = `${brainrot.name}/${mutation.name}`
          const slug = mutationToSlug(mutation.name)
          try {
            return await onceAndRetry(async () => {
              // Paginating multiple pages — give this a longer timeout than single-page fetches.
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), fetchTimeout * 4)
              try {
                const offers = await fetchOffersViaSearchAllPages(brainrot.name, slug, brainrot.rarity, controller.signal)
                const trusted = filterTrustedOffers(offers, brainrot.name, slug)
                const { price, count, candidatesAsc } = pickFloorPrice(trusted.map(o => ({ price: o.offer.pricePerUnitInUSD.amount, rc: o.userOrderInfo.ratingCount, fb: o.userOrderInfo.feedbackScore, sellerId: o.offer.userId })))
                const minListings = getMinListings(brainrot.rarity, mutation.name)
                const mutKeyLower = mutation.name.toLowerCase()
                if (CONSTRAINT_MUTATIONS.has(mutKeyLower)) {
                  candidatesByCombo.set(`${brainrot.id}:${mutKeyLower}`, candidatesAsc)
                }
                return {
                  brainrotId: brainrot.id,
                  brainrotName: brainrot.name,
                  mutation: mutation.name,
                  mutationId: mutation.id,
                  usdPrice: price,
                  robuxPrice: price !== null ? Math.round(price * 100) : null,
                  listingCount: count,
                  isOutlier: count < minListings,
                }
              } finally {
                clearTimeout(timer)
              }
            }, label)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[price-fetcher] FAIL (phase 3) ${label}: ${msg}`)
            return {
              brainrotId: brainrot.id,
              brainrotName: brainrot.name,
              mutation: mutation.name,
              mutationId: mutation.id,
              usdPrice: null,
              robuxPrice: null,
              listingCount: 0,
              isOutlier: true,
              error: msg,
            }
          }
        })
      )

      for (const r of batchResults) {
        if (r.robuxPrice !== null) totalWithPrices++
        else totalNullPrices++
        if (r.error) totalErrors++
      }
      results.push(...batchResults)

      if (i + BATCH_SIZE < phase3Combos.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY))
      }
    }
  }

  // Monotonic-constraint sweep: enforce Default < Gold < Diamond on the floor price.
  // Walks the trusted-price ladder up past the predecessor's floor when the picked
  // floor inverts. If no candidate qualifies, null out — better to record "no
  // defensible floor" than commit to a known-wrong number (an inversion can only
  // come from a mislabeled or fraud listing that slipped past the trust filter).
  const findResult = (bid: string, mutName: string): PriceResult | undefined =>
    results.find(r => r.brainrotId === bid && r.mutation.toLowerCase() === mutName.toLowerCase())

  const walkUp = (
    target: PriceResult,
    candidatesKey: string,
    floor: number,
    predecessorLabel: string,
    counters: { adjusted: number; nullified: number }
  ) => {
    if (target.usdPrice === null || target.usdPrice > floor) return
    const candidates = candidatesByCombo.get(candidatesKey) ?? []
    const next = candidates.find(p => p > floor)
    if (next != null) {
      const idx = candidates.indexOf(next)
      const newCount = candidates.length - idx
      const minListings = getMinListings(rarityById.get(target.brainrotId) ?? '', target.mutation)
      console.log(`[price-fetcher] monotonic: ${target.brainrotName}/${target.mutation} $${target.usdPrice} → $${next} (above ${predecessorLabel} $${floor})`)
      target.usdPrice = next
      target.robuxPrice = Math.round(next * 100)
      target.listingCount = newCount
      target.isOutlier = newCount < minListings
      counters.adjusted++
    } else {
      console.log(`[price-fetcher] monotonic: ${target.brainrotName}/${target.mutation} nullified (no listing > ${predecessorLabel} $${floor})`)
      target.usdPrice = null
      target.robuxPrice = null
      target.listingCount = 0
      target.isOutlier = true
      counters.nullified++
    }
  }

  const counters = { adjusted: 0, nullified: 0 }
  const brainrotIds = new Set(results.map(r => r.brainrotId))
  for (const bid of brainrotIds) {
    // const def = findResult(bid, 'Default')   // re-enable for Default < Gold check
    const gold = findResult(bid, 'Gold')
    const dia = findResult(bid, 'Diamond')

    // Skip when Gold is at the R$50 floor — same reason as before for
    // Default-at-floor: Floor-pile brainrots get spread across mutations by
    // the apply-flow's floor-interpolation. Walking Diamond past $0.50 picks
    // up a noise listing (e.g. a stray $0.52) that breaks that interpolation.
    //
    // We intentionally do NOT enforce Default < Gold. Some brainrots (e.g.
    // La Easter Grande) genuinely price Default above Gold on the market —
    // forcing Gold up sacrifices well-supported listings for noise.
    if (gold?.robuxPrice === 50) continue

    // To re-enable the Default < Gold rule, uncomment this block (and the `def`
    // lookup above, plus add 'default' back to CONSTRAINT_MUTATIONS).
    // if (gold && def?.usdPrice != null) {
    //   walkUp(gold, `${bid}:gold`, def.usdPrice, 'Default', counters)
    // }

    if (dia && gold?.usdPrice != null) {
      walkUp(dia, `${bid}:diamond`, gold.usdPrice, 'Gold', counters)
    }
  }

  if (counters.adjusted || counters.nullified) {
    console.log(`[price-fetcher] monotonic constraint applied: adjusted=${counters.adjusted}, nullified=${counters.nullified}`)
  }

  console.log(`[price-fetcher] FINISHED: total=${results.length}, withPrices=${totalWithPrices}, nullPrices=${totalNullPrices}, errors=${totalErrors}`)
  return results
}
