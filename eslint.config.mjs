import tseslint from "typescript-eslint";

// A flat config that is only `{ ignores }` matches **/*.{js,mjs,cjs} and
// configures no rules, so `eslint .` linted this file alone and could not
// fail. Everything in this repository is TypeScript, so the gate has to be
// declared over **/*.ts explicitly.
export default tseslint.config(
  { ignores: [".next/", "node_modules/", "next-env.d.ts"] },
  {
    files: ["**/*.ts", "**/*.mts", "**/*.tsx"],
    extends: [tseslint.configs.recommended],
  },
);
