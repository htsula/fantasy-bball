import { db } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { countSubscriptions, getPrefs } from "@/lib/notifications/service";
import { isPushConfigured } from "@/lib/notifications/push";
import { NotificationSettings } from "./notification-settings";

export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage() {
  const user = await requireUser();
  const [prefs, devices] = await Promise.all([getPrefs(db, user.id), countSubscriptions(db, user.id)]);
  return (
    <div className="grid max-w-2xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Choose what you hear about. In-app notifications show up in the bell at the top of the page; push
          notifications reach this device even when the app is closed.
        </p>
      </div>
      <NotificationSettings
        prefs={prefs}
        deviceCount={devices}
        // Served from the server env at request time, so no NEXT_PUBLIC_ copy of the key is needed.
        vapidPublicKey={isPushConfigured() ? process.env.VAPID_PUBLIC_KEY! : null}
      />
    </div>
  );
}
