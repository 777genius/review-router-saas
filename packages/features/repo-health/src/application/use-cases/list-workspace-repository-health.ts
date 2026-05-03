import {
  evaluateRepositoryHealth,
  type RepositoryHealthSnapshot,
} from "../../domain/repository-health";
import type { RepositoryHealthRepositoryPort } from "../ports/repository-health-repository-port";

export async function listWorkspaceRepositoryHealth(
  input: {
    readonly workspaceId: string;
    readonly expectedActionRef: string;
    readonly checkedAt?: Date;
  },
  dependencies: {
    readonly repositories: RepositoryHealthRepositoryPort;
  },
): Promise<readonly RepositoryHealthSnapshot[]> {
  const repositories =
    await dependencies.repositories.listWorkspaceHealthInputs(
      input.workspaceId,
    );
  const checkedAt = input.checkedAt ?? new Date();
  return repositories.map((repository) =>
    evaluateRepositoryHealth(
      { ...repository, expectedActionRef: input.expectedActionRef },
      checkedAt,
    ),
  );
}
