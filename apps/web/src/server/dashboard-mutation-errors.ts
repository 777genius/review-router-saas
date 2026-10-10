/** A completed dashboard authority decision, before configuration writer entry.
 * Keep the established messages for callers that render those error codes.
 * Transport errors and incomplete authority facts must never use this type.
 */
export class DashboardMutationRefusedError extends Error {
  constructor(
    message:
      | "dashboard_mutations_disabled"
      | "dashboard_mutation_requires_sign_in"
      | "repository_mutation_forbidden"
      | "repository_config_mutation_forbidden",
  ) {
    super(message);
    this.name = "DashboardMutationRefusedError";
  }
}
