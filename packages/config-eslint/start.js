import tanstackRouter from "@tanstack/eslint-plugin-router";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

import { base } from "./base.js";

const NO_DIRECT_DB =
  "apps/web must not talk to Postgres directly. Two write paths means " +
  "authorization and validation live in two places. Use @aure/api-client.";

/** Flat config for apps/web (TanStack Start). */
export const startConfig = tseslint.config(
  ...base,
  { ignores: ["**/.output/**", "**/.tanstack/**", "**/routeTree.gen.ts"] },
  ...tanstackRouter.configs["flat/recommended"],
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // TanStack Router control flow is thrown on purpose: `throw notFound()` and
      // `throw redirect()` in loaders, beforeLoad and server functions.
      "@typescript-eslint/only-throw-error": [
        "error",
        {
          allow: [{ from: "package", package: "@tanstack/router-core", name: ["NotFoundError", "Redirect"] }],
        },
      ],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@aure/db", message: NO_DIRECT_DB },
            { name: "pg", message: NO_DIRECT_DB },
          ],
        },
      ],
    },
  },
);

export default startConfig;
