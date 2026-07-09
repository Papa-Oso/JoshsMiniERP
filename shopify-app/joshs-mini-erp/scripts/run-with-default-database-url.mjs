import { spawn } from "node:child_process";

const commandArgs = process.argv.slice(2);
if (commandArgs.length === 0) {
  console.error("Usage: node scripts/run-with-default-database-url.mjs <command> [args...]");
  process.exit(1);
}

const env = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL?.trim() ||
    "postgresql://postgres:postgres@127.0.0.1:5432/joshs_mini_erp_shopify?schema=public",
};

const child =
  process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", commandArgs.map(quoteWindowsArg).join(" ")], {
        env,
        stdio: "inherit",
      })
    : spawn(commandArgs[0], commandArgs.slice(1), {
        env,
        stdio: "inherit",
      });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function quoteWindowsArg(arg) {
  if (/^[a-zA-Z0-9_/:=.,@+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["^&|<>])/g, "^$1")}"`;
}
