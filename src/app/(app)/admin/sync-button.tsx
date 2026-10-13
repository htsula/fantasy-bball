"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? "Running..." : label}
    </Button>
  );
}

/** A form button that runs a server action and shows progress while it executes. */
export function SyncButton({ action, label }: { action: () => Promise<void>; label: string }) {
  return (
    <form action={action}>
      <Submit label={label} />
    </form>
  );
}
