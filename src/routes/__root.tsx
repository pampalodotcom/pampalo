import { type QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import * as React from "react";
import appCss from "../styles.css?url";
import { AccountModalProvider } from "@/lib/account-modal";
import { AuthProvider } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import { Toaster } from "@/components/ui/sonner";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1",
      },
      { name: "theme-color", content: "#faf6ea" },
      { title: "Pampalo · Private Money" },
      {
        name: "description",
        content:
          "Pampalo uses passkey PRF to encrypt and decrypt all application data. Any data stored in the database is encrypted with (pass)keys that you control.",
      },

      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Pampalo" },
      { property: "og:title", content: "Pampalo · Private Money" },
      {
        property: "og:description",
        content:
          "Passkey-encrypted private money. Your keys, your data — encrypted client-side, stored as ciphertext.",
      },
      { property: "og:image", content: "/og-image.png" },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content: "Pampalo — a beach scene with the Pampalo wordmark.",
      },

      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Pampalo · Private Money" },
      {
        name: "twitter:description",
        content:
          "Passkey-encrypted private money. Your keys, your data — encrypted client-side, stored as ciphertext.",
      },
      { name: "twitter:image", content: "/og-image.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      {
        rel: "icon",
        type: "image/png",
        sizes: "192x192",
        href: "/favicon-192.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "512x512",
        href: "/favicon-512.png",
      },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.json" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <ThemeProvider>
        <AuthProvider>
          <AccountModalProvider>
            <Outlet />
            <Toaster position="top-center" />
          </AccountModalProvider>
        </AuthProvider>
      </ThemeProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning className="bg-paper text-ink">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
