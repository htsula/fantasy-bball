import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { DEFAULT_THEME, THEME_CLASS_VALUES, THEME_IDS } from "@/lib/themes";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fantasy Hoops",
  description: "Private fantasy basketball for the group chat",
  appleWebApp: { capable: true, title: "Fantasy Hoops", statusBarStyle: "default" },
  applicationName: "Fantasy Hoops",
  formatDetection: { telephone: false },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // lets the installed app use the safe-area insets (see globals.css)
  themeColor: "#00643a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-dvh bg-background font-sans text-foreground antialiased`}
      >
        {/* Selectable color themes (see src/lib/themes.ts + globals.css). Dark themes also get the `dark` class for shadcn `dark:` variants; the OS preference is ignored. */}
        <ThemeProvider attribute="class" themes={THEME_IDS} value={THEME_CLASS_VALUES} defaultTheme={DEFAULT_THEME} enableSystem={false}>
          {children}
          <Toaster richColors position="top-center" />
          <ServiceWorkerRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
