import { computeNextRun, runInventorySync, syncIsRunning } from "./syncEngine";
import { store } from "./store";

let timer: NodeJS.Timeout | null = null;

export async function startScheduler() {
  await refreshScheduler();
}

export async function refreshScheduler() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const data = await store.read();
  const { enabled, intervalMinutes } = data.schedule;
  const nextRunAt = computeNextRun(enabled, intervalMinutes);

  await store.mutate((draft) => {
    draft.schedule.nextRunAt = nextRunAt;
  });

  if (!enabled || !nextRunAt) return;

  const delay = Math.max(5_000, new Date(nextRunAt).getTime() - Date.now());
  timer = setTimeout(async () => {
    if (!syncIsRunning()) {
      await runInventorySync("scheduled");
    }
    await refreshScheduler();
  }, delay);
}
