import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export function NotFoundView({ title, message, href, label }: { title: string; message: string; href: string; label: string }) {
  return (
    <div className="mx-auto grid max-w-md gap-4 py-10 text-center" data-testid="not-found-view">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex justify-center">
        <Link href={href} className={buttonVariants({ variant: "outline" })}>
          {label}
        </Link>
      </div>
    </div>
  );
}
