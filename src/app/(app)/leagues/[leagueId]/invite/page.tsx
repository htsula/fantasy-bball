import { notFound } from "next/navigation";
import { db } from "@/db";
import { LinkGenerator } from "@/app/(app)/admin/link-generator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { listPendingLeagueInvites } from "@/lib/leagues/service";
import { fmtEtDateTime } from "@/lib/nba/format";
import { createLeagueInviteAction } from "../../actions";

export default async function LeagueInvitePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  if (!view.isCommissioner) notFound();
  const pending = await listPendingLeagueInvites(db, user, leagueId);
  const open = view.league.status === "setup";

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Invite managers</CardTitle>
          <CardDescription>
            Each link is single-use and expires in 7 days. New people create an account and their team from the link;
            existing users just pick a team name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {open ? (
            <LinkGenerator label="Create league invite link" generate={createLeagueInviteAction.bind(null, leagueId)} />
          ) : (
            <p className="text-sm text-muted-foreground">Teams can only join while the league is in setup.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending invites</CardTitle>
          <CardDescription>Links are shown only once when created, so copy them right away.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="text-muted-foreground">
                    No pending invites.
                  </TableCell>
                </TableRow>
              )}
              {pending.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{fmtEtDateTime(i.createdAt)}</TableCell>
                  <TableCell>{fmtEtDateTime(i.expiresAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
