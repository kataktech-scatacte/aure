import tseslint from "typescript-eslint";

import { base } from "./base.js";

/** Flat config for source-consumed React packages (packages/ui). */
export const reactLibrary = tseslint.config(...base);

export default reactLibrary;
