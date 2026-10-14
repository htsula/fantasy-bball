import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/session";
import { seasonYearFor } from "@/lib/nba/dates";
import { CreateLeagueForm } from "./create-league-form";

export const dynamic = "force-dynamic";

export default async function NewLeaguePage() {
  await requireAdmin();
  return (
    <div className="mx-auto grid w-full max-w-lg gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Create league</h1>
      <Card>
        <CardHeader>
          <CardTitle>New league</CardTitle>
          <CardDescription>
            You become the commissioner. Invite friends from the league page once it&apos;s created.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateLeagueForm defaultSeason={seasonYearFor(new Date())} />
        </CardContent>
      </Card>
    </div>
  );
}
