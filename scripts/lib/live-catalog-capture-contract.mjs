import { createHash } from "node:crypto";
import {
  fencedLiveV70V73CatalogDigestSql,
  liveV70V73CatalogDigestSha256,
} from "../../packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";

const projectionPath =
  "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";
const projectionExport = "fencedLiveV70V73CatalogDigestSql";

export function captureSuccessfulLiveCatalogContract({
  candidate,
  disposableDatabaseIdentity,
  migrationReceipt,
  runProjection,
}) {
  if (
    !/^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$/u.test(
      disposableDatabaseIdentity ?? "",
    ) ||
    migrationReceipt?.postCatalogDigest !== liveV70V73CatalogDigestSha256 ||
    typeof runProjection !== "function"
  )
    throw new Error("private_pg17_capture_catalog_digest_unproven");
  const observedCatalogDigest = String(
    runProjection(
      `\\set ON_ERROR_STOP on\nSELECT digest FROM (${fencedLiveV70V73CatalogDigestSql}) live(digest);\n`,
    ),
  ).trim();
  if (
    observedCatalogDigest !== liveV70V73CatalogDigestSha256 ||
    observedCatalogDigest !== migrationReceipt.postCatalogDigest
  )
    throw new Error("private_pg17_capture_catalog_digest_unproven");
  return Object.freeze({
    candidate,
    observation: Object.freeze({
      kind: "reviewrouter-live-catalog-successful-capture",
      version: 1,
      disposableDatabaseIdentity,
      observedCatalogDigest,
      receiptCatalogDigest: migrationReceipt.postCatalogDigest,
      projectionPath,
      projectionExport,
      projectionSqlSha256: createHash("sha256")
        .update(fencedLiveV70V73CatalogDigestSql)
        .digest("hex"),
    }),
  });
}
