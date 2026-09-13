import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage(): ReactNode {
  return (
    <main>
      <h1>aure</h1>
    </main>
  );
}
