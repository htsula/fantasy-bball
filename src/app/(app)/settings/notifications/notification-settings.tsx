"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NOTIFICATION_LABELS, NOTIFICATION_TYPES, type NotificationType } from "@/lib/notifications/types";
import {
  deleteSubscriptionAction,
  saveSubscriptionAction,
  sendTestNotificationAction,
  setPrefAction,
} from "./actions";

type Prefs = Record<NotificationType, { push: boolean; inApp: boolean }>;

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Env = {
  ready: boolean;
  supported: boolean;
  iosNeedsInstall: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
};

const INITIAL_ENV: Env = { ready: false, supported: false, iosNeedsInstall: false, permission: "unsupported", subscribed: false };

async function detectEnv(): Promise<Env> {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let subscribed = false;
  if (supported) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      subscribed = Boolean(reg && (await reg.pushManager.getSubscription()));
    } catch {
      subscribed = false;
    }
  }
  return {
    ready: true,
    supported,
    iosNeedsInstall: isIos && !standalone,
    permission: "Notification" in window ? Notification.permission : "unsupported",
    subscribed,
  };
}

export function NotificationSettings({
  prefs: initialPrefs,
  deviceCount,
  vapidPublicKey,
}: {
  prefs: Prefs;
  deviceCount: number;
  vapidPublicKey: string | null;
}) {
  const [env, setEnv] = useState<Env>(INITIAL_ENV);
  const [prefs, setPrefs] = useState(initialPrefs);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    detectEnv().then(setEnv);
  }, []);

  const enable = () =>
    startTransition(async () => {
      try {
        if (!vapidPublicKey) throw new Error("not-configured");
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          toast.error("Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.");
          setEnv(await detectEnv());
          return;
        }
        const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
        await navigator.serviceWorker.ready;
        const sub =
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
        const result = await saveSubscriptionAction(sub.toJSON());
        if (!result.ok) throw new Error(result.error);
        toast.success("Notifications enabled on this device.");
      } catch (err) {
        console.error(err);
        toast.error("Couldn't enable notifications on this device.");
      }
      setEnv(await detectEnv());
    });

  const disable = () =>
    startTransition(async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub) {
          await deleteSubscriptionAction(sub.endpoint);
          await sub.unsubscribe();
        }
        toast.success("Notifications turned off on this device.");
      } catch {
        toast.error("Couldn't turn notifications off.");
      }
      setEnv(await detectEnv());
    });

  const test = () =>
    startTransition(async () => {
      const r = await sendTestNotificationAction();
      if (r.ok) toast.success("Test notification sent.");
      else toast.error(r.error);
    });

  const toggle = (type: NotificationType, channel: "push" | "inApp", value: boolean) => {
    setPrefs((p) => ({ ...p, [type]: { ...p[type], [channel]: value } }));
    startTransition(async () => {
      const r = await setPrefAction(type, channel, value);
      if (!r.ok) {
        toast.error(r.error);
        setPrefs((p) => ({ ...p, [type]: { ...p[type], [channel]: !value } }));
      }
    });
  };

  return (
    <div className="grid gap-4">
      <Card data-testid="push-device-card">
        <CardHeader>
          <CardTitle>This device</CardTitle>
          <CardDescription>
            {deviceCount > 0 ? `${deviceCount} device${deviceCount === 1 ? "" : "s"} subscribed to push on your account.` : "No devices subscribed to push yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {!env.ready ? (
            <p className="text-muted-foreground">Checking this device...</p>
          ) : env.iosNeedsInstall ? (
            <p role="note" data-testid="ios-guidance" className="rounded-md bg-muted px-3 py-2">
              On iPhone and iPad, notifications only work for apps on the Home Screen. Add to Home Screen first (Share →
              Add to Home Screen), then open the app from the icon and enable notifications.
            </p>
          ) : !env.supported ? (
            <p className="rounded-md bg-muted px-3 py-2">This browser doesn&apos;t support push notifications. The in-app bell still works.</p>
          ) : !vapidPublicKey ? (
            <p className="rounded-md bg-muted px-3 py-2" data-testid="push-not-configured">
              Push isn&apos;t configured on the server yet (the commissioner needs to set the VAPID keys). In-app
              notifications still work.
            </p>
          ) : (
            <>
              {env.permission === "denied" && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
                  Notifications are blocked for this site. Allow them in your browser or phone settings to turn them on.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {env.subscribed ? (
                  <Button variant="outline" disabled={pending} onClick={disable}>
                    Turn off on this device
                  </Button>
                ) : (
                  <Button disabled={pending || env.permission === "denied"} onClick={enable}>
                    Enable notifications on this device
                  </Button>
                )}
                <Button variant="outline" disabled={pending} onClick={test}>
                  Send test notification
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What to notify me about</CardTitle>
          <CardDescription>Push goes to your subscribed devices; in-app shows in the bell.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-4">
            {NOTIFICATION_TYPES.map((type) => (
              <li key={type} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center" data-testid={`pref-${type}`}>
                <div>
                  <div className="font-medium">{NOTIFICATION_LABELS[type].label}</div>
                  <div className="text-sm text-muted-foreground">{NOTIFICATION_LABELS[type].description}</div>
                </div>
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={prefs[type].push}
                      onChange={(e) => toggle(type, "push", e.target.checked)}
                      aria-label={`${NOTIFICATION_LABELS[type].label}: push`}
                    />
                    Push
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={prefs[type].inApp}
                      onChange={(e) => toggle(type, "inApp", e.target.checked)}
                      aria-label={`${NOTIFICATION_LABELS[type].label}: in-app`}
                    />
                    In-app
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
