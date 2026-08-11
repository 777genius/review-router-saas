export type CodexRotatingInstallerDescriptor = {
  readonly url: string;
  readonly version: string;
  readonly sha256: string;
};

export function resolveCodexRotatingInstallerDescriptor(
  env: NodeJS.ProcessEnv,
  options?: { readonly allowLoopback?: boolean },
): CodexRotatingInstallerDescriptor;
