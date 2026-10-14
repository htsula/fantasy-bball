import Link from "next/link";
import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { BellSync } from "@/components/notifications/notification-bell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";
import { fmtEtDateTime } from "@/lib/nba/format";
import { listNotifications, unreadCount } from "@/lib/notifications/service";
import { markAllReadAction, markReadAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requireUser();
  const items = await listNotifications(db, user.id, 50);
  const unread = items.filter((n) => !n.readAt).length;
  const totalUnread = await unreadCount(db, user.id);
  return (
    <div className="grid max-w-2xl gap-4">
      <BellSync unread={totalUnread} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <div className="flex gap-2">
          <Link href="/settings/notifications" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Settings
          </Link>
          {unread > 0 && (
            <form action={markAllReadAction}>
              <Button type="submit" size="sm" data-testid="mark-all-read">
                Mark all read
              </Button>
            </form>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet. Draft alerts and league news will show up here.</p>
      ) : (
        <ul className="grid gap-2">
          {items.map((n) => (
            <li key={n.id}>
              <Card size="sm" className={n.readAt ? "opacity-70" : "border-primary/40"} data-testid="notification-item" data-unread={!n.readAt}>
                <CardContent className="flex items-start justify-between gap-3">
                  <div className="grid gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{n.title}</span>
                      {!n.readAt && <Badge>New</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{n.body}</p>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span>{fmtEtDateTime(n.createdAt)} ET</span>
                      {n.url && (
                        <Link href={n.url} className="font-medium text-foreground underline underline-offset-4">
                          Open
                        </Link>
                      )}
                    </div>
                  </div>
                  {!n.readAt && (
                    <form action={markReadAction.bind(null, n.id)}>
                      <Button type="submit" variant="ghost" size="sm">
                        Mark read
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
