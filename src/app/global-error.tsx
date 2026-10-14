"use client";

/** Last resort: the root layout itself failed, so this renders its own <html>. Kept dependency-free. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", textAlign: "center" }}>
        <h1>Something went wrong</h1>
        <p>Try again. If it keeps happening, tell the league commissioner.</p>
        {error.digest && <p style={{ fontSize: "0.75rem", color: "#666" }}>Reference: {error.digest}</p>}
        <button onClick={() => reset()} style={{ padding: "0.6rem 1.2rem", fontSize: "1rem" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
