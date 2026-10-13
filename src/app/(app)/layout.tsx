import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/session";

// Everything under (app) requires a signed-in user.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between gap-2 px-4">
          <Link href="/" className="font-semibold">
            Fantasy Hoops
          </Link>
          <div className="flex items-center gap-2">
            {user.isSiteAdmin && (
              <Link href="/admin" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Admin
              </Link>
            )}
            <form action={logoutAction}>
              <Button type="submit" variant="outline" size="sm">
                Log out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
