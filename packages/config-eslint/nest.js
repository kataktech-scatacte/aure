import tseslint from "typescript-eslint";

import { base } from "./base.js";

const DB_ONLY_IN_DATA_LAYER =
  "packages/db is the data layer. Only *.repository.ts and *.mapper.ts may import it. " +
  "Controllers and services work with @aure/contracts types.";

/** Flat config for apps/api. Enforces the DB -> mapper -> contract layering. */
export const nest = tseslint.config(
  ...base,
  {
    rules: {
      // Landmine guard: `import type` is fully erased, so emitDecoratorMetadata
      // would emit Object instead of the real class and Nest DI breaks at
      // RUNTIME with no compile error. Autofix must never introduce it here.
      "@typescript-eslint/consistent-type-imports": "off",

      // Nest modules are legitimately empty classes.
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: ["**/*.ts"],
    ignores: ["**/*.repository.ts", "**/*.mapper.ts", "**/db.module.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@aure/db", message: DB_ONLY_IN_DATA_LAYER },
            { name: "pg", message: DB_ONLY_IN_DATA_LAYER },
          ],
        },
      ],
    },
  },
);

export default nest;
