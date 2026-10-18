/**
 * `npm run e2e:sim`: browser pass over the simulated league, one checkpoint database at a time.
 *
 *   npm run e2e:sim                       all nine checkpoints (builds the app and the snapshots if needed)
 *   npm run e2e:sim -- --only regular-season,playoffs [--no-build] [--regen]
 *
 * For each checkpoint: restore its snapshot into .pglite-sim/<name>, add throwaway auth rows, start `next start` on it
 * with the simulated clock (scripts/sim/clock-shim.mjs, preloaded through NODE_OPTIONS) and run playwright.sim.config.ts.
 * Never touches ./.pglite, .pglite-e2e or .pglite-mobile.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSnapshots, materialize, snapshotsExist } from "./build-snapshots";
import { CHECKPOINTS, RESULT_DIR, SIM_DIR, dbDir, type Checkpoint } from "./common";
import { prepare } from "./prepare";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

async function waitFor(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not come up at ${url}`);
}

type Visit = { cp: string; role: string; name: string; url: string; status: number | null; ttfbMs: number | null; loadMs: number; ok: boolean; problems: string[] };

async function main() {
  const only = arg("only")?.split(",") as Checkpoint[] | undefined;
  const list = only ?? [...CHECKPOINTS];
  for (const cp of list) if (!CHECKPOINTS.includes(cp)) throw new Error(`unknown checkpoint ${cp}`);
  const t0 = Date.now();

  if (flag("regen") || !snapshotsExist()) {
    console.log("Building checkpoint snapshots from one simulation run...");
    await buildSnapshots();
  }
  if (!flag("no-build")) {
    console.log("next build...");
    const b = spawnSync("npx", ["next", "build"], { stdio: "inherit", shell: true });
    if (b.status !== 0) process.exit(b.status ?? 1);
  }
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  const shim = pathToFileURL(path.resolve("scripts/sim/clock-shim.mjs")).href;
  const nextBin = path.resolve("node_modules/next/dist/bin/next");
  const secret = "sim-cron-secret";
  const summary: { cp: string; testsOk: boolean; visits: Visit[] }[] = [];

  for (const cp of list) {
    console.log(`\n=== ${cp} ===`);
    fs.rmSync(path.join(RESULT_DIR, `${cp}.jsonl`), { force: true });
    fs.rmSync(path.resolve("screenshots", "sim", cp), { recursive: true, force: true });
    await materialize(cp);
    const meta = await prepare(cp);
    const port = await freePort();
    const base = `http://localhost:${port}`;
    const log = fs.openSync(path.join(RESULT_DIR, `${cp}.server.log`), "w");
    const server = spawn(process.execPath, [nextBin, process.env.SIM_DEV === "1" ? "dev" : "start", "-p", String(port)], {
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        DATABASE_URL: `pglite:./${path.relative(process.cwd(), dbDir(cp)).split(path.sep).join("/")}`,
        SIM_NOW: meta.now,
        CRON_SECRET: secret,
        NEXT_PUBLIC_APP_URL: base,
        NODE_OPTIONS: `--import ${shim}`,
      },
    });
    let testsOk = false;
    try {
      await waitFor(`${base}/login`, 120_000);
      const run = spawnSync("npx", ["playwright", "test", "-c", "playwright.sim.config.ts", ...(arg("pw")?.split(" ") ?? [])], {
        stdio: "inherit",
        shell: true,
        env: { ...process.env, SIM_CHECKPOINT: cp, SIM_BASE_URL: base, CRON_SECRET: secret },
      });
      testsOk = run.status === 0;
    } finally {
      killTree(server);
      fs.closeSync(log);
    }
    const file = path.join(RESULT_DIR, `${cp}.jsonl`);
    const visits: Visit[] = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    summary.push({ cp, testsOk, visits });
    const bad = visits.filter((v) => !v.ok);
    console.log(`${cp}: ${visits.length} visits, ${bad.length} with problems, playwright ${testsOk ? "green" : "RED"}`);
  }

  console.log("\n==== Summary ====");
  for (const s of summary) {
    const by = new Map<string, { n: number; bad: number }>();
    for (const v of s.visits) {
      const e = by.get(v.role) ?? { n: 0, bad: 0 };
      e.n++;
      if (!v.ok) e.bad++;
      by.set(v.role, e);
    }
    console.log(`${s.cp.padEnd(18)} ${s.testsOk ? "PASS" : "FAIL"}  ${[...by].map(([r, e]) => `${r} ${e.n - e.bad}/${e.n}`).join("  ")}`);
  }
  const all = summary.flatMap((s) => s.visits).filter((v) => v.loadMs > 0).sort((a, b) => b.loadMs - a.loadMs).slice(0, 15);
  console.log("\nSlowest page loads (ms, navigation to load event / server first byte):");
  for (const v of all) console.log(`  ${String(v.loadMs).padStart(6)} / ${String(v.ttfbMs ?? "-").padStart(6)}  ${v.cp} ${v.role} ${v.name}`);
  fs.writeFileSync(path.join(RESULT_DIR, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(`\nTotal ${Math.round((Date.now() - t0) / 1000)}s. Screenshots: screenshots/sim/<checkpoint>/`);
  void SIM_DIR;
  process.exit(summary.every((s) => s.testsOk) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
