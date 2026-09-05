import { createHash } from "node:crypto";

/** Stateful GitHub boundary: refs are mutable; commit contents and PR numbers aren't. */
export class WorkflowGitHubFixture {
  readonly branches = new Map<string, string>([["main", "0".repeat(40)]]);
  readonly commits = new Map<string, ReadonlyMap<string, string>>([
    ["0".repeat(40), new Map()],
  ]);
  readonly pullRequests = new Map<
    number,
    { head: { sha: string }; branch: string }
  >();
  beforeWrite: ((branch: string) => Promise<void>) | undefined;

  async request(
    route: string,
    parameters: Record<string, unknown> = {},
  ): Promise<{ data: unknown }> {
    const branch = String(parameters.branch ?? parameters.ref ?? "").replace(
      /^(?:refs\/)?heads\//,
      "",
    );
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      const sha = this.branches.get(branch);
      if (!sha) throw Object.assign(new Error("not found"), { status: 404 });
      return { data: { object: { sha } } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/refs") {
      if (
        [...this.branches.keys()].some(
          (existing) =>
            existing === branch ||
            existing.startsWith(`${branch}/`) ||
            branch.startsWith(`${existing}/`),
        )
      )
        throw Object.assign(new Error("exists"), { status: 422 });
      this.branches.set(branch, String(parameters.sha));
      return { data: {} };
    }
    if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
      if (!this.branches.has(branch))
        throw Object.assign(new Error("reference does not exist"), {
          status: 422,
        });
      this.branches.set(branch, String(parameters.sha));
      return { data: {} };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      const sha = this.branches.get(branch) ?? branch;
      const content = this.commits.get(sha)?.get(String(parameters.path));
      if (content === undefined)
        throw Object.assign(new Error("not found"), { status: 404 });
      return {
        data: {
          type: "file",
          sha: createHash("sha1").update(content).digest("hex"),
          content: Buffer.from(content).toString("base64"),
        },
      };
    }
    if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
      await this.beforeWrite?.(branch);
      const parent = this.branches.get(branch)!;
      const files = new Map(this.commits.get(parent));
      files.set(
        String(parameters.path),
        Buffer.from(String(parameters.content), "base64").toString(),
      );
      const sha = createHash("sha1")
        .update(JSON.stringify([parent, [...files]]))
        .digest("hex");
      this.commits.set(sha, files);
      this.branches.set(branch, sha);
      return { data: { commit: { sha } } };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls") return { data: [] };
    if (route === "POST /repos/{owner}/{repo}/pulls") {
      const number = 7 + this.pullRequests.size;
      const pr = {
        branch: String(parameters.head),
        head: { sha: this.branches.get(String(parameters.head))! },
      };
      this.pullRequests.set(number, pr);
      return {
        data: {
          ...pr,
          number,
          html_url: `https://github.com/acme/widget/pull/${number}`,
        },
      };
    }
    throw new Error(`unexpected_route:${route}`);
  }
}
