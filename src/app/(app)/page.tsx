import Link from "next/link";
import { db } from "@/db";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { LEAGUE_STATUS_LABEL } from "@/lib/leagues/labels";
import { listLeagues } from "@/lib/leagues/service";
import { seasonLabel } from "@/lib/nba/format";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser();
  const { mine } = await listLeagues(db, user);
  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Welcome, {user.username}</h1>
      <div className="grid gap-2">
        <h2 className="text-lg font-semibold">My leagues</h2>
        {mine.length === 0 ? (
          <p className="text-muted-foreground">
            {user.isSiteAdmin
              ? "You're not in any leagues yet. Create one, then share its invite link with your friends."
              : "You're not in any leagues yet. Ask your commissioner for an invite link and open it on this device to join."}
          </p>
        ) : (
          <ul className="grid gap-2">
            {mine.map(({ league, myTeamName }) => (
              <li key={league.id}>
                <Link href={`/leagues/${league.id}`} className="underline underline-offset-4">
                  {league.name}
                </Link>{" "}
                <span className="text-sm text-muted-foreground">
                  {seasonLabel(league.season)} &middot; {myTeamName} &middot; {LEAGUE_STATUS_LABEL[league.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/leagues" className={buttonVariants({ variant: "outline", size: "sm" })}>
          All leagues
        </Link>
        {user.isSiteAdmin && (
          <>
            <Link href="/leagues/new" className={buttonVariants({ size: "sm" })}>
              Create league
            </Link>
            <Link href="/admin" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Go to admin
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
