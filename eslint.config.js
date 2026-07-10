import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["data/**", "dist/**", "node_modules/**", "shopify-app/**", "workers/ebay-account-deletion/worker.js"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "vite.config.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["src/server/ebayReviews/**/*.ts"],
    rules: {
      "@typescript-eslint/ban-ts-comment": "off"
    }
  },
  {
    files: ["scripts/**/*.mjs", "workers/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node
    }
  }
);
