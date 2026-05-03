import type { ActionSessionClaims } from "../../domain/action-control-plane.js";

export interface ActionSessionTokenServicePort {
  sign(input: {
    readonly claims: ActionSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }): Promise<{ readonly token: string; readonly expiresAt: Date }>;

  verify(input: {
    readonly token: string;
    readonly now: Date;
  }): Promise<ActionSessionClaims>;
}
