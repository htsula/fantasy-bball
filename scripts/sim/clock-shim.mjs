/**
 * Dev/test-only server clock for the simulation browser pass (`npm run e2e:sim`). Preload it with
 * NODE_OPTIONS=--import=<file url> and set SIM_NOW to an ISO instant: `Date` / `Date.now()` then report that instant
 * "now" and keep flowing from there. It never activates without SIM_NOW, and it refuses to activate unless
 * DATABASE_URL is a pglite: URL (so it can't be pointed at a real database by accident). It is not wired into any
 * dev/build/start script.
 */
const simNow = process.env.SIM_NOW;
if (simNow) {
  if (!(process.env.DATABASE_URL ?? "").startsWith("pglite:")) {
    console.error("clock-shim: refusing to fake the clock unless DATABASE_URL is a pglite: URL");
    process.exit(1);
  }
  const target = Date.parse(simNow);
  if (Number.isNaN(target)) {
    console.error(`clock-shim: SIM_NOW is not a date: ${simNow}`);
    process.exit(1);
  }
  const Real = Date;
  const offset = target - Real.now();
  function SimDate(...args) {
    if (!new.target) return new SimDate().toString();
    return Reflect.construct(Real, args.length === 0 ? [Real.now() + offset] : args, new.target);
  }
  SimDate.prototype = Real.prototype;
  Object.setPrototypeOf(SimDate, Real);
  SimDate.now = () => Real.now() + offset;
  SimDate.parse = Real.parse;
  SimDate.UTC = Real.UTC;
  globalThis.Date = SimDate;
  console.log(`clock-shim: server clock starts at ${simNow}`);
}

// The simulated clock is only meaningful offline: make ESPN unreachable (pages that try a live refresh then take
// their normal "upstream failed" path) instead of letting a test server talk to the real API.
if (simNow) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (/espn\.com|espncdn\.com/.test(url)) return Promise.reject(new TypeError("fetch failed (ESPN blocked by the simulation clock shim)"));
    return realFetch(input, init);
  };
}
