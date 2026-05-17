#!/usr/bin/env tsx
/**
 * cron-snapshot.ts — standalone runner for the price-snapshot pipeline.
 *
 * Runs on EC2 every 6 hours via systemd timer. Replicates the behavior of the
 * admin "Take Snapshot" + "Apply All" buttons on rot.rocks, so an unattended
 * run produces the same end state as a human admin.
 *
 * "Latest snapshot wins" guarantee:
 *   - Each run creates fresh PriceSnapshot rows with brand new IDs.
 *   - applySnapshots() is called with ONLY this run's IDs, so the averaging
 *     branch in buildPreview collapses to a single value per (brainrot, mutation).
 *   - The BMV upsert uses ON CONFLICT DO UPDATE, so the most recent run is
 *     what the public site reads.
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (scrape failed AND no partial results, or DB write failed)
 *   2 — partial: scrape was interrupted but partial results were applied
 */

import 'dotenv/config'
import { createId } from '@paralleldrive/cuid2'
import { fetchAllBrainrotPrices, type PriceResult } from '@/lib/price-fetcher'
import { bulkInsert } from '@/lib/bulk-write'
import { applySnapshots } from '@/lib/apply-snapshots'
import { calculateAllDemand } from '@/lib/demand-calculator'
import { execute, queryOne, getPool } from '@/lib/db'

const RUN_LABEL = 'cron-' + new Date().toISOString().replace(/[:.]/g, '-')
const LOCK_KEY = 'price_import_running'
const PROGRESS_KEY = 'price_import_progress'

function log(msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString()
  if (extra) {
    console.log(`[${ts}] [${RUN_LABEL}] ${msg}`, JSON.stringify(extra))
  } else {
    console.log(`[${ts}] [${RUN_LABEL}] ${msg}`)
  }
}

function errLog(msg: string, err?: unknown) {
  const ts = new Date().toISOString()
  console.error(`[${ts}] [${RUN_LABEL}] ${msg}`, err ?? '')
}

function upsertConfig(key: string, value: string) {
  return execute(
    `INSERT INTO "SystemConfig" ("id", "key", "value", "updatedAt")
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT ("key") DO UPDATE SET "value" = $3, "updatedAt" = NOW()`,
    [createId(), key, value]
  )
}

async function main() {
  const startedAt = Date.now()
  log('starting price snapshot run')

  // 1. Acquire run lock — also kills any previously stuck run since the admin
  //    UI shares this same lock key.
  const runId = RUN_LABEL
  await Promise.all([
    upsertConfig(LOCK_KEY, runId),
    upsertConfig(PROGRESS_KEY, JSON.stringify({ fetched: 0, total: 0, runId, updatedAt: Date.now() })),
  ])
  log('acquired lock', { runId })

  let exitCode = 0
  const snapshotIds: string[] = []

  try {
    // 2. Run the scrape with the same params as the admin trigger.
    let callCount = 0
    const saveProgress = async (fetched: number, total: number) => {
      callCount++
      if (callCount % 5 !== 0 && fetched !== total) return
      try {
        await upsertConfig(PROGRESS_KEY, JSON.stringify({ fetched, total, runId, updatedAt: Date.now() }))
      } catch {
        // non-fatal
      }
      if (fetched % 25 === 0 || fetched === total) {
        log(`scrape progress: ${fetched}/${total}`)
      }
    }

    const results: PriceResult[] = []
    let scrapeError: unknown = null
    try {
      log('starting fetchAllBrainrotPrices...')
      await fetchAllBrainrotPrices({
        onProgress: saveProgress,
        batchSize: 5,
        batchDelay: 800,
        fetchTimeout: 120000,
        accumulator: results,
      })
      log('scrape completed cleanly')
    } catch (err) {
      scrapeError = err
      const msg = err instanceof Error ? err.message : String(err)
      errLog(`scrape interrupted — will still apply ${results.length} accumulated results`, msg)
    }

    // 3. Bulk-insert PriceSnapshot rows, capturing IDs as we generate them.
    const priced = results.filter(r => r.robuxPrice !== null)
    log(`bulk inserting ${priced.length} snapshots (out of ${results.length} total)`)

    if (priced.length > 0) {
      const nowIso = new Date()
      const rows: unknown[][] = []
      for (const r of priced) {
        const id = createId()
        snapshotIds.push(id)
        rows.push([
          id, r.brainrotId, r.mutationId, r.usdPrice, r.robuxPrice,
          r.listingCount, r.isOutlier, false, 'eldorado', nowIso,
        ])
      }

      const t0 = Date.now()
      try {
        const inserted = await bulkInsert({
          table: 'PriceSnapshot',
          columns: ['id', 'brainrotId', 'mutationId', 'usdPrice', 'robuxPrice', 'listingCount', 'isOutlier', 'appliedToValues', 'source', 'createdAt'],
          rows,
          chunk: 500,
        })
        log(`bulk insert done: ${inserted} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      } catch (err) {
        const dumpPath = `/tmp/price-snapshot-dump-${runId}.json`
        try {
          const fs = await import('node:fs/promises')
          await fs.writeFile(dumpPath, JSON.stringify(priced, null, 2))
          errLog(`BULK INSERT FAILED — dumped ${priced.length} results to ${dumpPath}`, err)
        } catch (dumpErr) {
          errLog(`BULK INSERT FAILED and dump also failed`, [err, dumpErr])
        }
        throw err
      }
    }

    // 4. Auto-apply EVERYTHING. verifiedBrainrotIds = all unique brainrotIds
    //    matches the "Apply All" workflow. Suspicious/projected flags are
    //    computed for the chart UI but never gate application.
    let applyResult: Awaited<ReturnType<typeof applySnapshots>> | null = null
    if (snapshotIds.length > 0) {
      const allBrainrotIds = [...new Set(priced.map(r => r.brainrotId))]
      log(`auto-applying ${snapshotIds.length} snapshots across ${allBrainrotIds.length} brainrots`)
      const t0 = Date.now()
      applyResult = await applySnapshots({
        snapshotIds,
        verifiedBrainrotIds: allBrainrotIds,
      })
      log(`apply done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, {
        brainrotsUpdated: applyResult.brainrotsUpdated,
        valuesUpdated: applyResult.valuesUpdated,
        appliedSnapshots: applyResult.appliedSnapshotIds,
        volatileCount: applyResult.volatileCount,
      })
    } else {
      log('no priced snapshots to apply — skipping apply step')
    }

    // 5. Recalculate demand.
    log('calculating demand...')
    const demandResult = await calculateAllDemand()
    log('demand calculation done', { updated: demandResult.updated, skipped: demandResult.skipped })

    // 6. Write the run log to SystemConfig (the admin UI reads this).
    const logData = {
      totalFetched: results.length,
      snapshotsCreated: snapshotIds.length,
      valuesUpdated: applyResult?.valuesUpdated ?? 0,
      brainrotsUpdated: applyResult?.brainrotsUpdated ?? 0,
      demandUpdated: demandResult.updated,
      demandSkipped: demandResult.skipped,
      withPrice: priced.length,
      outliers: results.filter(r => r.isOutlier).length,
      errors: results.filter(r => r.error).length,
      volatileCount: applyResult?.volatileCount ?? 0,
      fetchedAt: new Date().toISOString(),
      triggeredManually: false,
      source: 'cron-ec2',
      runId,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      wasInterrupted: scrapeError !== null,
    }
    await upsertConfig('last_price_import', JSON.stringify(logData))
    log('FINAL', logData)

    if (scrapeError) exitCode = 2
  } catch (err) {
    errLog('FATAL', err)
    exitCode = 1
  } finally {
    // 7. Release the lock (only if still ours).
    try {
      const lock = await queryOne<{ value: string }>(
        `SELECT "value" FROM "SystemConfig" WHERE "key" = $1`, [LOCK_KEY]
      )
      if (lock?.value === runId) {
        await upsertConfig(LOCK_KEY, 'false')
        log('released lock')
      } else {
        log('lock was taken over by another run; not releasing', { currentLock: lock?.value })
      }
    } catch (err) {
      errLog('failed to release lock', err)
    }

    // 8. Close the pool so the process exits.
    try {
      await getPool().end()
    } catch (err) {
      errLog('failed to close pool', err)
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  log(`run finished in ${elapsed}s with exit code ${exitCode}`)
  process.exit(exitCode)
}

main().catch((err) => {
  errLog('UNCAUGHT', err)
  process.exit(1)
})
