import { randomUUID } from "node:crypto";
import { managedPg17Fixture, waitFor } from "./render-managed-pg17-fixture";

// One psql process / authenticated backend per client, never SET ROLE.
// Transport only: every SQL statement and snapshot operation reaches PostgreSQL.
// This bounded adapter accepts the verifier's single-column text/JSON results.
export function persistentFixtureClient(
  pg: ReturnType<typeof managedPg17Fixture>,
  database: string,
  role: string,
) {
  const session = pg.session(database, role);
  const queries: string[] = [];
  let busy = false;
  return {
    connectionParameters: { host: "127.0.0.1", port: 5432, database },
    queries,
    async query(sql: string) {
      if (busy) throw new Error("fixture_concurrent_query");
      busy = true;
      const offset = session.stdout().length;
      const errorOffset = session.stderr().length;
      const marker = `rr_${randomUUID().replaceAll("-", "")}`;
      try {
        queries.push(sql);
        session.write(
          `\\set ON_ERROR_STOP off\n${sql}\n\\echo ${marker} :ERROR :SQLSTATE\n`,
        );
        await waitFor(() => {
          if (session.closedResult()) throw new Error(session.stderr());
          return (
            session.stdout().slice(offset).includes(`${marker} `) &&
            session.stdout().slice(offset).endsWith("\n")
          );
        });
        const [raw, status] = session
          .stdout()
          .slice(offset)
          .split(`${marker} `);
        if (status.trim() !== "false 00000")
          throw new Error(
            `postgres:${status.trim()}:${session.stderr().slice(errorOffset)}`,
          );
        const output = raw.trim();
        return {
          rows: output
            ? output.split("\n").map((text) => {
                let value: unknown = text;
                if (text === "t" || text === "f") value = text === "t";
                else {
                  try {
                    value = JSON.parse(text);
                  } catch {
                    // Preserve plain PostgreSQL text when it is not JSON.
                  }
                }
                return { value };
              })
            : [],
        };
      } finally {
        busy = false;
      }
    },
    async end() {
      session.end("\\q\n");
      try {
        await session.result;
      } finally {
        await session.terminateAndWait();
      }
    },
  };
}
