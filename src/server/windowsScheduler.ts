import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface StartupScriptResult {
  path: string;
  installed: boolean;
  script: string;
}

export interface TaskSchedulerResult {
  taskName: string;
  intervalMinutes: number;
  installed: boolean;
  command: string;
}

export async function createWindowsStartupScript(install: boolean): Promise<StartupScriptResult> {
  const startupDirectory = windowsStartupDirectory();
  const scriptPath = path.join(startupDirectory, "JoshsMiniERP.cmd");
  const script = `@echo off\r\ncd /d "${process.cwd()}"\r\nnpm start\r\n`;

  if (install) {
    await fs.mkdir(startupDirectory, { recursive: true });
    await fs.writeFile(scriptPath, script, "utf8");
  }

  return {
    path: scriptPath,
    installed: install,
    script
  };
}

export async function createWindowsSyncTask({
  install,
  intervalMinutes,
  taskName = "JoshsMiniERP Inventory Sync"
}: {
  install: boolean;
  intervalMinutes: number;
  taskName?: string;
}): Promise<TaskSchedulerResult> {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    throw new Error("Task Scheduler interval must be between 5 and 1440 minutes.");
  }

  const action = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '${escapePowerShellSingleQuoted(
    process.cwd()
  )}'; npm run inv -- sync"`;
  const args = [
    "/Create",
    "/F",
    "/TN",
    taskName,
    "/SC",
    "MINUTE",
    "/MO",
    String(intervalMinutes),
    "/TR",
    action
  ];

  if (install) {
    await execFileAsync("schtasks", args);
  }

  return {
    taskName,
    intervalMinutes,
    installed: install,
    command: `schtasks ${args.map(quoteCommandArg).join(" ")}`
  };
}

function windowsStartupDirectory() {
  if (!process.env.APPDATA) {
    throw new Error("APPDATA is not set; this helper only works on Windows user profiles.");
  }
  return path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function escapePowerShellSingleQuoted(value: string) {
  return value.replace(/'/g, "''");
}

function quoteCommandArg(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}
