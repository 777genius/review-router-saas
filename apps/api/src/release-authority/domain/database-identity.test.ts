import { describe, expect, it } from "vitest";
import {
  runtimeDatabaseIdentityEquals,
  runtimeDatabaseIdentityIsCanonical,
} from "./database-identity";

describe("runtime database identity", () => {
  const authority = {
    serverIdentity: "7538727363931298658",
    databaseIdentity: "16384",
    databaseName: "reviewrouter_authority",
  } as const;

  it("binds the database as well as the server", () => {
    expect(runtimeDatabaseIdentityIsCanonical(authority)).toBe(true);
    expect(
      runtimeDatabaseIdentityEquals(authority, {
        ...authority,
        databaseIdentity: "16385",
        databaseName: "reviewrouter_stale_clone",
      }),
    ).toBe(false);
  });

  it("fails closed for legacy, missing, or credential-shaped values", () => {
    expect(
      runtimeDatabaseIdentityIsCanonical({
        serverIdentity: "7538727363931298658",
        databaseIdentity: "",
        databaseName: "reviewrouter",
      }),
    ).toBe(false);
    expect(
      runtimeDatabaseIdentityIsCanonical({
        serverIdentity: "postgresql://user:password@host/database",
        databaseIdentity: "16384",
        databaseName: "reviewrouter",
      }),
    ).toBe(false);
  });
});
