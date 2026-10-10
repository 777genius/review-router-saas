import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeJwt, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { AuthenticatedEfExecution } from "@reviewrouter/features-sdk-growth-authority";
import { SdkGrowthVerifierAuthorityPolicy } from "@reviewrouter/features-sdk-growth-authority";
import { PrismaSdkGrowthVerifierEvidenceCustody } from "./sdk-growth-verifier-custody.js";
import {
  JoseSdkGrowthVerifierProducerAuthenticator,
  PrismaSdkGrowthVerifierAssignmentStore,
  SdkGrowthVerifierCredentialIssuer,
} from "./sdk-growth-verifier-producer-identity.js";

const execution: AuthenticatedEfExecution = {
  tenantId: "disposable-tenant",
  repositoryId: "disposable-repo",
  pullRequest: 17,
  githubRepositoryId: "100",
  installationId: "200",
  subject: "runner",
  runId: "300",
  runAttempt: "1",
  verifierRevision: "1".repeat(40),
  sourceCommit: "2".repeat(40),
  sourceTree: "3".repeat(40),
};
const sourceBinding = {
  headRepositoryId: "100",
  baseRepositoryId: "100",
  baseRef: "main",
  baseCommit: "4".repeat(40),
  baseTree: "5".repeat(40),
  mergeBaseCommit: "4".repeat(40),
  mergeBaseTree: "5".repeat(40),
};

type AssignmentRow = {
  assignmentId: string;
  jobKey?: string;
  execution: AuthenticatedEfExecution;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  efToolArtifactId?: string | null;
};
type FakeTransaction = {
  $queryRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]>;
  $executeRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
};

function fixture() {
  const rows = new Map<string, AssignmentRow>();
  const writes: string[] = [];
  const statements: string[] = [];
  const db = {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = strings.join("?");
      if (sql.includes("pg_advisory_xact_lock")) {
        statements.push("scope-lock");
        return [];
      }
      if (sql.includes('INSERT INTO "SdkGrowthVerifierAssignment"')) {
        statements.push("insert");
        const row: AssignmentRow = {
          assignmentId: values[0] as string,
          jobKey: values[1] as string,
          execution: JSON.parse(values[2] as string),
          createdAt: values[3] as Date,
          expiresAt: values[4] as Date,
          revokedAt: null,
          ...(values[5] === undefined
            ? {}
            : { efToolArtifactId: values[5] as string }),
        };
        rows.set(row.assignmentId, row);
        return [structuredClone(row)];
      }
      if (sql.includes("sdk_growth_verifier_assignment_lock")) {
        statements.push("assignment-lock");
        const row = rows.get(values[0] as string);
        return row ? [structuredClone(row)] : [];
      }
      if (sql.includes('FROM "SdkGrowthVerifierAssignment"')) {
        const row = rows.get(values[0] as string);
        return row ? [structuredClone(row)] : [];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = strings.join("?");
      if (sql.includes('UPDATE "SdkGrowthVerifierAssignment"')) {
        if (sql.includes('"jobKey"')) {
          statements.push("replace");
          let count = 0;
          for (const row of rows.values()) {
            if (row.jobKey === values[0] && !row.revokedAt) {
              row.revokedAt = new Date();
              count++;
            }
          }
          return count;
        }
        const row = rows.get(values[0] as string);
        if (!row || row.revokedAt) return 0;
        row.revokedAt = new Date();
        return 1;
      }
      writes.push(sql);
      throw new Error(`unexpected write: ${sql}`);
    },
    async $transaction<T>(operation: (tx: FakeTransaction) => Promise<T>) {
      return operation(db);
    },
  };
  const keys = generateKeyPairSync("ed25519");
  const store = new PrismaSdkGrowthVerifierAssignmentStore(db);
  let current: Date | null = null;
  const now = () => current ?? new Date();
  const issuer = new SdkGrowthVerifierCredentialIssuer(
    store,
    keys.privateKey,
    now,
  );
  const authenticator = new JoseSdkGrowthVerifierProducerAuthenticator(
    store,
    keys.publicKey,
    now,
  );
  return {
    db,
    rows,
    writes,
    statements,
    store,
    issuer,
    authenticator,
    keys,
    setNow(value: Date) {
      current = value;
    },
  };
}

describe("protected SDK verifier producer identity", () => {
  // Regression: a legacy execution-only token must not authenticate an
  // assignment that has a different immutable EF tool artifact pin.
  it("binds v3 credentials to the scheduler-owned tool artifact", async () => {
    const h = fixture();
    const artifactId = "a".repeat(64);
    const row = await h.store.createPinned(
      { ...execution, sourceBinding },
      new Date(Date.now() + 15 * 60_000),
      artifactId,
    );
    const token = await h.issuer.issue(row.assignmentId);
    expect(decodeJwt(token)).toMatchObject({
      assignmentId: row.assignmentId,
      assignmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(decodeJwt(token)).not.toHaveProperty("executionDigest");
    expect(await h.authenticator.authenticate(token)).toMatchObject({
      execution: { ...execution, sourceBinding },
      efToolArtifactId: artifactId,
    });
    h.rows.get(row.assignmentId)!.efToolArtifactId = "b".repeat(64);
    await expect(h.authenticator.authenticate(token)).rejects.toThrow(
      "sdk_growth_verifier_credential_rejected",
    );
  });

  // Regression: adding v2 source data could change the digest or JSON bytes
  // used by already issued v1 credentials and historical assignments.
  it("preserves the historical 11-field execution and credential digest", async () => {
    const h = fixture();
    const row = await h.store.create(
      execution,
      new Date(Date.now() + 15 * 60_000),
    );
    const token = await h.issuer.issue(row.assignmentId);
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          execution.tenantId,
          execution.repositoryId,
          execution.pullRequest,
          execution.githubRepositoryId,
          execution.installationId,
          execution.subject,
          execution.runId,
          execution.runAttempt,
          execution.verifierRevision,
          execution.sourceCommit,
          execution.sourceTree,
        ]),
      )
      .digest("hex");
    expect(decodeJwt(token).executionDigest).toBe(expected);
    expect(h.rows.get(row.assignmentId)?.execution).toEqual(execution);
    expect((await h.authenticator.authenticate(token)).execution).toEqual(
      execution,
    );
  });

  // Regression: v1's exact 11-key parser would drop or reject captured PR
  // base identity, leaving a verifier assignment tied only to the head SHA.
  it("persists v2 source binding and authenticates its exact protected assignment", async () => {
    const h = fixture();
    const bound = { ...execution, sourceBinding };
    const row = await h.store.create(bound, new Date(Date.now() + 15 * 60_000));
    expect(h.rows.get(row.assignmentId)?.execution).toEqual({
      ...bound,
      version: 2,
    });
    expect((await h.store.load(row.assignmentId))?.execution).toEqual(bound);
    const token = await h.issuer.issue(row.assignmentId);
    expect((await h.authenticator.authenticate(token, h.db)).execution).toEqual(
      bound,
    );
    expect(decodeJwt(token).executionDigest).not.toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            execution.tenantId,
            execution.repositoryId,
            execution.pullRequest,
            execution.githubRepositoryId,
            execution.installationId,
            execution.subject,
            execution.runId,
            execution.runAttempt,
            execution.verifierRevision,
            execution.sourceCommit,
            execution.sourceTree,
          ]),
        )
        .digest("hex"),
    );
  });

  // Regression: a changed base ref or tree with the same head could reuse a
  // previous credential unless the full v2 capture enters its digest.
  it.each([
    "baseRef",
    "baseCommit",
    "baseTree",
    "mergeBaseCommit",
    "mergeBaseTree",
  ] as const)(
    "rejects tampered persisted v2 %s under an issued credential",
    async (field) => {
      const h = fixture();
      const row = await h.store.create(
        { ...execution, sourceBinding },
        new Date(Date.now() + 15 * 60_000),
      );
      const token = await h.issuer.issue(row.assignmentId);
      h.rows.set(row.assignmentId, {
        ...h.rows.get(row.assignmentId)!,
        execution: {
          ...execution,
          version: 2,
          sourceBinding: {
            ...sourceBinding,
            [field]: field === "baseRef" ? "release" : "a".repeat(40),
          },
        } as AuthenticatedEfExecution,
      });
      await expect(h.authenticator.authenticate(token)).rejects.toThrow(
        "credential_rejected",
      );
    },
  );

  // Regression: an incomplete or extended v2 record could pass through a
  // loose JSON parser and silently lose source authority fields.
  it.each([
    { sourceBinding: { ...sourceBinding, baseTree: undefined } },
    { sourceBinding: { ...sourceBinding, unexpected: "field" } },
    { sourceBinding: { ...sourceBinding, baseRepositoryId: "999" } },
    { sourceBinding: { ...sourceBinding, baseRef: "../main" } },
  ])(
    "rejects malformed source binding before assignment write %#",
    async (change) => {
      const h = fixture();
      await expect(
        h.store.create(
          { ...execution, ...change } as AuthenticatedEfExecution,
          new Date(Date.now() + 15 * 60_000),
        ),
      ).rejects.toThrow("credential_rejected");
      expect(h.rows.size).toBe(0);
    },
  );

  it.each([{ version: 1 }, { version: 3 }, { version: 2, unexpected: true }])(
    "rejects malformed persisted v2 envelope %#",
    async (change) => {
      const h = fixture();
      const row = await h.store.create(
        { ...execution, sourceBinding },
        new Date(Date.now() + 15 * 60_000),
      );
      h.rows.set(row.assignmentId, {
        ...h.rows.get(row.assignmentId)!,
        execution: {
          ...execution,
          sourceBinding,
          ...change,
        } as AuthenticatedEfExecution,
      });
      await expect(h.store.load(row.assignmentId)).rejects.toThrow(
        "credential_rejected",
      );
    },
  );

  // Regression: a new PR base under the same scope must revoke the previous
  // assignment even when run, attempt and head remain unchanged.
  it("revokes old v2 credential when the captured base changes", async () => {
    const h = fixture();
    const first = await h.store.create(
      { ...execution, sourceBinding },
      new Date(Date.now() + 15 * 60_000),
    );
    const oldCredential = await h.issuer.issue(first.assignmentId);
    const replacement = await h.store.create(
      { ...execution, sourceBinding: { ...sourceBinding, baseRef: "release" } },
      new Date(Date.now() + 15 * 60_000),
    );
    expect(h.rows.get(first.assignmentId)?.revokedAt).toBeInstanceOf(Date);
    await expect(h.authenticator.authenticate(oldCredential)).rejects.toThrow(
      "credential_rejected",
    );
    expect(
      (
        await h.authenticator.authenticate(
          await h.issuer.issue(replacement.assignmentId),
        )
      ).execution.sourceBinding?.baseRef,
    ).toBe("release");
  });

  it("locks the empty PR scope before replacement and locks assignment through the custody transaction", async () => {
    const h = fixture();
    const first = await h.store.create(
      execution,
      new Date(Date.now() + 15 * 60_000),
    );
    expect(h.statements.slice(0, 3)).toEqual([
      "scope-lock",
      "replace",
      "insert",
    ]);
    const token = await h.issuer.issue(first.assignmentId);
    expect(h.statements).not.toContain("assignment-lock");
    await h.authenticator.authenticate(token, h.db);
    expect(h.statements).toContain("assignment-lock");
  });

  it("serializes two replacements when their PR scope initially has no row", async () => {
    const rows: AssignmentRow[] = [];
    let predecessor = Promise.resolve();
    const db = {
      async $transaction<T>(operation: (tx: FakeTransaction) => Promise<T>) {
        let release: (() => void) | undefined;
        const tx: FakeTransaction = {
          async $queryRaw(strings, ...values) {
            const sql = strings.join("?");
            if (sql.includes("pg_advisory_xact_lock")) {
              const previous = predecessor;
              predecessor = new Promise<void>((resolve) => {
                release = resolve;
              });
              await previous;
              return [];
            }
            if (!sql.includes('INSERT INTO "SdkGrowthVerifierAssignment"'))
              throw new Error(`unexpected query: ${sql}`);
            const scope = values[1] as string;
            if (rows.some((row) => row.jobKey === scope && !row.revokedAt))
              throw new Error("active_job_key_unique_violation");
            const row: AssignmentRow = {
              assignmentId: values[0] as string,
              jobKey: scope,
              execution: JSON.parse(values[2] as string),
              createdAt: values[3] as Date,
              expiresAt: values[4] as Date,
              revokedAt: null,
            };
            rows.push(row);
            return [row];
          },
          async $executeRaw(_strings, ...values) {
            let count = 0;
            for (const row of rows) {
              if (row.jobKey === values[0] && !row.revokedAt) {
                row.revokedAt = new Date();
                count++;
              }
            }
            return count;
          },
        };
        try {
          return await operation(tx);
        } finally {
          release?.();
        }
      },
      async $queryRaw() {
        return [];
      },
      async $executeRaw() {
        return 0;
      },
    };
    const store = new PrismaSdkGrowthVerifierAssignmentStore(db);
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const [first, second] = await Promise.all([
      store.create(execution, expiresAt),
      store.create({ ...execution, runAttempt: "2" }, expiresAt),
    ]);
    expect(first.jobKey).toBe(second.jobKey);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => !row.revokedAt)).toHaveLength(1);
  });

  it("rejects a JWT that expires while the assignment row lock waits", async () => {
    const h = fixture();
    const row = await h.store.create(
      execution,
      new Date(Date.now() + 15 * 60_000),
    );
    const initial = row.createdAt.getTime();
    h.setNow(new Date(initial));
    const token = await h.issuer.issue(row.assignmentId);
    const originalQuery = h.db.$queryRaw.bind(h.db);
    h.db.$queryRaw = async (strings, ...values) => {
      const result = await originalQuery(strings, ...values);
      if (strings.join("?").includes("sdk_growth_verifier_assignment_lock"))
        h.setNow(new Date(row.createdAt.getTime() + 6 * 60_000));
      return result;
    };
    await expect(h.authenticator.authenticate(token, h.db)).rejects.toThrow(
      "credential_rejected",
    );
  });

  it("keeps assignment locking restricted to a fixed-path definer function", () => {
    const migration = readFileSync(
      new URL(
        "../../../packages/platform/db/prisma/migrations/000109_sdk_growth_verifier_assignment_lock/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toMatch(
      /SECURITY DEFINER\s+SET search_path = pg_catalog/,
    );
    expect(migration).toContain('FROM public."SdkGrowthVerifierAssignment"');
    expect(migration).toContain("FOR SHARE OF assignment");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.sdk_growth_verifier_assignment_lock(text) FROM PUBLIC",
    );
    expect(migration).not.toMatch(/GRANT\s+UPDATE/i);
  });

  it("derives the exact execution from the persisted assignment and controls same-token retries", async () => {
    const h = fixture();
    const row = await h.store.create(
      execution,
      new Date(Date.now() + 15 * 60_000),
    );
    const token = await h.issuer.issue(row.assignmentId);
    const first = await h.authenticator.authenticate(token);
    const retry = await h.authenticator.authenticate(token);
    expect(first.execution).toEqual(execution);
    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      producer: "reviewrouter-verifier",
      issuer: "reviewrouter-sdk-verifier-workload",
      subject: "reviewrouter-verifier",
    });
    expect(h.rows.get(row.assignmentId)?.execution).toEqual(execution);
  });

  it.each([
    ["tenantId", "other-tenant"],
    ["repositoryId", "other-repo"],
    ["pullRequest", 18],
    ["githubRepositoryId", "101"],
    ["installationId", "201"],
    ["subject", "other-runner"],
    ["runId", "301"],
    ["runAttempt", "2"],
    ["verifierRevision", "4".repeat(40)],
    ["sourceCommit", "5".repeat(40)],
    ["sourceTree", "6".repeat(40)],
  ] as const)("rejects changed persisted %s", async (field, value) => {
    const h = fixture();
    const row = await h.store.create(
      execution,
      new Date(Date.now() + 15 * 60_000),
    );
    const token = await h.issuer.issue(row.assignmentId);
    h.rows.set(row.assignmentId, {
      ...row,
      execution: { ...execution, [field]: value },
    });
    await expect(h.authenticator.authenticate(token)).rejects.toThrow(
      "credential_rejected",
    );
  });

  it("rejects revocation, assignment expiry, credential expiry, and missing assignment", async () => {
    const h = fixture();
    const row = await h.store.create(
      execution,
      new Date(Date.now() + 15 * 60_000),
    );
    const token = await h.issuer.issue(row.assignmentId);
    h.rows.delete(row.assignmentId);
    await expect(h.authenticator.authenticate(token)).rejects.toThrow(
      "credential_rejected",
    );
    h.rows.set(row.assignmentId, row);
    await h.store.revoke(row.assignmentId);
    await expect(h.authenticator.authenticate(token)).rejects.toThrow(
      "credential_rejected",
    );
    h.rows.set(row.assignmentId, {
      ...row,
      expiresAt: new Date(Date.now() - 1),
    });
    await expect(h.authenticator.authenticate(token)).rejects.toThrow(
      "credential_rejected",
    );
    h.rows.set(row.assignmentId, row);
    h.setNow(new Date(Date.now() + 6 * 60_000));
    await expect(h.authenticator.authenticate(token)).rejects.toThrow(
      "credential_rejected",
    );
  });

  it("supersedes a stale assignment for the same protected run and attempt", async () => {
    const h = fixture();
    const first = await h.store.create(
      execution,
      new Date(Date.now() + 15 * 60_000),
    );
    const oldToken = await h.issuer.issue(first.assignmentId);
    const replacementExecution = {
      ...execution,
      runAttempt: "2",
      sourceTree: "9".repeat(40),
    };
    const replacement = await h.store.create(
      replacementExecution,
      new Date(Date.now() + 15 * 60_000),
    );
    expect(h.rows.get(first.assignmentId)?.revokedAt).toBeInstanceOf(Date);
    await expect(h.authenticator.authenticate(oldToken)).rejects.toThrow(
      "credential_rejected",
    );
    const newToken = await h.issuer.issue(replacement.assignmentId);
    expect((await h.authenticator.authenticate(newToken)).execution).toEqual(
      replacementExecution,
    );
  });

  it("rejects malformed, cross-scope and candidate OIDC credentials before custody writes", async () => {
    const h = fixture();
    const row = await h.store.create(
      execution,
      new Date(Date.now() + 15 * 60_000),
    );
    const valid = await h.issuer.issue(row.assignmentId);
    const payload = decodeJwt(valid);
    const wrongIssuer = await new SignJWT({ ...payload, iss: "wrong-issuer" })
      .setProtectedHeader({ alg: "EdDSA", typ: "rr-sdk-verifier+jwt" })
      .sign(h.keys.privateKey);
    const wrongAudience = await new SignJWT({
      ...payload,
      aud: "wrong-audience",
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "rr-sdk-verifier+jwt" })
      .sign(h.keys.privateKey);
    const candidateKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const candidate = await new SignJWT({ assignmentId: row.assignmentId })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience("reviewrouter")
      .setExpirationTime("5m")
      .sign(candidateKey.privateKey);
    const writer = new PrismaSdkGrowthVerifierEvidenceCustody(
      h.db as never,
      h.authenticator,
      new SdkGrowthVerifierAuthorityPolicy(),
    );
    const input = {
      expectedAuthorityEpoch: 1,
      candidateArchive: Buffer.from("candidate"),
      releasedArchive: Buffer.from("released"),
      toolArchive: Buffer.from("tool"),
      installedDistributionWire: Buffer.from("distribution"),
    };
    const tampered =
      valid.slice(0, valid.lastIndexOf(".") + 1) +
      (valid[valid.lastIndexOf(".") + 1] === "a" ? "b" : "a") +
      valid.slice(valid.lastIndexOf(".") + 2);
    for (const credential of [
      "bad",
      candidate,
      tampered,
      wrongIssuer,
      wrongAudience,
    ]) {
      await expect(writer.retainEvidence(credential, input)).rejects.toThrow(
        "credential_rejected",
      );
      await expect(
        writer.retainFinalizedReport(credential, {
          expectedAuthorityEpoch: 1,
          requestDigest: `sha256:${"a".repeat(64)}`,
          grantDigest: `sha256:${"b".repeat(64)}`,
          finalizedReport: Buffer.from("report"),
          decision: {
            outcome: "passed",
            coverage: "complete",
            coveredScopes: ["public-api"],
            phases: ["authority"],
          },
        }),
      ).rejects.toThrow("credential_rejected");
    }
    // A valid credential for another protected assignment resolves that exact
    // assignment, never a caller supplied execution.
    const other = await h.store.create(
      { ...execution, tenantId: "other-tenant" },
      new Date(Date.now() + 15 * 60_000),
    );
    const otherToken = await h.issuer.issue(other.assignmentId);
    expect(
      (await h.authenticator.authenticate(otherToken)).execution.tenantId,
    ).toBe("other-tenant");
    expect(h.writes).toEqual([]);
  });
});
