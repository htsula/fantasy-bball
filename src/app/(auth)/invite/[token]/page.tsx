export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/db";
import { InvalidLink } from "@/components/invalid-link";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { getLeagueInviteInfo } from "@/lib/leagues/service";
import { InviteForm } from "./invite-form";
import { JoinLeagueForm } from "./join-league-form";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await getLeagueInviteInfo(db, token);
  if (info.status !== "valid") return <InvalidLink kind="invite" status={info.status} />;
  if (!info.league) return <InviteForm token={token} />; // site-level invite: unchanged

  if (info.league.status !== "setup") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>League closed</CardTitle>
          <CardDescription>
            This league has already started its draft. {info.league.name} is no longer accepting new teams.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const user = await getCurrentUser();
  if (user) {
    return (
      <>
        <JoinLeagueForm token={token} leagueName={info.league.name} username={user.username} />
        <Link href="/" className="text-center text-sm underline underline-offset-4">
          Cancel
        </Link>
      </>
    );
  }
  return <InviteForm token={token} leagueName={info.league.name} />;
}
