import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEmptyApplicableRenderDefaultAcl,
  assertRenderSchemaHandoffCatalog,
  assertRenderSchemaHandoffLedger,
  partitionRenderSchemaHandoffCheckout,
  readRenderManagedCheckoutInventory,
  readRenderSchemaHandoffCatalog,
  renderSchemaHandoffCheckoutExtension,
  renderSchemaHandoffMigrationContract as contract,
} from "./render-schema-handoff-policy.mjs";

import { canonicalPrismaMigrationNames as currentCanonicalPrismaMigrationNames } from "./canonical-prisma-migration-catalog.mjs";

// Existing immutable-history cases retain their exact source through 000124.
// Current checkout additions are exercised separately against real SQL.
const providerKeyMigrationName = "000110_provider_api_key_workspace_management";
const reconnectMigrationName = "000125_hosted_codex_device_reconnect";
const canonicalPrismaMigrationNames =
  currentCanonicalPrismaMigrationNames.filter(
    (name) =>
      name !== providerKeyMigrationName && name !== reconnectMigrationName,
  );

// Node 24 can require these ESM files directly. This keeps copied fixtures
// outside Vitest's source transform while preserving synchronous read calls.
const requireFixtureModule = createRequire(import.meta.url);

type CatalogRow = { migrationName: string; checksum: string };
const catalog: readonly CatalogRow[] = readRenderSchemaHandoffCatalog();
const extension: readonly CatalogRow[] = renderSchemaHandoffCheckoutExtension;
const expanded = [...catalog, ...extension];
const migration96 = {
  migrationName: "000096_hosted_pool_public_repository_eligibility",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000096_hosted_pool_public_repository_eligibility/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout96 = [...expanded, migration96];
const migration098 = {
  migrationName: "000098_certified_fork_effect_archive",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000098_certified_fork_effect_archive/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout97 = [...checkout96, migration098];

const migration099 = {
  migrationName: "000099_certified_fork_proof_facts",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000099_certified_fork_proof_facts/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout98 = [...checkout97, migration099];
const migration100 = {
  migrationName: "000100_hosted_codex_device_login",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000100_hosted_codex_device_login/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout99 = [...checkout98, migration100];

const migration101 = {
  migrationName: "000101_sdk_growth_authority",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000101_sdk_growth_authority/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout100 = [...checkout99, migration101];

const migration102 = {
  migrationName: "000102_sdk_growth_current_authority",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000102_sdk_growth_current_authority/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout101 = [...checkout100, migration102];
const migration103 = {
  migrationName: "000103_sdk_growth_authority_custody",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000103_sdk_growth_authority_custody/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout102 = [...checkout101, migration103];
const migration104 = {
  migrationName: "000104_hosted_pool_request_scoped_failover",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000104_hosted_pool_request_scoped_failover/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout103 = [...checkout102, migration104];
const migration105 = {
  migrationName: "000105_sdk_growth_publication_effect",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000105_sdk_growth_publication_effect/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout104 = [...checkout103, migration105];
const migration106 = {
  migrationName: "000106_sdk_growth_finalized_report_logical_identity",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000106_sdk_growth_finalized_report_logical_identity/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout105 = [...checkout104, migration106];
const migration107 = {
  migrationName: "000107_hosted_v4_relay_turn_contract",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000107_hosted_v4_relay_turn_contract/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout106 = [...checkout105, migration107];
const migration108 = {
  migrationName: "000108_sdk_growth_verifier_assignment",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000108_sdk_growth_verifier_assignment/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout107 = [...checkout106, migration108];
const migration109 = {
  migrationName: "000109_sdk_growth_verifier_assignment_lock",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000109_sdk_growth_verifier_assignment_lock/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout108 = [...checkout107, migration109];
const migration110 = {
  migrationName: "000110_historical_unknown_scope_barrier",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000110_historical_unknown_scope_barrier/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout109 = [...checkout108, migration110];
const migration111 = {
  migrationName: "000111_sdk_growth_source_binding",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000111_sdk_growth_source_binding/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout110 = [...checkout109, migration111];
const migration112 = {
  migrationName: "000112_sdk_growth_operator_credential",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000112_sdk_growth_operator_credential/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout111 = [...checkout110, migration112];
const migration113 = {
  migrationName: "000113_sdk_growth_approval_ledger",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000113_sdk_growth_approval_ledger/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout112 = [...checkout111, migration113];
const migration114 = {
  migrationName: "000114_sdk_growth_v3_tool_artifact",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000114_sdk_growth_v3_tool_artifact/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout113 = [...checkout112, migration114];
const migration115 = {
  migrationName: "000115_sdk_growth_v3_approved_manifest",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000115_sdk_growth_v3_approved_manifest/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout114 = [...checkout113, migration115];
const migration116 = {
  migrationName: "000116_hosted_codex_relay_admission_utc",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000116_hosted_codex_relay_admission_utc/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout115 = [...checkout114, migration116];
const migration117 = {
  migrationName: "000117_provider_accounts",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000117_provider_accounts/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout116 = [...checkout115, migration117];
const migration118 = {
  migrationName: "000118_workspace_binding_fences",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000118_workspace_binding_fences/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout117 = [...checkout116, migration118];
const migration119 = {
  migrationName: "000119_review_configuration_gateway_binding",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000119_review_configuration_gateway_binding/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout118 = [...checkout117, migration119];
const migration120 = {
  migrationName: "000120_review_run_runtime_snapshot",
  checksum: createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../packages/platform/db/prisma/migrations/000120_review_run_runtime_snapshot/migration.sql",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
};
const checkout119 = [...checkout118, migration120];
// Historical fixture boundaries do not move when the checkout gains a tail.
const canonicalPrefix = (count: number) =>
  canonicalPrismaMigrationNames.slice(0, count);

describe("explicit checkout partition with an unchanged managed92 validator", () => {
  it("admits only the exact main plus SQL125 branch and preserves old main", () => {
    const current = readRenderManagedCheckoutInventory().filter(
      (row) =>
        row.migrationName <= migration116.migrationName ||
        row.migrationName === reconnectMigrationName,
    );
    const oldMain = current.filter(
      (row) => row.migrationName !== reconnectMigrationName,
    );
    const identity = (rows: readonly CatalogRow[]) =>
      createHash("sha256")
        .update(
          rows.map((row) => `${row.migrationName}:${row.checksum}`).join(","),
        )
        .digest("hex");
    expect(current).toHaveLength(117);
    expect(identity(current)).toBe(
      "1cdcfc995996a4e90864741ffaf11b43540eb491cf1bcdad158a05c6609364b3",
    );
    expect(oldMain).toHaveLength(116);
    expect(identity(oldMain)).toBe(
      "495a040aeb13c5fc43ea611546be10c9e5edcf519c67bc1f5e40d797f6c50538",
    );
    expect(partitionRenderSchemaHandoffCheckout(current)).toEqual(catalog);
    expect(partitionRenderSchemaHandoffCheckout(oldMain)).toEqual(catalog);
    const wrongBranch = [
      ...oldMain,
      {
        migrationName: "000117_provider_accounts",
        checksum: "0".repeat(64),
      },
    ];
    for (const changed of [
      current.map((row) =>
        row.migrationName === reconnectMigrationName
          ? { ...row, checksum: "0".repeat(64) }
          : row,
      ),
      current.map((row) =>
        row.migrationName === reconnectMigrationName
          ? { ...row, migrationName: "000125_relabelled" }
          : row,
      ),
      current.filter((row) => row.migrationName !== migration116.migrationName),
      [
        ...current,
        { migrationName: "000126_unknown", checksum: "0".repeat(64) },
      ],
      [...current, current.at(-1)!],
      wrongBranch,
    ]) {
      expect(() => partitionRenderSchemaHandoffCheckout(changed)).toThrow();
    }
  });

  it("projects every admitted boundary through exactly113 to the same managed92 rows", () => {
    for (const source of [
      catalog,
      expanded,
      checkout96,
      checkout97,
      checkout98,
      checkout99,
      checkout100,
      checkout101,
      checkout102,
      checkout103,
      checkout104,
      checkout105,
      checkout106,
      checkout107,
      checkout108,
      checkout109,
      checkout110,
      checkout111,
      checkout112,
      checkout113,
    ]) {
      const before = structuredClone(source);
      const managed = partitionRenderSchemaHandoffCheckout(source);
      expect(managed).toEqual(catalog);
      expect(Object.isFrozen(managed)).toBe(true);
      expect(source).toEqual(before);
    }
    expect(() => assertRenderSchemaHandoffCatalog(expanded)).toThrow(
      "migration_catalog",
    );
    expect(
      createHash("sha256")
        .update(
          expanded.map((r) => `${r.migrationName}:${r.checksum}`).join(","),
        )
        .digest("hex"),
    ).toBe("6c62ac869a47211043f8fffdd7af105cb6bd677b65462033195d41e7d7aafa2e");
  });

  it("rejects drift and incomplete histories while preserving exact older boundaries", () => {
    for (const source of [
      catalog,
      expanded,
      checkout96,
      checkout97,
      checkout98,
      checkout99,
      checkout100,
      checkout101,
      checkout102,
      checkout103,
      checkout104,
      checkout105,
      checkout106,
      checkout107,
      checkout108,
    ]) {
      for (const [index] of source.entries()) {
        const changed = source.map((row) => ({ ...row }));
        changed[index]!.checksum = "0".repeat(64);
        expect(() => partitionRenderSchemaHandoffCheckout(changed)).toThrow();
        const removed = source.filter((_, i) => i !== index);
        if (
          (source === checkout96 && index === 95) ||
          (source === checkout97 && index === 96) ||
          (source === checkout98 && index === 97) ||
          (source === checkout99 && index === 98) ||
          (source === checkout100 && index === 99) ||
          (source === checkout101 && index === 100) ||
          (source === checkout102 && index === 101) ||
          (source === checkout103 && index === 102) ||
          (source === checkout104 && index === 103) ||
          (source === checkout105 && index === 104) ||
          (source === checkout106 && index === 105) ||
          (source === checkout107 && index === 106) ||
          (source === checkout108 && index === 107)
        )
          expect(partitionRenderSchemaHandoffCheckout(removed)).toEqual(
            catalog,
          );
        else
          expect(() => partitionRenderSchemaHandoffCheckout(removed)).toThrow();
      }
    }
  });

  it("pins checkout96 to actual canonical SQL bytes", () => {
    expect(checkout96.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(96),
    );
    expect(
      createHash("sha256")
        .update(
          checkout96
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b");
    expect(() => assertRenderSchemaHandoffCatalog(checkout96)).toThrow(
      "migration_catalog",
    );
  });

  it("pins checkout97 to actual SQL098 bytes and the complete manifest", () => {
    expect(migration098.checksum).toBe(
      "b90a4178f923d523ee0580ca3fc12279e6a1830ad54404b06c10e991fc12139f",
    );
    expect(checkout97.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(97),
    );
    expect(
      createHash("sha256")
        .update(
          checkout97
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("d55f22c9317678a501fbef170b8f0f7b238ad4f1c1fa4232a02e7b291053c273");
    expect(() => assertRenderSchemaHandoffCatalog(checkout97)).toThrow(
      "migration_catalog",
    );
  });

  it("pins checkout98 to actual SQL099 bytes and the complete manifest", () => {
    expect(migration099.checksum).toBe(
      "c40a8c3ccdf14c5f84a79b5310dbf67c9306ac8c0a0cfb4f1090ced4c7c01fbd",
    );
    expect(checkout98.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(98),
    );
    expect(
      createHash("sha256")
        .update(
          checkout98
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("c6b3c39ffd4631d53402f7402700a352d75208bb125b9e48d52d42d5e6a1398c");
    expect(() => assertRenderSchemaHandoffCatalog(checkout98)).toThrow(
      "migration_catalog",
    );
  });

  it("pins checkout99 to actual SQL100 bytes and the complete manifest", () => {
    expect(migration100.checksum).toBe(
      "495fd9321ffb92fc75aa60807ef644bd720778cd2529fb08d2a0a183fc7404b6",
    );
    expect(checkout99.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(99),
    );
    expect(
      createHash("sha256")
        .update(
          checkout99
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("5b967b29970341cad78f4388cd046606464928c5f20392dc7353fa929b1278dc");
    expect(() => assertRenderSchemaHandoffCatalog(checkout99)).toThrow(
      "migration_catalog",
    );
  });

  it("pins checkout100 to actual SQL101 bytes and the complete manifest", () => {
    expect(migration101.checksum).toBe(
      "b6c7c4005bf3a521a1cbcf3579197b58c0c56c91056a02d01a17c60eb7bbf1b9",
    );
    expect(checkout100.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(100),
    );
    expect(
      createHash("sha256")
        .update(
          checkout100
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("8fdb700169875a4db08732aa0332b619538527fa37e06b71d5f296fa19a30d26");
    expect(() => assertRenderSchemaHandoffCatalog(checkout100)).toThrow(
      "migration_catalog",
    );
  });

  it("pins checkout101 to actual SQL102 bytes and the complete manifest", () => {
    expect(migration102.checksum).toBe(
      "49757aeaab4ad1cf6b54f41b3768f7e4c8cdbd8beba9436ef4a3f4aa4c4e87cc",
    );
    expect(checkout101.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(101),
    );
    expect(
      createHash("sha256")
        .update(
          checkout101
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("dfcbd39f6b18377d7da5b4c1cd1351ae058ade6dc08ba2ebf33ffec5506c9804");
    expect(() => assertRenderSchemaHandoffCatalog(checkout101)).toThrow(
      "migration_catalog",
    );
  });

  it("pins checkout102 to actual SQL103 bytes and the complete manifest", () => {
    expect(migration103.checksum).toBe(
      "d6ae002a076c616d33ce854477096408b37e4285bb1c036dd2be13072786c8f9",
    );
    expect(checkout102.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(102),
    );
    expect(
      createHash("sha256")
        .update(
          checkout102
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("a2e683899abcc3f9adf377cbc8ecb2e051d84a0e7c6e9fffc0fe32fa150c3983");
    expect(() => assertRenderSchemaHandoffCatalog(checkout102)).toThrow(
      "migration_catalog",
    );
  });

  it("pins checkout103 to actual SQL104 bytes and the complete manifest", () => {
    expect(migration104.checksum).toBe(
      "7e63286c8bfab3c1cf7aa559c1515fa39a47ec3f8861eefcbf569a5d462039a7",
    );
    expect(checkout103.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(103),
    );
    expect(
      createHash("sha256")
        .update(
          checkout103
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("d8c18d54579a469dc03635213cfc3e61e2d9564ed775ee67653482f9776c7287");
    expect(() => assertRenderSchemaHandoffCatalog(checkout103)).toThrow(
      "migration_catalog",
    );
  });

  it("pins checkout104 to actual SQL105 bytes and the complete manifest", () => {
    expect(migration105.checksum).toBe(
      "d92d4368cc20c5217cdeaf18f1abbeec7c98efd873fc91110c6178eb1739848f",
    );
    expect(checkout104.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(104),
    );
    expect(
      createHash("sha256")
        .update(
          checkout104
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("8c76fd167e6483aeced3efba870d8f21fcb9b4f9f5b142ee9a767ee011096f9c");
    expect(() => assertRenderSchemaHandoffCatalog(checkout104)).toThrow(
      "migration_catalog",
    );
  });

  it("pins hosted-v4 checkout106 to exact SQL107 bytes and keeps checkout105 valid", () => {
    expect(migration106.checksum).toBe(
      "a47efeb47fcac73f502818fdf959ff86e44c228951b2839a1b694072e98c3f6d",
    );
    expect(migration107.checksum).toBe(
      "476184a558e47d23ee4127b7ff2221979b37e81faabf8ad66cba42dfd35aba9b",
    );
    expect(checkout106.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(106),
    );
    expect(
      createHash("sha256")
        .update(
          checkout105
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("51fb004c51bbd2612b04316903695d2d445cb98b64e04f1c054492206683677c");
    expect(
      createHash("sha256")
        .update(
          checkout106
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("c4849371f75ab6239dc91a1ec2ba7ae5bde6d7a5368bc1c7d5509d3d7959fc43");
    expect(() =>
      partitionRenderSchemaHandoffCheckout(
        checkout106.map((row) =>
          row.migrationName === migration107.migrationName
            ? { ...row, checksum: "0".repeat(64) }
            : row,
        ),
      ),
    ).toThrow("render_schema_handoff_rejected:checkout_extension");
    expect(() =>
      partitionRenderSchemaHandoffCheckout([
        ...checkout104,
        {
          migrationName: "000107_unclassified_replacement",
          checksum: migration106.checksum,
        },
      ]),
    ).toThrow("render_schema_handoff_rejected:");
  });

  it("admits exact hosted-v4 and SDK assignment tails in order", () => {
    expect(migration108.checksum).toBe(
      "ad11dc22b7c528e68fa371d5a435d1ae494fc07b517d14822bfe9472df35ff1a",
    );
    expect(migration109.checksum).toBe(
      "750038a865bced544ae9cca42060112a6479c05163c3dc05c41f504c993147ef",
    );
    expect(checkout109.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(109),
    );
    expect(partitionRenderSchemaHandoffCheckout(checkout107)).toEqual(catalog);
    expect(partitionRenderSchemaHandoffCheckout(checkout108)).toEqual(catalog);
    for (const migration of [migration108, migration109]) {
      expect(() =>
        partitionRenderSchemaHandoffCheckout(
          checkout108.map((row) =>
            row.migrationName === migration.migrationName
              ? { ...row, checksum: "0".repeat(64) }
              : row,
          ),
        ),
      ).toThrow("checkout_extension");
    }
    expect(() =>
      partitionRenderSchemaHandoffCheckout(
        checkout108.filter(
          (row) => row.migrationName !== migration108.migrationName,
        ),
      ),
    ).toThrow();
    expect(
      partitionRenderSchemaHandoffCheckout(
        checkout108.filter(
          (row) => row.migrationName !== migration109.migrationName,
        ),
      ),
    ).toEqual(catalog);
  });

  it("admits only exact SQL110 after the immutable 108-directory checkout", () => {
    expect(checkout108).toHaveLength(108);
    expect(migration110.checksum).toBe(
      "aa9cd8a8e34e9909dcc22c5a7dd94cc4121821db93330c0a54bb48b0aaf61a79",
    );
    expect(checkout109).toHaveLength(109);
    expect(
      createHash("sha256")
        .update(
          checkout109
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("1a5470960ccf766827bb58fc0a270553f002802e0019225adb4a0dfcf2b591af");
    expect(partitionRenderSchemaHandoffCheckout(checkout108)).toEqual(catalog);
    expect(partitionRenderSchemaHandoffCheckout(checkout109)).toEqual(catalog);
    expect(() => assertRenderSchemaHandoffCatalog(checkout109)).toThrow(
      "migration_catalog",
    );
    for (const rows of [
      [...checkout108, { ...migration110, checksum: "0".repeat(64) }],
      [...checkout108, { ...migration110, migrationName: "000110_relabelled" }],
      [
        ...checkout109,
        { migrationName: "000111_unknown", checksum: "a".repeat(64) },
      ],
      checkout109.filter(
        (row) => row.migrationName !== migration109.migrationName,
      ),
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  it("admits only exact SQL111 after the 109-directory checkout", () => {
    expect(migration111.checksum).toBe(
      "2d9b80ff0d894ba22602c4d84f7487a5343352e6bd2602f64c0b3cafdce048cd",
    );
    expect(checkout110.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(110),
    );
    expect(
      createHash("sha256")
        .update(
          checkout110
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("48019e5f9ad81af25742e30903b83d7053affa263c2e0674a4f9e4c909b4ec26");
    expect(partitionRenderSchemaHandoffCheckout(checkout110)).toEqual(catalog);
    for (const rows of [
      [...checkout109, { ...migration111, checksum: "0".repeat(64) }],
      [...checkout109, { ...migration111, migrationName: "000111_relabelled" }],
      [
        ...checkout110,
        { migrationName: "000112_unknown", checksum: "a".repeat(64) },
      ],
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  it("admits only exact SQL112 after the 110-directory checkout", () => {
    expect(migration112.checksum).toBe(
      "0178f5198025c8e0f03bc995139940f9a2c9739f3c3ad000c857e8e0c8b425d0",
    );
    expect(checkout111.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(111),
    );
    expect(
      createHash("sha256")
        .update(
          checkout111
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("7e1d7018a5f959cfd5d237fd2ac18dd1436580b05ab0da7a9416bc7dfb842988");
    expect(partitionRenderSchemaHandoffCheckout(checkout111)).toEqual(catalog);
    for (const rows of [
      [...checkout110, { ...migration112, checksum: "0".repeat(64) }],
      [...checkout110, { ...migration112, migrationName: "000112_relabelled" }],
      [
        ...checkout111,
        { migrationName: "000113_unknown", checksum: "a".repeat(64) },
      ],
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  it("admits only exact SQL113 after the 111-directory checkout", () => {
    expect(migration113.checksum).toBe(
      "1684eced3efccf7af153c4fd8e24a31a96aec20ddb2674b2764ba56796d8f6c2",
    );
    expect(checkout112.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(112),
    );
    expect(
      createHash("sha256")
        .update(
          checkout112
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("24a99e65c00ef46f0a63d0823ec12f38575b793e794c82990bd5c3ecfd0a2271");
    expect(partitionRenderSchemaHandoffCheckout(checkout112)).toEqual(catalog);
    for (const rows of [
      [...checkout111, { ...migration113, checksum: "0".repeat(64) }],
      [...checkout111, { ...migration113, migrationName: "000113_relabelled" }],
      [
        ...checkout112,
        { migrationName: "000114_unknown", checksum: "a".repeat(64) },
      ],
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  it("admits only exact SQL114 after the 112-directory checkout", () => {
    expect(migration114.checksum).toBe(
      "14d0dd69bdf596cbdfe39306965b08bd969a9d9b89b0a49ddcfe34fe43118d58",
    );
    expect(checkout113.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(113),
    );
    expect(
      createHash("sha256")
        .update(
          checkout113
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("06b7ead8634045dd96f1e79626cb1fdcee3bd147ca5068e9fe001705271f5446");
    expect(partitionRenderSchemaHandoffCheckout(checkout113)).toEqual(catalog);
    for (const rows of [
      [...checkout112, { ...migration114, checksum: "0".repeat(64) }],
      [...checkout112, { ...migration114, migrationName: "000114_relabelled" }],
      [
        ...checkout113,
        { migrationName: "000115_unknown", checksum: "a".repeat(64) },
      ],
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  it("admits only exact SQL115 after the 113-directory checkout", () => {
    expect(migration115.checksum).toBe(
      "07fdc348fe27d0ee1ddc15d97e6932cca3dc02cc920d856c4380f71cabb36db0",
    );
    expect(checkout114.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(114),
    );
    expect(
      createHash("sha256")
        .update(
          checkout114
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("15a397089c81b84540534361777b74a69a48955df7db81bf6353130d51aa6ed0");
    expect(partitionRenderSchemaHandoffCheckout(checkout114)).toEqual(catalog);
    for (const rows of [
      [...checkout113, { ...migration115, checksum: "0".repeat(64) }],
      [...checkout113, { ...migration115, migrationName: "000115_relabelled" }],
      [
        ...checkout114,
        { migrationName: "000116_unknown", checksum: "a".repeat(64) },
      ],
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  it("admits exact SQL116 and SQL117 only as checkout evidence, retaining managed92", () => {
    expect(migration116.checksum).toBe(
      "af399b3aea5cd73e0b65a46085bba2df216cd44888caf066baa02a6516f7d585",
    );
    expect(checkout115.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(115),
    );
    expect(partitionRenderSchemaHandoffCheckout(checkout115)).toEqual(catalog);
    expect(migration117.checksum).toBe(
      "786e21fc4a8880c25f41304393a576d8e3337b6654720931aa076fdbf793c4e7",
    );
    expect(checkout116).toHaveLength(116);
    expect(checkout116.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(116),
    );
    expect(
      createHash("sha256")
        .update(
          checkout116
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("c5c0618f105799d06d21424433cec4a59fc052e63f594c2aace0657ebb52d1dd");
    expect(partitionRenderSchemaHandoffCheckout(checkout116)).toEqual(catalog);
    for (const rows of [
      [...checkout115, { ...migration117, checksum: "0".repeat(64) }],
      [...checkout115, { ...migration117, migrationName: "000117_relabelled" }],
      [...checkout114, migration117],
      [
        ...checkout116,
        { migrationName: "000118_unknown", checksum: "a".repeat(64) },
      ],
      [...checkout114, { ...migration116, checksum: "0".repeat(64) }],
      [...checkout114, { ...migration116, migrationName: "000116_relabelled" }],
      [
        ...checkout115,
        { migrationName: "000117_unknown", checksum: "a".repeat(64) },
      ],
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  // Regression: current SQL118 enters managed authority or bypasses full-byte checkout admission.
  it("admits exact SQL118 only as the complete current checkout tail, preserving previous116", () => {
    expect(migration118.checksum).toBe(
      "fe73ffe809b3c49b0739060e853e1a824ea6bf019a9922fccc8b729581db48db",
    );
    expect(checkout117).toHaveLength(117);
    expect(checkout117.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(117),
    );
    expect(
      createHash("sha256")
        .update(
          checkout117
            .map((row) => `${row.migrationName}:${row.checksum}`)
            .join(","),
        )
        .digest("hex"),
    ).toBe("6bd2cd3c077f6cf56735c7192dd6e0f84a21bbec5a2657271cb5afaf1d2f20cf");
    expect(partitionRenderSchemaHandoffCheckout(checkout117)).toEqual(catalog);
    expect(partitionRenderSchemaHandoffCheckout(checkout116)).toEqual(catalog);
    for (const rows of [
      [...checkout116, { ...migration118, checksum: "0".repeat(64) }],
      [...checkout116, { ...migration118, migrationName: "000118_relabelled" }],
      [...checkout115, migration118],
      [
        ...checkout117,
        { migrationName: "000119_unknown", checksum: "a".repeat(64) },
      ],
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  // Regression: SQL120 is rejected or enters managed92; a missing SQL119 must still deny.
  it("admits exact SQL119/120 only in the full checkout, preserving historical boundaries", () => {
    expect(checkout118.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(118),
    );
    expect(migration120.checksum).toBe(
      "6ced2dc41f736a2c6e42d6edafc4e9f753622fa157baff09ea962da9d81bd369",
    );
    expect(checkout119).toHaveLength(119);
    expect(checkout119.map((row) => row.migrationName)).toEqual(
      canonicalPrefix(119),
    );
    expect(partitionRenderSchemaHandoffCheckout(checkout119)).toEqual(catalog);
    expect(partitionRenderSchemaHandoffCheckout(checkout118)).toEqual(catalog);
    expect(partitionRenderSchemaHandoffCheckout(checkout117)).toEqual(catalog);
    for (const rows of [
      [...checkout117, { ...migration119, checksum: "0".repeat(64) }],
      [...checkout117, { ...migration119, migrationName: "000119_unknown" }],
      [...checkout116, migration119],
      [...checkout118, { ...migration120, checksum: "0".repeat(64) }],
      [...checkout118, { ...migration120, migrationName: "000120_unknown" }],
      [...checkout117, migration120],
    ])
      expect(() => partitionRenderSchemaHandoffCheckout(rows)).toThrow();
  });

  it("rejects SQL098 with every incomplete predecessor extension set", () => {
    const predecessors = [...extension, migration96];
    for (let bits = 0; bits < 15; bits++) {
      const partial = predecessors.filter((_, i) => bits & (1 << i));
      expect(() =>
        partitionRenderSchemaHandoffCheckout([
          ...catalog,
          ...partial,
          migration098,
        ]),
      ).toThrow();
    }
  });

  it("rejects SQL099 with every incomplete predecessor extension set", () => {
    const predecessors = [...extension, migration96, migration098];
    for (let bits = 0; bits < 31; bits++) {
      const partial = predecessors.filter((_, i) => bits & (1 << i));
      expect(() =>
        partitionRenderSchemaHandoffCheckout([
          ...catalog,
          ...partial,
          migration099,
        ]),
      ).toThrow();
    }
  });

  it("rejects SQL100 with every incomplete predecessor extension set", () => {
    const predecessors = [
      ...extension,
      migration96,
      migration098,
      migration099,
    ];
    for (let bits = 0; bits < 63; bits++) {
      const partial = predecessors.filter((_, i) => bits & (1 << i));
      expect(() =>
        partitionRenderSchemaHandoffCheckout([
          ...catalog,
          ...partial,
          migration100,
        ]),
      ).toThrow();
    }
  });

  it("rejects SQL101 with every incomplete predecessor extension set", () => {
    const predecessors = [
      ...extension,
      migration96,
      migration098,
      migration099,
      migration100,
    ];
    for (let bits = 0; bits < 127; bits++) {
      const partial = predecessors.filter((_, i) => bits & (1 << i));
      expect(() =>
        partitionRenderSchemaHandoffCheckout([
          ...catalog,
          ...partial,
          migration101,
        ]),
      ).toThrow();
    }
  });

  it("rejects SQL102 with every incomplete predecessor extension set", () => {
    const predecessors = [
      ...extension,
      migration96,
      migration098,
      migration099,
      migration100,
      migration101,
    ];
    for (let bits = 0; bits < 255; bits++) {
      const partial = predecessors.filter((_, i) => bits & (1 << i));
      expect(() =>
        partitionRenderSchemaHandoffCheckout([
          ...catalog,
          ...partial,
          migration102,
        ]),
      ).toThrow();
    }
  });

  it("rejects SQL96 with any incomplete historical extension tail", () => {
    for (let bits = 0; bits < 7; bits++) {
      const partial = extension.filter((_, i) => bits & (1 << i));
      expect(() =>
        partitionRenderSchemaHandoffCheckout([
          ...catalog,
          ...partial,
          migration96,
        ]),
      ).toThrow();
    }
  });

  it("rejects all six partial extension sets and preserves zero extensions", () => {
    for (const bits of [1, 2, 3, 4, 5, 6]) {
      const partial = extension.filter((_, i) => bits & (1 << i));
      expect(() =>
        partitionRenderSchemaHandoffCheckout([...catalog, ...partial]),
      ).toThrow("checkout_extension");
    }
    expect(partitionRenderSchemaHandoffCheckout(catalog)).toEqual(catalog);
  });

  it.each([
    "000000_unknown",
    "000050_unknown",
    "000097_unknown",
    "000099_unknown",
    "000100_unknown",
    "000101_unknown",
    "999999_unknown",
  ])(
    "rejects %s as an addition or replacement in every admitted checkout",
    (migrationName) => {
      for (const source of [
        catalog,
        expanded,
        checkout96,
        checkout97,
        checkout98,
        checkout99,
        checkout100,
        checkout101,
        checkout102,
        checkout103,
        checkout104,
        checkout105,
        checkout106,
      ]) {
        const unknown = { migrationName, checksum: "a".repeat(64) };
        for (const changed of [
          [...source, unknown],
          [...source.slice(1), unknown],
        ]) {
          changed.sort((a, b) =>
            a.migrationName.localeCompare(b.migrationName, "en"),
          );
          expect(() => partitionRenderSchemaHandoffCheckout(changed)).toThrow();
        }
      }
    },
  );

  it("never normalizes duplicate/reordered/malformed rows or infers numeric identities", () => {
    for (const source of [
      catalog,
      expanded,
      checkout96,
      checkout97,
      checkout98,
      checkout99,
      checkout100,
      checkout101,
      checkout102,
      checkout103,
      checkout104,
      checkout105,
      checkout106,
      checkout107,
      checkout108,
    ]) {
      for (const changed of [
        [...source].reverse(),
        [source[0], ...source.slice(0, -1)],
        [...source, source.at(-1)],
        [null, ...source.slice(1)],
        source.map((row) => ({
          ...row,
          migrationName: row.migrationName.slice(0, 6),
        })),
        null,
        [],
      ])
        expect(() => partitionRenderSchemaHandoffCheckout(changed)).toThrow();
    }
  });
});

// Exercise the current inventory and all historical checkouts with actual SQL bytes.
describe("complete filesystem checkout inventory", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const path of directories.splice(0))
      rmSync(path, { recursive: true, force: true });
  });
  async function checkout(count?: number) {
    const artifacts = join(
      tmpdir(),
      "rr-managed-catalog-partition-r1-artifacts",
    );
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "reader-"));
    directories.push(root);
    const lib = join(root, "scripts/lib");
    const migrations = join(root, "packages/platform/db/prisma/migrations");
    mkdirSync(lib, { recursive: true });
    for (const name of [
      "render-schema-handoff-policy.mjs",
      "canonical-prisma-migration-catalog.mjs",
    ])
      cpSync(new URL(name, import.meta.url), join(lib, name));
    cpSync(
      new URL("../../packages/platform/db/prisma/migrations", import.meta.url),
      migrations,
      { recursive: true },
    );
    if (count !== undefined) {
      rmSync(join(migrations, providerKeyMigrationName), { recursive: true });
      rmSync(join(migrations, reconnectMigrationName), { recursive: true });
      for (const name of canonicalPrismaMigrationNames.slice(count))
        rmSync(join(migrations, name), { recursive: true });
    }
    const policy = requireFixtureModule(
      join(lib, "render-schema-handoff-policy.mjs"),
    ) as typeof import("./render-schema-handoff-policy.mjs");
    const canonical = requireFixtureModule(
      join(lib, "canonical-prisma-migration-catalog.mjs"),
    ) as typeof import("./canonical-prisma-migration-catalog.mjs");
    return {
      migrations,
      read: policy.readRenderSchemaHandoffCatalog,
      canonical,
    };
  }

  it("reads checkout125 through historical124 and key-free123 as identical frozen92 rows", async () => {
    const fixture = await checkout();
    const inventory = readdirSync(fixture.migrations).sort();
    expect(inventory).toEqual(fixture.canonical.canonicalPrismaMigrationNames);
    expect(inventory).toHaveLength(125);
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, reconnectMigrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(124);
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, providerKeyMigrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(123);
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, "000124_personal_account_operations"), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(122);
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, "000123_personal_workspace_identity"), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(121);
    expect(fixture.read()).toEqual(catalog);
    rmSync(
      join(fixture.migrations, "000122_review_configuration_operation_receipt"),
      {
        recursive: true,
      },
    );
    expect(readdirSync(fixture.migrations)).toHaveLength(120);
    expect(fixture.read()).toEqual(catalog);
    rmSync(
      join(fixture.migrations, "000121_review_run_gateway_execution_binding"),
      {
        recursive: true,
      },
    );
    rmSync(join(fixture.migrations, migration120.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration119.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration118.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration117.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration116.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration115.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration114.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration113.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration112.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration111.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration110.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration109.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    rmSync(join(fixture.migrations, migration108.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(catalog);
    const actual = fixture.read();
    expect(actual).toEqual(catalog);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(actual.every(Object.isFrozen)).toBe(true);
    rmSync(join(fixture.migrations, migration107.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration106.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration105.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration104.migrationName), {
      recursive: true,
    });
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration103.migrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(101);
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration102.migrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(100);
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration101.migrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(99);
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration100.migrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(98);
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration099.migrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(97);
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration098.migrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(96);
    expect(fixture.read()).toEqual(actual);
    rmSync(join(fixture.migrations, migration96.migrationName), {
      recursive: true,
    });
    expect(readdirSync(fixture.migrations)).toHaveLength(95);
    expect(fixture.read()).toEqual(actual);
    const bytes = extension.map((row) =>
      readFileSync(
        join(fixture.migrations, row.migrationName, "migration.sql"),
      ),
    );
    for (const bits of [1, 2, 3, 4, 5, 6]) {
      for (const [index, row] of extension.entries()) {
        const path = join(fixture.migrations, row.migrationName);
        rmSync(path, { recursive: true, force: true });
        if (bits & (1 << index)) {
          mkdirSync(path);
          writeFileSync(join(path, "migration.sql"), bytes[index]!);
        }
      }
      expect(() => fixture.read()).toThrow("checkout_extension");
    }
    for (const row of extension)
      rmSync(join(fixture.migrations, row.migrationName), {
        recursive: true,
        force: true,
      });
    expect(readdirSync(fixture.migrations)).toHaveLength(92);
    expect(fixture.read()).toEqual(actual);
  });

  it("admits only complete extension sets from actual filesystem bytes", async () => {
    const fixture = await checkout(119);
    const tail = [
      ...extension,
      migration96,
      migration098,
      migration099,
      migration100,
      migration101,
      migration102,
      migration103,
      migration104,
      migration105,
      migration106,
      migration107,
      migration108,
      migration109,
      migration110,
      migration111,
      migration112,
      migration113,
      migration114,
      migration115,
      migration116,
      migration117,
      migration118,
      migration119,
      migration120,
    ];
    const bytes = tail.map((row) =>
      readFileSync(
        join(fixture.migrations, row.migrationName, "migration.sql"),
      ),
    );
    const accepted = [
      0, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767,
      65535, 131071, 262143, 524287, 1048575, 2097151, 4194303, 8388607,
      16777215, 33554431, 67108863, 134217727,
    ];
    const fullMask = (1 << tail.length) - 1;
    const masks = [
      ...accepted,
      ...tail.map((_, index) => fullMask ^ (1 << index)),
      5,
      42,
      1025,
    ];
    for (const bits of new Set(masks)) {
      for (const [index, row] of tail.entries()) {
        const directory = join(fixture.migrations, row.migrationName);
        rmSync(directory, { recursive: true, force: true });
        if (bits & (1 << index)) {
          mkdirSync(directory);
          writeFileSync(join(directory, "migration.sql"), bytes[index]!);
        }
      }
      if (accepted.includes(bits)) expect(fixture.read()).toEqual(catalog);
      else expect(() => fixture.read()).toThrow();
    }
  }, 120_000);

  it.each([
    "000000_unknown",
    "000050_unknown",
    "000097_unknown",
    "000099_unknown",
    "000100_unknown",
    "000101_unknown",
    "999999_unknown",
    ".hidden",
    "README",
    "000090-UPPER",
    "000090_bad-name",
  ])(
    "rejects directory %s even after the shared scanner has cached names",
    async (name) => {
      const fixture = await checkout();
      const path = join(fixture.migrations, name);
      mkdirSync(path);
      writeFileSync(join(path, "migration.sql"), "SELECT 1;\n");
      expect(fixture.canonical.canonicalPrismaMigrationNames).not.toContain(
        name,
      );
      expect(() => fixture.read()).toThrow("render_schema_handoff_rejected:");
    },
  );

  it("rejects non-directory inventory entries, replacements and symlinks", async () => {
    const fixture = await checkout();
    const extra = join(fixture.migrations, "README");
    writeFileSync(extra, "unexpected");
    expect(() => fixture.read()).toThrow("checkout_inventory");
    rmSync(extra);
    const original = join(fixture.migrations, catalog[0]!.migrationName);
    const replacement = join(fixture.migrations, "000000_unknown");
    renameSync(original, replacement);
    expect(() => fixture.read()).toThrow();
    renameSync(replacement, original);
    const sql = join(original, "migration.sql");
    const outside = join(fixture.migrations, "..", "saved.sql");
    renameSync(sql, outside);
    symlinkSync(outside, sql);
    expect(() => fixture.read()).toThrow("checkout_inventory");
  });

  it("rejects changed or missing SQL and missing directories across the real inventory", async () => {
    const fixture = await checkout();
    for (const name of readdirSync(fixture.migrations).sort()) {
      const directory = join(fixture.migrations, name);
      const sql = join(directory, "migration.sql");
      const bytes = readFileSync(sql);
      writeFileSync(sql, Buffer.concat([bytes, Buffer.from("\n-- drift\n")]));
      expect(() => fixture.read()).toThrow();
      rmSync(sql);
      expect(() => fixture.read()).toThrow("checkout_inventory");
      rmSync(directory, { recursive: true });
      if (name === reconnectMigrationName || name === providerKeyMigrationName)
        expect(fixture.read()).toEqual(catalog);
      else expect(() => fixture.read()).toThrow();
      mkdirSync(directory);
      writeFileSync(sql, bytes);
    }
    expect(fixture.read()).toEqual(catalog);
  });
});

const ledger = (count: number = contract.baselineCount) =>
  catalog.slice(0, count).map((row) => ({
    ...row,
    finished: true,
    rolledBack: false,
    appliedStepsCount: 1,
    hasLogs: false,
  }));
const principals = ["reviewrouter", "reviewrouter_release_schema_owner"];
const defaultRow = () => ({
  oid: "12345",
  owner: "reviewrouter",
  schema: "*",
  objectType: "r",
  entries: [
    {
      grantee: "reviewrouter",
      grantor: "reviewrouter",
      privilege: "SELECT",
      grantable: false,
    },
  ],
});
const assertDefaults = (rows: unknown) =>
  assertEmptyApplicableRenderDefaultAcl({ version: 1, rows }, principals);

describe("managed schema handoff immutable source and history boundary", () => {
  it("binds all 92 source checksums and the exact 89-row prefix", () => {
    expect(catalog).toHaveLength(92);
    expect(catalog.slice(89)).toEqual(contract.pending);
    expect(contract.sourceCommit).toBe(
      "42134d9b8c263915340f910786b6826824bf30b5",
    );
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.pending[0])).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(() => assertRenderSchemaHandoffCatalog(catalog)).not.toThrow();
  });

  it("accepts complete unordered history without mutating the observation", () => {
    for (const phase of ["baseline", "target"]) {
      const rows = ledger(phase === "baseline" ? 89 : 92).reverse();
      const before = structuredClone(rows);
      expect(() =>
        assertRenderSchemaHandoffLedger(catalog, rows, phase),
      ).not.toThrow();
      expect(rows).toEqual(before);
    }
  });

  it.each([0, 88, 89, 90, 91])(
    "rejects source checksum drift at entry %s even with matching observed history",
    (index) => {
      const changed = catalog.map((row) => ({ ...row }));
      changed[index]!.checksum = "a".repeat(64);
      expect(() => assertRenderSchemaHandoffCatalog(changed)).toThrow(
        "migration_catalog",
      );
      expect(() =>
        assertRenderSchemaHandoffLedger(changed, ledger(), "baseline"),
      ).toThrow("migration_catalog");
    },
  );

  it("rejects duplicate, reordered, truncated, or extended source catalogs", () => {
    for (const changed of [
      [catalog[0], ...catalog.slice(0, -1)],
      [...catalog].reverse(),
      catalog.slice(1),
      [...catalog, catalog[91]],
      null,
      [],
    ])
      expect(() => assertRenderSchemaHandoffCatalog(changed)).toThrow(
        "migration_catalog",
      );
  });

  it.each(["finished", "rolledBack", "appliedStepsCount", "hasLogs"])(
    "rejects ambiguous history field %s",
    (field) => {
      const rows = ledger();
      const values = {
        finished: false,
        rolledBack: true,
        appliedStepsCount: 0,
        hasLogs: true,
      };
      Object.assign(rows[10]!, {
        [field]: values[field as keyof typeof values],
      });
      expect(() =>
        assertRenderSchemaHandoffLedger(catalog, rows, "baseline"),
      ).toThrow("ledger_prefix");
    },
  );

  it("rejects failed duplicates instead of filtering them away", () => {
    const rows = ledger();
    rows.push({ ...rows[0]!, finished: false, rolledBack: true });
    expect(() =>
      assertRenderSchemaHandoffLedger(catalog, rows, "baseline"),
    ).toThrow("ledger_count");
    rows.pop();
    rows[1] = { ...rows[0]! };
    expect(() =>
      assertRenderSchemaHandoffLedger(catalog, rows, "baseline"),
    ).toThrow("ledger_prefix");
  });

  it("never admits partial 87-89 application as either terminal phase", () => {
    for (const count of [88, 90, 91])
      for (const phase of ["baseline", "target"])
        expect(() =>
          assertRenderSchemaHandoffLedger(catalog, ledger(count), phase),
        ).toThrow();
    expect(() =>
      assertRenderSchemaHandoffLedger(catalog, ledger(), "anything"),
    ).toThrow("ledger_phase");
  });
});

describe("empty applicable pg_default_acl is distinct from unknown state", () => {
  it("accepts an observed empty catalog", () => {
    expect(() => assertDefaults([])).not.toThrow();
  });

  it.each([undefined, null, {}, { version: 1 }, { version: 2, rows: [] }])(
    "rejects missing or unsupported observation %#",
    (observation) => {
      expect(() =>
        assertEmptyApplicableRenderDefaultAcl(observation, principals),
      ).toThrow("default_acl_unknown");
    },
  );

  it("requires a nonempty and unambiguous separately reviewed principal set", () => {
    for (const names of [[], [""], ["reviewrouter", "reviewrouter"], null])
      expect(() =>
        assertEmptyApplicableRenderDefaultAcl({ version: 1, rows: [] }, names),
      ).toThrow("default_acl_unknown");
  });

  it("rejects a present empty ACL override", () => {
    expect(() => assertDefaults([{ ...defaultRow(), entries: [] }])).toThrow(
      "default_acl_policy",
    );
  });

  it("retains unrelated resolved defaults without treating them as applicable", () => {
    const row = defaultRow();
    row.schema = "unrelated";
    expect(() => assertDefaults([row])).not.toThrow();
    row.schema = "public";
    row.owner = "unrelated";
    row.entries = [];
    expect(() => assertDefaults([row])).not.toThrow();
  });

  it.each(["grantee", "grantor"])(
    "includes applicable privileges through %s even for another owner",
    (field) => {
      const row = defaultRow();
      row.owner = "unrelated";
      row.entries[0]!.grantee = "unrelated";
      row.entries[0]!.grantor = "unrelated";
      Object.assign(row.entries[0]!, { [field]: "reviewrouter" });
      expect(() => assertDefaults([row])).toThrow("default_acl_policy");
    },
  );

  it("includes PUBLIC grants and grant options", () => {
    const row = defaultRow();
    row.owner = "unrelated";
    row.entries[0] = {
      grantee: "PUBLIC",
      grantor: "unrelated",
      privilege: "EXECUTE",
      grantable: true,
    };
    expect(() => assertDefaults([row])).toThrow("default_acl_policy");
  });

  it.each(["owner", "schema", "objectType", "entries"])(
    "rejects unresolved %s even on an otherwise irrelevant row",
    (field) => {
      const row = { ...defaultRow(), schema: "unrelated", [field]: null };
      expect(() => assertDefaults([row])).toThrow("default_acl_unresolved");
    },
  );

  it.each(["grantee", "grantor", "privilege", "grantable"])(
    "rejects unresolved ACL entry %s",
    (field) => {
      const row = defaultRow();
      Object.assign(row.entries[0]!, { [field]: null });
      expect(() => assertDefaults([row])).toThrow("default_acl_unresolved");
    },
  );

  it("rejects duplicate catalog row identity", () => {
    const row = { ...defaultRow(), schema: "unrelated" };
    expect(() => assertDefaults([row, row])).toThrow("default_acl_unresolved");
  });
});
