import type { RevisionFixture } from "./revision-fetch.fixture.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { formatChildDiagnostic } from "./child-diagnostics.fixture.ts";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ReviewActionV2ProductionRoutes } from "../../../apps/api/src/review-action-v2-production-composition.js";
import type { durableSnapshot } from "./investigation-control-plane-child.fixture.js";

export type FixtureConfig = Readonly<{
  revisionFixture: RevisionFixture;
  runId: string;
  databaseUrl: string;
  env: Readonly<Record<string, string | undefined>>;
}>;
export type Boot = { pid: number; nonce: string; runId: string; rss: number };
export type Snapshot = Awaited<ReturnType<typeof durableSnapshot>>;
type Investigation = ReviewActionV2ProductionRoutes["investigation"];
type Execution = ReviewActionV2ProductionRoutes["execution"];
export type Handlers = {
  open: NonNullable<Investigation["openV2"]>;
  plan: NonNullable<Investigation["planTurn"]>;
  commit: NonNullable<Investigation["commitTurn"]>;
  conclude: NonNullable<Investigation["conclude"]>;
  acquire: NonNullable<Investigation["acquireLease"]>;
  release: NonNullable<Investigation["releaseLease"]>;
  executionAcquire: NonNullable<Execution["acquireLease"]>;
  executionRelease: NonNullable<Execution["releaseLease"]>;
};
export type Operation = keyof Handlers;
export type Request<K extends Operation> = Parameters<Handlers[K]["execute"]>[0];
export type Response<K extends Operation> = Awaited<ReturnType<Handlers[K]["execute"]>>;
export type Message = { [K in Operation]: { id: string; operation: K; request: Request<K> } }[Operation]
  | { id: string; operation: "snapshot"; investigationId: string }
  | { id: string; operation: "configure"; config: FixtureConfig }
  | { id: string; operation: "shutdown" };

type Reply = { id: string; value?: unknown; error?: unknown };
const fail = (code: string) => new Error(`item11_${code}`);

// A close event (including a signal exit) is positive death evidence. Neither
// kill() success, exitCode === null, nor a request timeout grants replacement.
export class OwnedControlPlane {
  readonly child: ChildProcess;
  boot: Boot | null = null;
  private closed = false;
  private exited = false;
  private closeSignal: NodeJS.Signals | null = null;
  readonly runId: string;
  private stopping = false;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly closeObserved: Promise<void>;
  private resolveClose!: () => void;

  constructor(runId: string, spawn = () => fork(
    fileURLToPath(new URL("./investigation-control-plane-child.fixture.ts", import.meta.url)),
    [], { execArgv: ["--import", "tsx"], env: { NODE_ENV: "test", TZ: "UTC" },
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" },
  )) {
    this.runId = runId;
    this.closeObserved = new Promise((resolve) => { this.resolveClose = resolve; });
    // Persist uncertainty BEFORE spawning; only observed close clears it.
    const proofDirectory = process.env.REVIEW_ROUTER_ITEM11_CHILD_PROOF_DIR;
    const pendingPath = proofDirectory ? join(proofDirectory, randomUUID()) : null;
    if (pendingPath) writeFileSync(pendingPath, runId, { flag: "wx", mode: 0o600 });
    this.child = spawn();
    this.child.on("spawn", () => {});
    this.child.on("error", () => this.rejectPending(fail("child_error")));
    this.child.on("exit", () => { this.exited = true; this.rejectPending(fail("child_exited")); });
    this.child.on("close", (_code, signal) => {
      this.closeSignal = signal;
      this.closed = true;
      if (pendingPath) unlinkSync(pendingPath);
      this.rejectPending(fail("child_closed"));
      this.resolveClose();
    });
    this.child.on("message", (reply: Reply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(fail(formatChildDiagnostic(reply.error)));
      else pending.resolve(reply.value);
    });
  }

  async start(config: FixtureConfig): Promise<Boot> {
    if (config.runId !== this.runId || this.boot) throw fail("ownership_mismatch");
    const boot = await this.send({ operation: "configure", config }, 15_000) as Boot;
    if (boot.runId !== this.runId || boot.pid !== this.child.pid || boot.pid === process.pid || !boot.nonce) {
      throw fail("invalid_readiness");
    }
    return this.boot = boot;
  }

  invoke<K extends Operation>(operation: K, request: Request<K>): Promise<Response<K>> {
    return this.send({ operation, request }) as Promise<Response<K>>;
  }
  snapshot(investigationId: string): Promise<Snapshot> {
    return this.send({ operation: "snapshot", investigationId }) as Promise<Snapshot>;
  }
  private send(message: { operation: string; [key: string]: unknown }, timeout = 10_000): Promise<unknown> {
    if (this.closed || this.exited || this.stopping || !this.child.connected) return Promise.reject(fail("child_unavailable"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail("request_timeout")); }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      const sendFailed = () => {
        this.pending.get(id)?.reject(fail("ipc_send_failed"));
        this.pending.delete(id);
      };
      try { this.child.send({ ...message, id }, (error) => { if (error) sendFailed(); }); }
      catch { sendFailed(); }
    });
  }
  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private async waitForClose(ms: number): Promise<boolean> {
    if (this.closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.closeObserved.then(() => true), new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  async killAtCheckpoint(): Promise<void> {
    if (!this.boot || this.boot.runId !== this.runId) throw fail("ownership_unconfirmed");
    this.stopping = true;
    this.child.kill("SIGKILL");
    if (!await this.waitForClose(5_000)) throw fail(`cleanup_incomplete_run_${this.runId}_pid_${this.child.pid}`);
    if (this.closeSignal !== "SIGKILL") throw fail("checkpoint_not_sigkill");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.stopping = true;
    this.rejectPending(fail("shutdown"));
    if (this.child.connected) this.child.send({ id: randomUUID(), operation: "shutdown" }, () => {});
    if (await this.waitForClose(5_000)) return;
    // This handle was created by this instance, even if startup never became ready.
    this.child.kill("SIGKILL");
    if (!await this.waitForClose(5_000)) throw fail(`cleanup_incomplete_run_${this.runId}_pid_${this.child.pid}`);
  }
}
