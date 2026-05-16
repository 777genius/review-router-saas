export type MemoryActorKind = "github_user" | "workspace_user" | "system";

export type MemoryActor = {
  readonly kind: MemoryActorKind;
  readonly id: string;
  readonly githubUserId: string | null;
  readonly login: string | null;
};

export function memoryActorRef(actor: MemoryActor): string {
  return `${actor.kind}:${actor.id}`;
}
