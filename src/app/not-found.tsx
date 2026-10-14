import { NotFoundView } from "@/components/not-found-view";

export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <NotFoundView title="Page not found" message="That page doesn't exist, or the link is out of date." href="/" label="Go home" />
    </main>
  );
}
