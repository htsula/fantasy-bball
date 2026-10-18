/** `npm run sim:snapshots`: (re)builds .pglite-sim/_snapshots from one simulation run. */
import { buildSnapshots } from "./build-snapshots";

buildSnapshots()
  .then((r) => {
    console.log(`done in ${Math.round(r.elapsedMs / 1000)}s`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
