import { PlayersBrowser, parsePlayerParams } from "@/components/players/players-browser";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = parsePlayerParams(await searchParams);
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Players</h1>
      <PlayersBrowser basePath="/players" params={params} isAdmin={user.isSiteAdmin} />
    </div>
  );
}
