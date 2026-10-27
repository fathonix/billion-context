/** One-off migration: unified sqlite index.db -> MySQL/MariaDB backend.
 *
 *  Copies rows byte-for-byte (the mysql DDL in src/storage/mysql.ts is the
 *  same v7 shape as sqlite) instead of replaying sessions through
 *  ingestSession — a replay would re-serialize messages and could drop
 *  plan-space detail the rows already carry.
 *
 *  usage: node --import tsx scripts/migrate-storage.ts --from <index.db> --to <mysql://user:pass@host:port/db> [--dry-run]
 *
 *  Run it against a COPY of index.db (VACUUM INTO inside the container), never
 *  against the live file. The target database must be empty or disposable:
 *  rows are REPLACE'd by primary key, so a re-run is idempotent.
 */
import { DatabaseSync } from "node:sqlite";
import { createPool } from "mysql2/promise";
import { openBackend } from "../src/storage/backend.ts";
import { loadLegacyView } from "../src/storage/ingest.ts";

const SCHEMA_VERSION = 7;
const TABLES = [
    "sessions",
    "content",
    "messages",
    "blocks",
    "dead_refs",
    "refs",
    "checkpoints",
    "ccr_entries",
    "conversations",
    "session_ext",
    "kv_store",
    "message_media",
] as const;
const BATCH = 200;

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const from = arg("from");
    const to = arg("to");
    const dryRun = process.argv.includes("--dry-run");
    if (!from || !to) {
        console.error("usage: node --import tsx scripts/migrate-storage.ts --from <index.db> --to <mysql://user:pass@host:port/db> [--dry-run]");
        process.exit(2);
    }

    const db = new DatabaseSync(from, { readOnly: true });
    const version = (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version;
    if (version !== SCHEMA_VERSION) {
        console.error(`[migrate] ${from}: schema version ${String(version)} != ${SCHEMA_VERSION} — open it with this build once, then retry`);
        process.exit(2);
    }
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== "ok") {
        console.error(`[migrate] ${from}: quick_check failed (${String(check?.quick_check).slice(0, 300)}) — repair with .recover first`);
        process.exit(2);
    }

    const sqliteTables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    const missing = TABLES.filter((t) => !sqliteTables.has(t));
    if (missing.length > 0) {
        console.error(`[migrate] ${from}: missing tables ${missing.join(", ")}`);
        process.exit(2);
    }

    const counts = new Map<string, number>();
    for (const t of TABLES) counts.set(t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    console.log(`[migrate] source: ${from}`);
    for (const t of TABLES) console.log(`[migrate]   ${t.padEnd(14)} ${counts.get(t)}`);

    // DDL + schema stamp through the real backend so the schema is never a
    // second copy of mysql.ts that can drift.
    const backend = await openBackend("mysql", to);
    await backend.init?.();
    await backend.close();

    if (dryRun) {
        console.log("[migrate] --dry-run: schema ensured, no rows copied");
        return;
    }

    const pool = createPool({ uri: to, supportBigNumbers: true });
    try {
        for (const table of TABLES) {
            if (counts.get(table) === 0) continue;
            const srcCols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
            const [destRows] = (await pool.query(`SHOW COLUMNS FROM ${table}`)) as unknown as [{ Field: string }[]];
            const destCols = new Set(destRows.map((c) => c.Field));
            const cols = srcCols.filter((c) => destCols.has(c));
            if (cols.length !== srcCols.length) {
                console.log(`[migrate]   ${table}: skipping source-only columns ${srcCols.filter((c) => !destCols.has(c)).join(", ")}`);
            }
            const stmt = db.prepare(`SELECT ${cols.join(", ")} FROM ${table}`);

            let copied = 0;
            let batch: unknown[][] = [];
            let batchBytes = 0;
            const flush = async (): Promise<void> => {
                if (batch.length === 0) return;
                await pool.query(`REPLACE INTO ${table} (${cols.join(", ")}) VALUES ?`, [batch]);
                copied += batch.length;
                batch = [];
                batchBytes = 0;
            };
            for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
                // LONGTEXT columns come back from sqlite as Blobs (bytes);
                // mysql2 would escape a typed array as `1,2,3`, so decode to
                // text — the mysql DDL stores these as LONGTEXT exactly
                // because the bytes are utf8 JSON/base64.
                const values = cols.map((c) => {
                    const v = row[c];
                    if (v === null || v === undefined) return null;
                    return v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : v;
                });
                batch.push(values);
                // LONGTEXT rows (content.bytes) can be megabytes; keep each
                // statement well under the server's max_allowed_packet.
                for (const v of values) if (typeof v === "string") batchBytes += v.length;
                if (batch.length >= BATCH || batchBytes >= 8 * 1024 * 1024) await flush();
            }
            await flush();

            const [dest] = (await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)) as unknown as [{ n: number }[]];
            const got = Number(dest[0]?.n ?? 0);
            const want = counts.get(table) ?? 0;
            if (got !== want) {
                console.error(`[migrate]   ${table}: FAILED — copied ${copied}, target has ${got}, source has ${want}`);
                process.exitCode = 1;
            } else {
                console.log(`[migrate]   ${table}: ${copied} rows ok`);
            }
        }

        const [bytes] = (await pool.query("SELECT COALESCE(SUM(byte_len), 0) AS b FROM content")) as unknown as [{ b: number | string }[]];
        const srcBytes = (db.prepare("SELECT COALESCE(SUM(byte_len), 0) AS b FROM content").get() as { b: number }).b;
        if (Number(bytes[0]?.b ?? 0) !== srcBytes) {
            console.error(`[migrate] content byte_len total mismatch: source ${srcBytes}, target ${String(bytes[0]?.b)}`);
            process.exitCode = 1;
        } else {
            console.log(`[migrate] content bytes: ${srcBytes} ok`);
        }
    } finally {
        await pool.end();
    }

    // Read-back parity: the app's own loader must produce the identical view
    // from both backends, and the target must pass its projection checks.
    const src = await openBackend("sqlite", from);
    const dst = await openBackend("mysql", to);
    try {
        const ids = await src.listSessionIds();
        let bad = 0;
        let preexisting = 0;
        for (const id of ids) {
            const rows = async (b: typeof src): Promise<Parameters<typeof loadLegacyView>[0]> => ({
                session: await b.getSessionRow(id),
                messages: await b.getMessages(id),
                blocks: await b.getBlocks(id),
                deadRefs: await b.getDeadRefs(id),
                refs: await b.getRefs(id),
            });
            const a = JSON.stringify(loadLegacyView(await rows(src)));
            const b = JSON.stringify(loadLegacyView(await rows(dst)));
            // Projections can already be stale in the source (re-minted refs);
            // parity is what matters, not per-side ok-ness.
            const projA = JSON.stringify(await src.verifyProjections(id));
            const projB = JSON.stringify(await dst.verifyProjections(id));
            if (a !== b) bad++;
            if (projA !== projB) bad++;
            if (a !== b || projA !== projB) {
                console.error(`[migrate]   ${id}: ${a !== b ? "view differs " : ""}${projA === projB ? "" : `projections differ: ${projA} vs ${projB}`}`);
            } else if (!projA.startsWith('{"ok":true')) {
                preexisting++;
            }
        }
        if (bad === 0) {
            console.log(`[migrate] read-back parity: ${ids.length} sessions identical${preexisting > 0 ? ` (${preexisting} pre-existing projection miss on both sides)` : ""}`);
        }
        else process.exitCode = 1;
    } finally {
        await src.close();
        await dst.close();
    }
    console.log(process.exitCode ? "[migrate] finished with errors" : "[migrate] done");
}

await main();
