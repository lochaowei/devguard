import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: [".scratch/**", "coverage/**", "dist/**", "node_modules/**"] },
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ["eslint.config.js"] } },
    },
    rules: {
      complexity: ["error", 10],
    },
  },
);
