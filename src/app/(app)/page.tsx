import Link from "next/link";
import { requireUser } from "@/lib/auth/session";

export default async function HomePage() {
  const user = await requireUser();
  return (
    <section className="grid gap-3">
      <h1 className="text-2xl font-bold tracking-tight">Welcome, {user.username}</h1>
      <p className="text-muted-foreground">Leagues are coming soon.</p>
      {user.isSiteAdmin && (
        <Link href="/admin" className="w-fit text-sm underline underline-offset-4">
          Go to admin
        </Link>
      )}
    </section>
  );
}
