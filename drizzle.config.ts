import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });
config();

const url = process.env.DATABASE_URL;
const isPglite = !url || url.startsWith("pglite:");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  ...(isPglite
    ? { driver: "pglite", dbCredentials: { url: url?.slice("pglite:".length) || "./.pglite" } }
    : { dbCredentials: { url: url! } }),
});
