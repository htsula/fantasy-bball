import { desc } from "drizzle-orm";
import { db } from "@/db";
import { invites, users } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/session";
import { createInviteAction, createResetAction } from "./actions";
import { LinkGenerator } from "./link-generator";

export const dynamic = "force-dynamic";

const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function AdminPage() {
  await requireAdmin();
  const [inviteRows, userRows] = await Promise.all([
    db.select().from(invites).orderBy(desc(invites.createdAt)).limit(50),
    db.select().from(users).orderBy(users.createdAt),
  ]);
  const usernameById = new Map(userRows.map((u) => [u.id, u.username]));
  const now = new Date();

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Admin</h1>

      <Card>
        <CardHeader>
          <CardTitle>Invite a friend</CardTitle>
          <CardDescription>Links are single-use and expire in 7 days.</CardDescription>
        </CardHeader>
        <CardContent>
          <LinkGenerator label="Generate invite link" generate={createInviteAction} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invites</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Expires</TableHead>
                <TableHead>Used by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inviteRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No invites yet.
                  </TableCell>
                </TableRow>
              )}
              {inviteRows.map((inv) => {
                const status = inv.usedAt ? "Used" : inv.expiresAt <= now ? "Expired" : "Pending";
                return (
                  <TableRow key={inv.id}>
                    <TableCell>{fmt(inv.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant={status === "Pending" ? "default" : "secondary"}>{status}</Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{fmt(inv.expiresAt)}</TableCell>
                    <TableCell>{inv.usedBy ? (usernameById.get(inv.usedBy) ?? "-") : "-"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Reset links expire in 24 hours and sign the user out everywhere.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {userRows.map((u) => (
            <div key={u.id} className="grid gap-2 border-b pb-4 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{u.displayName}</span>{" "}
                  <span className="text-sm text-muted-foreground">@{u.username}</span>{" "}
                  {u.isSiteAdmin && <Badge variant="outline">admin</Badge>}
                </div>
              </div>
              <LinkGenerator
                label="Generate reset link"
                size="sm"
                variant="outline"
                generate={createResetAction.bind(null, u.id)}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
