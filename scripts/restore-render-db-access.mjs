import { readFileSync, existsSync } from "node:fs";

const apiKey = process.env.RENDER_API_KEY;
const dbId = process.env.RENDER_POSTGRES_ID;
const backupPath = process.env.RENDER_ALLOWLIST_BACKUP_PATH;
if (!apiKey || !dbId || !backupPath || !existsSync(backupPath)) {
  console.log("nothing_to_restore_or_missing_env");
  process.exit(0);
}
const original = JSON.parse(readFileSync(backupPath, "utf8"));
if (original.some((e) => e.cidrBlock === "0.0.0.0/0")) {
  console.log("original_list_already_had_open_access_no_restore_needed");
  process.exit(0);
}
const headers = {
  Authorization: `Bearer ${apiKey}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};
const patchRes = await globalThis.fetch(
  `https://api.render.com/v1/postgres/${dbId}`,
  {
    method: "PATCH",
    headers,
    body: JSON.stringify({ ipAllowList: original }),
  },
);
if (!patchRes.ok) {
  console.log("restore_failed:", patchRes.status, await patchRes.text());
  process.exit(1);
}
console.log("restored_original_ip_allow_list: ok, count:", original.length);
