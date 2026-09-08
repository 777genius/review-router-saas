const apiKey = process.env.RENDER_API_KEY;
const dbId = "dpg-da32ipmk1f9s73dttm90-a";
const headers = {
  Authorization: `Bearer ${apiKey}`,
  Accept: "application/json",
};

const res = await globalThis.fetch(
  `https://api.render.com/v1/postgres/${dbId}/connection-info`,
  { headers },
);
console.log("status:", res.status);
if (!res.ok) {
  console.log("body:", await res.text());
  process.exit(0);
}
const data = await res.json();
console.log("keys:", Object.keys(data));
// Never print the actual connection string - only which user it authenticates as.
for (const key of Object.keys(data)) {
  const value = data[key];
  if (typeof value === "string" && value.includes("://")) {
    try {
      const u = new URL(value);
      console.log(`${key}: user=${u.username} host=${u.hostname}`);
    } catch {
      console.log(`${key}: (unparseable)`);
    }
  } else {
    console.log(`${key}:`, typeof value);
  }
}
