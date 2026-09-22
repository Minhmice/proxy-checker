import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".next/**", "dist/**", ".superpowers/**"] },
  {
    files: ["src/auditor/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
  },
  {
    files: ["scripts/proxy-audit.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
