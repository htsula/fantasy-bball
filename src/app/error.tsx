"use client";

import { ErrorView } from "@/components/error-view";

export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <ErrorView {...props} />
    </main>
  );
}
