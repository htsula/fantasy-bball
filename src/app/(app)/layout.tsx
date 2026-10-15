import Link from "next/link";
import { db } from "@/db";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { LeagueAwareHeader } from "@/components/nav/league-aware-header";
import { ThemePicker } from "@/components/nav/theme-picker";
import { ScrollNav, type NavItem } from "@/components/nav/scroll-nav";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/session";
import { unreadCount } from "@/lib/notifications/service";

// Everything under (app) requires a signed-in user.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const unread = await unreadCount(db, user.id);
  const items: NavItem[] = [
    { href: "/leagues", label: "Leagues" },
    { href: "/players", label: "Players" },
    { href: "/nba/scoreboard", label: "NBA Scoreboard" },
    ...(user.isSiteAdmin ? [{ href: "/admin", label: "Admin" }] : []),
  ];
  return (
    <div className="flex min-h-dvh flex-col">
      <LeagueAwareHeader>
        <header className="border-b">
          <div className="mx-auto grid w-full max-w-6xl gap-1 px-4 py-2">
            <div className="flex items-center justify-between gap-2">
              <Link href="/" className="inline-flex min-h-10 items-center font-semibold">
                Fantasy Hoops
              </Link>
              <div className="flex items-center gap-1">
                <NotificationBell initialCount={unread} />
                <ThemePicker />
                <form action={logoutAction}>
                  <Button type="submit" variant="outline" size="sm">
                    Log out
                  </Button>
                </form>
              </div>
            </div>
            <ScrollNav label="Main" items={items} />
          </div>
        </header>
      </LeagueAwareHeader>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
