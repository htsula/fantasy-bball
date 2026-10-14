import { cn } from "cn";

/** Pulsing placeholder block for loading.tsx files. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

/** A card-ish page skeleton: title, a few stat boxes and some rows. */
export function PageSkeleton({ rows = 6, stats = 0 }: { rows?: number; stats?: number }) {
  return (
    <div className="grid gap-4" role="status" aria-label="Loading">
      <Skeleton className="h-7 w-48" />
      {stats > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: stats }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      )}
      <div className="grid gap-2 rounded-lg border p-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
      <span className="sr-only">Loading...</span>
    </div>
  );
}
