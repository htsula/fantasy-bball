import { notFound } from "next/navigation";
import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { baseUrl } from "@/lib/app-url";
import { loadLeagueView } from "@/lib/leagues/loaders";
import { listLeagueInvites, type LeagueInviteStatus } from "@/lib/leagues/service";
import { fmtEtDateTime } from "@/lib/nba/format";
import { CopyLink, CreateInviteForm, RemoveTeamButton, RevokeButton } from "./invite-controls";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<LeagueInviteStatus, string> = {
  active: "Active",
  revoked: "Revoked",
  closed: "Closed (draft started)",
  full: "Full",
  expired: "Expired",
  used: "Used",
};

export default async function LeagueInvitePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const { user, view } = await loadLeagueView(leagueId);
  if (!view.isCommissioner) notFound();
  const invites = await listLeagueInvites(db, user, leagueId);
  const open = view.league.status === "setup";
  const base = await baseUrl();
  const urlOf = (token: string) => `${base}/invite/${token}`;
  const active = invites.find((i) => i.status === "active" && i.token);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Invite managers</CardTitle>
          <CardDescription>
            Share this in your group chat — anyone with the link can join until the draft starts. New people create an
            account and their team from the link; existing users just pick a team name.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!open ? (
            <p className="text-sm text-muted-foreground">Teams can only join while the league is in setup.</p>
          ) : (
            <>
              {active?.token && (
                <div className="grid gap-1" data-testid="active-invite">
                  <CopyLink url={urlOf(active.token)} />
                  <p className="text-xs text-muted-foreground">
                    {active.maxUses === null
                      ? `${active.useCount} joined, no limit.`
                      : `${active.useCount} of ${active.maxUses} spots used.`}{" "}
                    Remove unwanted teams below before you start the draft.
                  </p>
                </div>
              )}
              <CreateInviteForm leagueId={leagueId} hasActive={invites.some((i) => i.status === "active")} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invite links</CardTitle>
          <CardDescription>Everyone who joined through each link, newest link first.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {invites.length === 0 && <p className="text-sm text-muted-foreground">No invite links yet.</p>}
          {invites.map((i) => (
            <div key={i.id} className="grid gap-2" data-testid="invite-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={i.status === "active" ? "default" : "secondary"}>{STATUS_LABEL[i.status]}</Badge>
                  <span>Created {fmtEtDateTime(i.createdAt)}</span>
                  <span className="text-muted-foreground">
                    {i.useCount} {i.useCount === 1 ? "use" : "uses"}
                    {i.maxUses !== null ? ` of ${i.maxUses}` : ""}
                  </span>
                </div>
                {i.status === "active" && <RevokeButton leagueId={leagueId} inviteId={i.id} />}
              </div>
              {i.members.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead className="hidden sm:table-cell">Joined</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {i.members.map((m) => (
                      <TableRow key={m.teamId} data-testid="invite-member">
                        <TableCell>{m.username}</TableCell>
                        <TableCell>{m.teamName}</TableCell>
                        <TableCell className="hidden sm:table-cell">{fmtEtDateTime(m.joinedAt)}</TableCell>
                        <TableCell className="text-right">
                          {open && <RemoveTeamButton leagueId={leagueId} teamId={m.teamId} teamName={m.teamName} />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
