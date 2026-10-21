import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".next/**", ".next-build/**", "dist/**", ".superpowers/**"] },
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,js,mjs}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
  },
);
