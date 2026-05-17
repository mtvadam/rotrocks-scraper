import { transaction } from '@/lib/db'
import type { PoolClient } from 'pg'

// Build and execute a multi-row INSERT in chunks. Drops the "one query per row"
// pattern that burns through the DB pool. Each chunk is a single SQL statement
// with ($1,$2,...),($K,$K+1,...) VALUES — Postgres happily accepts thousands
// of rows per statement up to ~65k parameters.
//
// Typical usage:
//   await bulkInsert({
//     table: 'PriceSnapshot',
//     columns: ['id', 'brainrotId', 'mutationId', 'usdPrice', ...],
//     rows: results.map(r => [createId(), r.brainrotId, r.mutationId, r.usdPrice, ...]),
//     chunk: 500,
//     onConflict: undefined,
//   })
export interface BulkWriteOptions {
  table: string
  columns: string[]
  rows: unknown[][]
  chunk?: number
  /**
   * Optional ON CONFLICT clause (without the "ON CONFLICT" keyword).
   * Example: `("brainrotId","mutationId") DO UPDATE SET "robuxValue" = EXCLUDED."robuxValue", "updatedAt" = NOW()`
   */
  onConflict?: string
}

function buildChunkSql(table: string, columns: string[], rowCount: number, colCount: number, onConflict?: string) {
  const colList = columns.map(c => `"${c}"`).join(', ')
  const valuesClause = Array.from({ length: rowCount }, (_, rowIdx) => {
    const placeholders = Array.from({ length: colCount }, (_, colIdx) => `$${rowIdx * colCount + colIdx + 1}`).join(', ')
    return `(${placeholders})`
  }).join(', ')
  const tail = onConflict ? ` ON CONFLICT ${onConflict}` : ''
  return `INSERT INTO "${table}" (${colList}) VALUES ${valuesClause}${tail}`
}

// Errors that signal a transient connection issue worth retrying with smaller chunks.
function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const m = err.message.toLowerCase()
  return (
    m.includes('connection terminated') ||
    m.includes('connection closed') ||
    m.includes('connection timeout') ||
    m.includes('echeckouttimeout') ||
    m.includes('econnreset') ||
    m.includes('enotfound')
  )
}

async function writeChunk(table: string, columns: string[], slice: unknown[][], onConflict: string | undefined): Promise<number> {
  const colCount = columns.length
  const flat: unknown[] = []
  for (const row of slice) {
    if (row.length !== colCount) {
      throw new Error(`bulkInsert: row has ${row.length} values but ${colCount} columns`)
    }
    for (const v of row) flat.push(v)
  }
  const sql = buildChunkSql(table, columns, slice.length, colCount, onConflict)
  let result = 0
  await transaction(async (client: PoolClient) => {
    const res = await client.query(sql, flat)
    result = res.rowCount ?? 0
  })
  return result
}

// Recursively try smaller chunk sizes when a transient connection error happens.
// Halves the chunk on each retry until it succeeds or the chunk is too small to split.
async function writeChunkWithFallback(
  table: string, columns: string[], slice: unknown[][], onConflict: string | undefined, attempt = 0
): Promise<number> {
  try {
    return await writeChunk(table, columns, slice, onConflict)
  } catch (err) {
    if (!isTransientDbError(err) || slice.length <= 25 || attempt >= 4) throw err
    const half = Math.max(25, Math.floor(slice.length / 2))
    console.warn(`[bulk-write] transient error on ${slice.length}-row chunk, retrying as ${half}-row halves: ${err instanceof Error ? err.message : err}`)
    let total = 0
    for (let i = 0; i < slice.length; i += half) {
      total += await writeChunkWithFallback(table, columns, slice.slice(i, i + half), onConflict, attempt + 1)
    }
    return total
  }
}

export async function bulkInsert(opts: BulkWriteOptions): Promise<number> {
  const chunkSize = opts.chunk ?? 500
  if (opts.rows.length === 0) return 0

  let total = 0
  for (let i = 0; i < opts.rows.length; i += chunkSize) {
    const slice = opts.rows.slice(i, i + chunkSize)
    total += await writeChunkWithFallback(opts.table, opts.columns, slice, opts.onConflict)
  }
  return total
}
