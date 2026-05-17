# rotrocks-scraper

Standalone Node script that scrapes Eldorado.gg for brainrot prices and writes them directly to the same Supabase Postgres database that powers [rot.rocks](https://rot.rocks). Designed to run on a small Linux box (EC2 t3.micro is fine) every 6 hours via systemd timer.

Why standalone (not part of the main RotDotRocks Next.js app):
- rot.rocks is hosted on Cloudflare Workers, which kills long-running requests. A full scrape takes 5-20+ min — way over any Worker timeout.
- The scrape is a backend-only batch job. The web app doesn't need any of this code at runtime; it just reads the rows the scraper writes.

## What it does on each run

1. Acquires a DB-backed lock (so it can't double-run with itself or the admin UI).
2. Calls `fetchAllBrainrotPrices()` — the same Eldorado scraper the main repo uses for manual snapshots.
3. Bulk-inserts `PriceSnapshot` rows for every priced result.
4. Calls `applySnapshots()` with only this run's IDs — meaning each `(brainrot, mutation)` pair has exactly one snapshot in the apply batch, so the "average multiple snapshots" branch becomes a no-op. **Latest run always wins** for `BrainrotMutationValue`.
5. Recalculates demand/trend.
6. Releases the lock and exits.

Suspicious/projected flags are computed and stored for the chart UI, but they never gate application — every value gets applied, mirroring "click Apply All without checking" in the admin UI.

## Setup

### 1. Local prerequisites

- Node 20+
- A Supabase Postgres direct-connection URL (port 5432, NOT the 6543 transaction pooler — pg's prepared statements break under pgbouncer)

### 2. Install + smoke test on your laptop

```bash
git clone https://github.com/<your-user>/rotrocks-scraper.git
cd rotrocks-scraper
cp .env.example .env
$EDITOR .env                # fill in DATABASE_URL
npm install
npm run snapshot            # takes 5-20 min; writes to whatever DB you configured
```

⚠️ This writes live to whatever DB you configured. Don't run it against prod unless you actually want a snapshot to land.

### 3. Deploy to EC2

Tested on Amazon Linux 2023. The layout assumes you'll host other rot.rocks services (discord bot, API, etc.) on the same box as siblings under `/opt/rotrocks/`.

**Directory layout this repo assumes on EC2:**

```
/opt/rotrocks/scraper/              # this repo lives here
/etc/rotrocks/scraper.env           # this service's secrets (mode 600, root)
/etc/systemd/system/rotrocks-scraper.{service,timer}
```

(Future services follow the same pattern: `/opt/rotrocks/discord-bot/`, `/etc/rotrocks/discord-bot.env`, `rotrocks-discord-bot.service`.)

```bash
ssh ec2-user@<your-ec2-public-ip>

# Install Node 20 + git
sudo dnf update -y
sudo dnf install -y git make gcc-c++
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs

# Create the parent dirs (one-time, shared across all rot.rocks services)
sudo mkdir -p /opt/rotrocks /etc/rotrocks
sudo chown ec2-user:ec2-user /opt/rotrocks

# Clone this repo as the "scraper" service
git clone https://github.com/<your-user>/rotrocks-scraper.git /opt/rotrocks/scraper
cd /opt/rotrocks/scraper
npm install

# Set up the secrets file (root-owned, mode 600)
sudo tee /etc/rotrocks/scraper.env > /dev/null <<'EOF'
DATABASE_URL=postgresql://...your-direct-supabase-url:5432/postgres
NODE_ENV=production
EOF
sudo chmod 600 /etc/rotrocks/scraper.env
sudo chown root:root /etc/rotrocks/scraper.env

# Smoke test (live scrape — only do this if ready)
set -a && source /etc/rotrocks/scraper.env && set +a
npm run snapshot

# If happy, install the systemd unit + timer
sudo cp systemd/rotrocks-scraper.service /etc/systemd/system/
sudo cp systemd/rotrocks-scraper.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rotrocks-scraper.timer

# Verify the timer is loaded
systemctl list-timers rotrocks-scraper.timer
```

The timer fires at 00:00, 06:00, 12:00, 18:00 UTC every day. Adjust `OnCalendar` in `systemd/rotrocks-scraper.timer` if you want a different schedule.

### 4. Day-to-day operations

```bash
# Trigger a run right now
sudo systemctl start rotrocks-scraper.service

# Tail logs while running
sudo journalctl -u rotrocks-scraper.service -f

# Last 200 log lines
sudo journalctl -u rotrocks-scraper.service -n 200 --no-pager

# Pause the schedule
sudo systemctl stop rotrocks-scraper.timer

# Resume
sudo systemctl start rotrocks-scraper.timer

# Pull a code update
cd /opt/rotrocks/scraper && git pull && npm install
```

## Keeping in sync with the main repo

The files under `src/lib/` are **mirrors** of files in the main `RotDotRocks` repo. When you fix a scraper bug there, run the sync script from this repo:

```bash
cd ~/Desktop/CursorProjects/rotrocks-scraper
./scripts/sync-from-main.sh
# review the diff
git diff src/lib/
git add src/lib/
git commit -m "Sync from main: <describe the fix>"
git push
# then on EC2
ssh ec2-user@<your-ec2>
cd /opt/rotrocks/scraper && git pull
```

**Never edit `src/lib/` files directly in this repo.** Make changes in the main RotDotRocks repo (where the admin UI also uses them), then sync. Divergence between the two repos = "works in admin but breaks in cron" pain.

## Exit codes

- `0` — success
- `1` — fatal (scrape failed AND nothing was applied)
- `2` — partial (scrape interrupted but partial results were applied — systemd treats this as success)

## Files in this repo

| Path | What it is |
|---|---|
| `src/cron-snapshot.ts` | The runner. This is what `npm run snapshot` executes. |
| `src/lib/price-fetcher.ts` | Eldorado scraper. Mirrored from main repo. |
| `src/lib/apply-snapshots.ts` | Converts PriceSnapshot rows → BrainrotMutationValue upserts. Mirrored. |
| `src/lib/db.ts` | **Diverges from main repo** — strips out the Cloudflare/Hyperdrive lookup. Reads `DATABASE_URL` from env. |
| `src/lib/bulk-write.ts` | Multi-row INSERT helper. Mirrored. |
| `src/lib/demand-calculator.ts` | Demand/trend computation. Mirrored. |
| `src/lib/value-interpolation.ts` | Floor-price interpolation across mutations. Mirrored. |
| `src/lib/value-state.ts` | Volatile-jump detection. Mirrored. |
| `systemd/*.service` `*.timer` | EC2 systemd units. |
| `scripts/sync-from-main.sh` | Pulls fresh copies of the mirrored libs from your main repo. |
