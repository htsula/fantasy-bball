import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fantasy Hoops",
    short_name: "Hoops",
    description: "Private fantasy basketball for the group chat",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    categories: ["sports", "games"],
    // The manifest has a single color pair; the <meta name="theme-color"> tags in layout.tsx cover dark mode.
    background_color: "#ffffff",
    theme_color: "#ea580c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
