import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { childDiagnostic, formatChildDiagnostic } from "./child-diagnostics.fixture.ts";

test("diagnostics localize failures without transporting arbitrary exception text", () => {
  // Exercise credential-bearing exception text without storing credentials.
  const input = new URL("https://example.invalid/");
  input.username = randomUUID();
  input.password = randomUUID();
  const secret = input.href;
  const error = new TypeError(secret);
  assert.equal(formatChildDiagnostic(childDiagnostic(error, "commit", "execute")),
    "child_operation_failed operation=commit phase=execute class=TypeError");
  error.name = secret;
  assert.equal(formatChildDiagnostic(childDiagnostic(error, secret, "composition")),
    "child_operation_failed operation=unknown phase=composition class=UnknownError");
  assert.equal(formatChildDiagnostic({ code: secret, operation: secret, phase: secret, errorClass: secret }),
    "child_operation_failed operation=unknown phase=unknown class=UnknownError");
  assert.equal(formatChildDiagnostic(secret), formatChildDiagnostic(null));
});

test("allowlisted conflict remains recognizable and ownership failures identify phase", () => {
  assert.equal(formatChildDiagnostic(childDiagnostic(new Error("investigation_idempotency_conflict"), "commit", "execute")),
    "investigation_idempotency_conflict operation=commit phase=execute class=Error");
  assert.equal(formatChildDiagnostic(childDiagnostic(new Error("item11_database_owner_mismatch"), "configure", "ownership")),
    "item11_database_owner_mismatch operation=configure phase=ownership class=Error");
});
