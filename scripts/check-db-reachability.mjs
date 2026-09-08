import { promises as dns } from "node:dns";
import net from "node:net";

const raw = process.env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL;
if (!raw) {
  console.log("missing_env_var");
  process.exit(1);
}
const u = new URL(raw);
console.log(
  "host:",
  u.hostname,
  "port:",
  u.port || 5432,
  "sslmode:",
  u.searchParams.get("sslmode"),
);

try {
  const r = await dns.lookup(u.hostname);
  console.log("dns_resolved:", r.address, r.family);
} catch (e) {
  console.log("dns_failed:", e.code);
  process.exit(0);
}

await new Promise((resolve) => {
  const socket = net.createConnection({
    host: u.hostname,
    port: Number(u.port || 5432),
    timeout: 8000,
  });
  socket.on("connect", () => {
    console.log("tcp_connect: ok");
    socket.end();
    resolve();
  });
  socket.on("timeout", () => {
    console.log("tcp_connect: timeout");
    socket.destroy();
    resolve();
  });
  socket.on("error", (e) => {
    console.log("tcp_connect: error", e.code);
    resolve();
  });
});
