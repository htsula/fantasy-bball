"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LinkState } from "./actions";

/** Button that calls a server action returning a one-time link, then shows it with a copy button. */
export function LinkGenerator({
  label,
  generate,
  size = "default",
  variant = "default",
}: {
  label: string;
  generate: () => Promise<LinkState>;
  size?: "default" | "sm";
  variant?: "default" | "outline";
}) {
  const [state, setState] = useState<LinkState>({});
  const [pending, startTransition] = useTransition();

  async function copy(url: string) {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied");
  }

  return (
    <div className="grid gap-2">
      <Button
        type="button"
        size={size}
        variant={variant}
        disabled={pending}
        onClick={() => startTransition(async () => setState(await generate()))}
      >
        {pending ? "Generating..." : label}
      </Button>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state.url && (
        <div className="grid gap-1">
          <div className="flex gap-2">
            <Input readOnly value={state.url} aria-label="Generated link" onFocus={(e) => e.target.select()} />
            <Button type="button" variant="outline" onClick={() => copy(state.url!)}>
              Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {state.expiresAt
              ? `Single-use. Expires ${new Date(state.expiresAt).toLocaleString()}. Shown only once.`
              : "Reusable link."}
          </p>
        </div>
      )}
    </div>
  );
}
