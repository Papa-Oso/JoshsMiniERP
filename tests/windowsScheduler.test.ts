import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsSyncTask } from "../src/server/windowsScheduler.ts";

test("Task Scheduler preview does not execute or report an installed task", async () => {
  let executions = 0;
  const result = await createWindowsSyncTask(
    {
      install: false,
      intervalMinutes: 30,
      taskName: "JoshsMiniERP Test Preview"
    },
    {
      execute: async () => {
        executions += 1;
      }
    }
  );

  assert.equal(executions, 0);
  assert.equal(result.installed, false);
  assert.match(result.command, /^schtasks /);
});

test("Task Scheduler command failure rejects without reporting installation or exposing details", async () => {
  const sensitiveValue = "private-environment-value";
  let attemptedCommand: string | undefined;
  let result: Awaited<ReturnType<typeof createWindowsSyncTask>> | undefined;

  await assert.rejects(
    async () => {
      result = await createWindowsSyncTask(
        {
          install: true,
          intervalMinutes: 30,
          taskName: "JoshsMiniERP Test Failure"
        },
        {
          execute: async (file) => {
            attemptedCommand = file;
            throw new Error(`command failed: ${sensitiveValue}`);
          }
        }
      );
    },
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Task Scheduler installation failed/);
      assert.equal(message.includes(sensitiveValue), false);
      return true;
    }
  );

  assert.equal(attemptedCommand, "schtasks");
  assert.equal(result, undefined);
});
