declare module "@modelcontextprotocol/sdk/client/index.js" {
  export class Client {
    constructor(
      identity: Readonly<{ name: string; version: string }>,
      options: Readonly<{ capabilities: Readonly<Record<string, never>> }>,
    );
    connect(transport: unknown): Promise<void>;
    callTool(
      input: Readonly<{
        name: string;
        arguments: Readonly<Record<string, unknown>>;
      }>,
    ): Promise<{ content: unknown }>;
    close(): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/client/stdio.js" {
  export class StdioClientTransport {
    constructor(
      options: Readonly<{
        command: string;
        args: string[];
        cwd: string;
        env: Record<string, string>;
        stderr: "pipe";
      }>,
    );
  }
}
