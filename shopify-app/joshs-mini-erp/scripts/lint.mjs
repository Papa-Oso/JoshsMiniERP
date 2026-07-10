import { spawnSync } from "node:child_process";
import path from "node:path";

const eslintBin = path.resolve("node_modules/eslint/bin/eslint.js");
const result = spawnSync(
  process.execPath,
  [eslintBin, "--ignore-path", ".gitignore", "--cache", "--cache-location", "./node_modules/.cache/eslint", ".", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, ESLINT_USE_FLAT_CONFIG: "false" }
  }
);

process.exit(result.status ?? 1);
