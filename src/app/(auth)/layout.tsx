export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-center text-2xl font-bold tracking-tight">Fantasy Hoops</h1>
      {children}
    </main>
  );
}
