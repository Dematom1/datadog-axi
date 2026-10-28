import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortSignal: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Headers: "readonly",
      },
    },
  },
);
