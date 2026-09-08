// Dependency-free lifecycle checks: node --test this-file (Node 24).
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnedControlPlane } from "./investigation-control-plane-process.fixture.ts";

function fixture() {
  const child = new EventEmitter();
  Object.assign(child, { pid: process.pid + 100, connected: true, sent: [], signals: [],
    send(message, callback) { this.sent.push(message); callback?.(null); },
    kill(signal) { this.signals.push(signal); return true; },
  });
  const owner = new OwnedControlPlane("a".repeat(32), () => child);
  const reply = (message, value) => child.emit("message", { id: message.id, value });
  const ready = async () => {
    const start = owner.start({ runId: owner.runId, databaseUrl: "generated-fixture", env: {} });
    reply(child.sent.at(-1), { pid: child.pid, nonce: "boot-a", runId: owner.runId, rss: 1 });
    await start;
  };
  return { child, owner, ready, reply };
}

test("correlates concurrent requests even when replies arrive out of order", async () => {
  const f = fixture();
  await f.ready();
  const first = f.owner.invoke("open", {});
  const second = f.owner.invoke("plan", {});
  f.reply(f.child.sent.at(-1), "second");
  f.reply(f.child.sent.at(-2), "first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  f.child.emit("close", 0, null);
  await f.owner.close();
});

test("exit rejects every pending request; null exitCode is not close evidence", async () => {
  const f = fixture();
  await f.ready();
  const first = assert.rejects(f.owner.invoke("open", {}), /child_exited/);
  const second = assert.rejects(f.owner.snapshot("investigation"), /child_exited/);
  f.child.emit("exit", null, "SIGKILL");
  await Promise.all([first, second]);
  await assert.rejects(f.owner.invoke("open", {}), /child_unavailable/);
  let closed = false;
  const closing = f.owner.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  f.child.emit("close", null, "SIGKILL");
  await closing;
});

test("SIGKILL checkpoint does not finish until the owned handle closes", async () => {
  const f = fixture();
  await f.ready();
  let replaced = false;
  const killing = f.owner.killAtCheckpoint().then(() => { replaced = true; });
  f.child.emit("exit", null, "SIGKILL");
  await Promise.resolve();
  assert.equal(replaced, false);
  assert.deepEqual(f.child.signals, ["SIGKILL"]);
  f.child.emit("close", null, "SIGKILL");
  await killing;
  assert.equal(replaced, true);
});

test("startup errors retain the owned handle for cleanup", async () => {
  const f = fixture();
  const starting = assert.rejects(f.owner.start({ runId: f.owner.runId, databaseUrl: "fixture", env: {} }), /child_error/);
  f.child.emit("error", new Error("secret must not be exposed"));
  await starting;
  const closing = f.owner.close();
  f.child.emit("close", -2, null);
  await closing;
  assert.deepEqual(f.child.signals, []);
});

test("unknown termination fails bounded cleanup and retains ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  await f.ready();
  const killing = assert.rejects(f.owner.killAtCheckpoint(), /cleanup_incomplete_run_a+_pid_/);
  t.mock.timers.tick(5_000);
  await killing;
  assert.equal(f.owner.child, f.child);
  assert.deepEqual(f.child.signals, ["SIGKILL"]);
  f.child.emit("close", null, "SIGKILL");
  await f.owner.close();
});

test("IPC timeout is not death evidence and a late reply is ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  await f.ready();
  const timed = assert.rejects(f.owner.invoke("commit", {}), /request_timeout/);
  t.mock.timers.tick(10_000);
  await timed;
  f.reply(f.child.sent.at(-1), "late");
  assert.deepEqual(f.child.signals, []);
  f.child.emit("close", 0, null);
  await f.owner.close();
});

test("IPC failures retain safe operation and phase and redact unexpected fields", async () => {
  const f = fixture();
  await f.ready();
  const failed = assert.rejects(f.owner.invoke("commit", {}),
    /^Error: item11_investigation_idempotency_conflict operation=commit phase=execute class=Error$/);
  f.child.emit("message", { id: f.child.sent.at(-1).id, error: {
    code: "investigation_idempotency_conflict", operation: "commit", phase: "execute", errorClass: "Error",
    request: "secret", stack: "secret",
  } });
  await failed;
  const redacted = assert.rejects(f.owner.invoke("open", {}),
    /^Error: item11_child_operation_failed operation=unknown phase=unknown class=UnknownError$/);
  f.child.emit("message", { id: f.child.sent.at(-1).id, error: "secret" });
  await redacted;
  f.child.emit("close", 0, null);
  await f.owner.close();
});
