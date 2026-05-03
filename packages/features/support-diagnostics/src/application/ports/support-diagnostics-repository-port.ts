import type { SupportDiagnosticsInput } from "../../domain/support-diagnostics";

export interface SupportDiagnosticsRepositoryPort {
  getWorkspaceDiagnosticsInput(
    workspaceId: string,
  ): Promise<SupportDiagnosticsInput | null>;
}
