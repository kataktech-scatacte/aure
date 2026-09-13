/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "aure" },
    ],
    // Without an icon link, browsers request /favicon.ico and log a 404 on every page.
    links: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
