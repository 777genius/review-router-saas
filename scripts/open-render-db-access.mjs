import { writeFileSync } from "node:fs";

const apiKey = process.env.RENDER_API_KEY;
const dbId = process.env.RENDER_POSTGRES_ID;
if (!apiKey || !dbId) {
  console.log("missing_render_env");
  process.exit(1);
}
const headers = {
  Authorization: `Bearer ${apiKey}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const getRes = await fetch(`https://api.render.com/v1/postgres/${dbId}`, {
  headers,
});
if (!getRes.ok) {
  console.log("get_failed:", getRes.status, await getRes.text());
  process.exit(1);
}
const db = await getRes.json();
const currentList = Array.isArray(db.ipAllowList) ? db.ipAllowList : [];
writeFileSync(
  process.env.RENDER_ALLOWLIST_BACKUP_PATH,
  JSON.stringify(currentList),
  "utf8",
);
console.log("current_ip_allow_list_count:", currentList.length);
console.log(
  "current_ip_allow_list_cidrs:",
  JSON.stringify(currentList.map((e) => e.cidrBlock)),
);

const alreadyOpen = currentList.some((e) => e.cidrBlock === "0.0.0.0/0");
if (alreadyOpen) {
  console.log("already_open_no_change_needed");
  process.exit(0);
}

const nextList = [
  ...currentList,
  { cidrBlock: "0.0.0.0/0", description: "temp-historical89-migration-runner" },
];
const patchRes = await fetch(`https://api.render.com/v1/postgres/${dbId}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ ipAllowList: nextList }),
});
if (!patchRes.ok) {
  console.log("patch_failed:", patchRes.status, await patchRes.text());
  process.exit(1);
}
console.log("temporarily_opened: ok");
