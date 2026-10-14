"use client";

import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";

/** Friendly error boundary body: what happened, a retry, and a way out. `digest` lets the owner find the log line. */
export function ErrorView({
  error,
  reset,
  homeHref = "/",
  homeLabel = "Go home",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref?: string;
  homeLabel?: string;
}) {
  return (
    <div className="mx-auto grid max-w-md gap-4 py-10 text-center" role="alert" data-testid="error-view">
      <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        That page hit an error. It&apos;s usually temporary, so try again. If it keeps happening, tell the league commissioner.
      </p>
      {error.digest && <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Link href={homeHref} className={buttonVariants({ variant: "outline" })}>
          {homeLabel}
        </Link>
      </div>
    </div>
  );
}
