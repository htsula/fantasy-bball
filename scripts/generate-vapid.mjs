/**
 * Prints a fresh VAPID key pair to the console (never to a file). Run: npm run vapid:generate
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`
New VAPID key pair (keep the private key secret; do not commit it):

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=mailto:you@example.com

Next steps:
  1. Vercel: Project > Settings > Environment Variables. Add all three for Production (and Preview if you
     want push there), then redeploy. Use a real contact address for VAPID_SUBJECT (mailto: or https: URL).
  2. Local: paste the same three lines into .env.local (it is git-ignored).
  3. Keep using the same pair: changing it invalidates every existing push subscription.
`);
