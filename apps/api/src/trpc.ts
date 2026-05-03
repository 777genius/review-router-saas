import { initTRPC } from "@trpc/server";
import { getSystemHealth } from "@reviewrouter/features-system-health";
import { SystemClock } from "@reviewrouter/shared";

const t = initTRPC.create();

export const appRouter = t.router({
  health: t.procedure.query(() =>
    getSystemHealth({ clock: new SystemClock() }),
  ),
});

export type AppRouter = typeof appRouter;
