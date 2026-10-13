/**
 * Creates a site-admin user.
 *   ADMIN_PASSWORD=... npm run create-admin -- --username alice [--display-name "Alice"]
 * If ADMIN_PASSWORD is unset you are prompted for it. Run `npm run db:migrate` first.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { db } from "../src/db";
import { AuthError, createUser } from "../src/lib/auth/service";
import { passwordSchema, usernameSchema } from "../src/lib/auth/validation";

/** Prompts on stdin, hiding the typed characters. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = out._writeToOutput.bind(rl);
    process.stdout.write(question);
    out._writeToOutput = () => {}; // suppress echo
    rl.question("", (answer) => {
      out._writeToOutput = original;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: { username: { type: "string" }, "display-name": { type: "string" } },
  });
  const username = usernameSchema.safeParse(values.username);
  if (!username.success) {
    console.error(`--username is required. ${username.error.issues[0]?.message ?? ""}`);
    process.exit(1);
  }

  const password = process.env.ADMIN_PASSWORD ?? (await promptHidden("Admin password: "));
  const parsedPassword = passwordSchema.safeParse(password);
  if (!parsedPassword.success) {
    console.error(parsedPassword.error.issues[0]?.message);
    process.exit(1);
  }

  try {
    const user = await createUser(db, {
      username: username.data,
      displayName: values["display-name"] ?? username.data,
      password: parsedPassword.data,
      isSiteAdmin: true,
    });
    console.log(`Created site admin "${user.username}" (${user.id}).`);
  } catch (err) {
    if (err instanceof AuthError && err.code === "username_taken") {
      console.error(`Username "${username.data}" already exists.`);
      process.exit(1);
    }
    throw err;
  }
  process.exit(0); // closes the DB handle (PGlite / pool) too
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
