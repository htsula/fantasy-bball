/**
 * Web Push transport. Configured only when all three VAPID env vars are set; otherwise pushes are
 * skipped (in-app notifications still work). Tests inject a stub with setPushSender().
 */
import webpush from "web-push";

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
/** Resolves on success; rejects with an error carrying `statusCode` (404/410 = subscription gone). */
export type PushSender = (target: PushTarget, payload: string) => Promise<void>;

export function isPushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

let override: PushSender | null | undefined;

/** Test hook: replace the sender (pass undefined to restore the default). */
export function setPushSender(sender: PushSender | null | undefined) {
  override = sender;
}

let vapidApplied = false;

const defaultSender: PushSender = async (target, payload) => {
  if (!vapidApplied) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    vapidApplied = true;
  }
  await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
    TTL: 60 * 60,
    urgency: "high",
  });
};

/** The sender to use right now, or null when push is not configured (and no test stub is set). */
export function getPushSender(): PushSender | null {
  if (override !== undefined) return override;
  return isPushConfigured() ? defaultSender : null;
}
