/**
 * Creates a site-admin user, or resets an existing user's password.
 *   ADMIN_PASSWORD=... npm run create-admin -- --username alice
 *   npm run create-admin -- --username alice --reset
 * If ADMIN_PASSWORD is unset you are prompted for it (hidden, typed twice to confirm).
 * Run `npm run db:migrate` first.
 *
 * --reset: owner recovery for a forgotten password. The user must already exist (username is
 * case-insensitive). Sets the new password, signs the user out everywhere and clears any login
 * lockout. It never creates a user and never changes the site-admin flag.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { db } from "../src/db";
import { AuthError, createUser, setPasswordByUsername } from "../src/lib/auth/service";
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
    options: { username: { type: "string" }, reset: { type: "boolean", default: false } },
  });
  const username = usernameSchema.safeParse(values.username);
  if (!username.success) {
    console.error(`--username is required. ${username.error.issues[0]?.message ?? ""}`);
    process.exit(1);
  }

  let password = process.env.ADMIN_PASSWORD;
  if (password === undefined) {
    const label = values.reset ? "New password" : "Admin password";
    password = await promptHidden(`${label}: `);
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      console.error(parsed.error.issues[0]?.message);
      process.exit(1);
    }
    if ((await promptHidden("Confirm password: ")) !== password) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
  }
  const parsedPassword = passwordSchema.safeParse(password);
  if (!parsedPassword.success) {
    console.error(parsedPassword.error.issues[0]?.message);
    process.exit(1);
  }

  if (values.reset) {
    try {
      const user = await setPasswordByUsername(db, username.data, parsedPassword.data);
      console.log(`Password reset for "${user.username}" (${user.id}); all sessions revoked.`);
    } catch (err) {
      if (err instanceof AuthError && err.code === "user_not_found") {
        console.error(`No user named "${username.data}" exists. Nothing was changed.`);
        process.exit(1);
      }
      throw err;
    }
    process.exit(0);
  }

  try {
    const user = await createUser(db, {
      username: username.data,
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
