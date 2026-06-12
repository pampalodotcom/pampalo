import { createElement, Fragment } from "react";
import { defineConfig } from "vocs";

export default defineConfig({
  rootDir: ".",
  title: "Pampalo Docs",
  description: "Documentation for Pampalo - Private Money",
  logoUrl: "/pampalo-circular.svg",
  iconUrl: "/pampalo-circular.svg",
  sidebar: [
    { text: "Introduction", link: "/" },
    { text: "Account", link: "/account" },
    { text: "Private Money", link: "/private-money" },
    { text: "How It Works", link: "/how-it-works" },
    {
      text: "Building on Pampalo",
      collapsed: false,
      items: [
        { text: "Overview", link: "/building" },
        { text: "SDK", link: "/building/sdk" },
        { text: "CLI", link: "/building/cli" },
        { text: "Contracts", link: "/building/contracts" },
      ],
    },
    { text: "Compliance", link: "/compliance" },
    { text: "Pampalo the Company", link: "/pampalo-company" },
  ],
  font: {
    default: { google: "Inter" },
    mono: { google: "JetBrains Mono" },
  },
  theme: {
    accentColor: { light: "#e8553a", dark: "#ff7c4d" },
    variables: {
      color: {
        background: { light: "#faf6ea", dark: "#0b1a2a" },
        backgroundDark: { light: "#f1ebda", dark: "#122438" },
        text: { light: "#0c2236", dark: "#f1eee3" },
        text2: { light: "rgba(12,34,54,0.72)", dark: "rgba(241,238,227,0.78)" },
        textAccent: { light: "#e8553a", dark: "#ff7c4d" },
        heading: { light: "#0c2236", dark: "#f1eee3" },
        border: { light: "rgba(12,34,54,0.1)", dark: "rgba(241,238,227,0.12)" },
        codeBlockBackground: { light: "#fffbf0", dark: "rgba(18,36,56,0.96)" },
        codeInlineBackground: { light: "#f1ebda", dark: "#122438" },
      },
    },
  },
  // Layered on top of the `font` config above so headings pick up Fraunces,
  // matching the display type on pampalo.com. createElement is used because
  // vocs loads the config via esbuild without a JSX transform.
  head: createElement(
    Fragment,
    null,
    createElement("link", {
      rel: "preconnect",
      href: "https://fonts.googleapis.com",
    }),
    createElement("link", {
      rel: "preconnect",
      href: "https://fonts.gstatic.com",
      crossOrigin: "",
    }),
    createElement("link", {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&display=swap",
    }),
    createElement(
      "style",
      null,
      `.vocs_H1, .vocs_H2, .vocs_H3, .vocs_H4, .vocs_DocsTitle {
         font-family: 'Fraunces', Georgia, serif;
         letter-spacing: -0.01em;
       }
       /* Vocs's NavLogo renders either the logo OR the title text, not both.
          Inject the brand wordmark beside the logo image via ::after on the
          enclosing link, which is a flex container. */
       .vocs_Sidebar_logo a::after,
       .vocs_DesktopTopNav_logo a::after,
       .vocs_MobileTopNav_logo a::after {
         content: 'Pampalo';
         font-family: 'Fraunces', Georgia, serif;
         font-weight: 700;
         font-size: 1.125rem;
         letter-spacing: -0.02em;
         color: var(--vocs-color-heading);
         margin-left: 0.625rem;
       }`,
    ),
  ),
});
