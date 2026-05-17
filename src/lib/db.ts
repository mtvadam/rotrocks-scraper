import pg from 'pg'
import type { PoolClient } from 'pg'

// Resolve the actual pg module through any number of ESM .default wrappers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolved: any = pg
while (resolved && !resolved.Pool && resolved.default) {
  resolved = resolved.default
}

const PoolCtor = resolved.Pool
const pgTypes = resolved.types

// Parse bigint as BigInt instead of string
pgTypes.setTypeParser(20, (val: string) => BigInt(val))

// Parse `timestamp without time zone` as UTC instead of "local time in Node's TZ".
pgTypes.setTypeParser(1114, (val: string) => new Date(val + 'Z'))

// Shared singleton pool — created lazily on first use.
//
// Standalone EC2 version: reads DATABASE_URL straight from process.env.
// The Cloudflare/Hyperdrive lookup that the main RotDotRocks repo does is
// stripped out — this script never runs inside a Worker.
declare global {
  // eslint-disable-next-line no-var
  var __pgPool: pg.Pool | undefined
}

function resolveConnectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set — check /etc/rotrocks/snapshot.env or your local .env')
  return url
}

function buildPool(): pg.Pool {
  const p = new PoolCtor({
    connectionString: resolveConnectionString(),
    // Single-process cron — keep the pool tiny.
    max: 5,
    idleTimeoutMillis: 8_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  })
  // Mandatory error handler — without it, idle-client errors become unhandled
  // events and Node may terminate the process.
  p.on('error', (err: Error) => {
    console.error('[pg.Pool] idle-client error (handled):', err.message)
  })
  return p
}

export function getPool(): pg.Pool {
  if (globalThis.__pgPool) return globalThis.__pgPool
  const p = buildPool()
  if (process.env.NODE_ENV !== 'production') {
    globalThis.__pgPool = p
  }
  return p
}

// Backwards-compat: legacy code that imports `pool` directly still works.
export const pool = new Proxy({} as pg.Pool, {
  get(_, prop) {
    const target = getPool() as unknown as Record<string | symbol, unknown>
    const value = target[prop]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  },
})

function isTransientConnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { message?: string; code?: string }
  const msg = e.message?.toLowerCase() ?? ''
  return (
    e.code === 'ECONNRESET' ||
    e.code === 'EPIPE' ||
    msg.includes('connection terminated') ||
    msg.includes('connection error') ||
    msg.includes('socket has been ended') ||
    msg.includes('connection ended unexpectedly') ||
    msg.includes('client was closed') ||
    msg.includes('cannot use a pool after calling end')
  )
}

async function poolQueryWithRetry(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  const p = getPool()
  try {
    return await p.query(text, params)
  } catch (err) {
    if (isTransientConnError(err)) {
      return await p.query(text, params)
    }
    throw err
  }
}

/** Run a single query through the shared pool */
export async function query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await poolQueryWithRetry(text, params)
  return result.rows as T[]
}

/** Run a single query, return first row or null */
export async function queryOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null> {
  const result = await poolQueryWithRetry(text, params)
  return (result.rows[0] as T) ?? null
}

/** Run a single query, return affected row count */
export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await poolQueryWithRetry(text, params)
  return result.rowCount ?? 0
}

/** Run multiple queries on a single connection, then release it back to the pool. */
export async function withConnection<T>(fn: (db: {
  query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>
  queryOne: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R | null>
  execute: (text: string, params?: unknown[]) => Promise<number>
}) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    return await fn({
      query: async <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
        const result = await client.query(text, params)
        return result.rows as R[]
      },
      queryOne: async <R = Record<string, unknown>>(text: string, params?: unknown[]) => {
        const result = await client.query(text, params)
        return (result.rows[0] as R) ?? null
      },
      execute: async (text: string, params?: unknown[]) => {
        const result = await client.query(text, params)
        return result.rowCount ?? 0
      },
    })
  } finally {
    client.release()
  }
}

/** Transaction helper — single connection with BEGIN/COMMIT, released to pool on exit */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
