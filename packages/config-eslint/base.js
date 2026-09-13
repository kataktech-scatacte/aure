import js from "@eslint/js";
import turbo from "eslint-config-turbo/flat";
import tseslint from "typescript-eslint";

/** Shared flat config. Every package config starts from this. */
export const base = tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.output/**",
      "**/node_modules/**",
      "**/coverage/**",
      // Playwright output: reports bundle minified trace-viewer JS.
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.queries.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...turbo,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

export default base;
