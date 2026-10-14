import Link from "next/link";
import { db } from "@/db";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { Button, buttonVariants } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/session";
import { unreadCount } from "@/lib/notifications/service";

// Everything under (app) requires a signed-in user.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const unread = await unreadCount(db, user.id);
  const nav = buttonVariants({ variant: "ghost", size: "sm" });
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <Link href="/" className="mr-2 font-semibold">
              Fantasy Hoops
            </Link>
            <Link href="/leagues" className={nav}>
              Leagues
            </Link>
            <Link href="/players" className={nav}>
              Players
            </Link>
            <Link href="/nba/scoreboard" className={nav}>
              NBA Scoreboard
            </Link>
            {user.isSiteAdmin && (
              <Link href="/admin" className={nav}>
                Admin
              </Link>
            )}
          </div>
          <div className="flex items-center gap-1">
            <NotificationBell initialCount={unread} />
            <form action={logoutAction}>
              <Button type="submit" variant="outline" size="sm">
                Log out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
