import type { ProviderSecretScope } from "@reviewrouter/features-provider-setup";
import type { ReviewRouterDiscussionMode } from "@reviewrouter/features-workflow-provisioning";
import {
  parseReviewConfigurationStrict,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import type { MemoryScope } from "@reviewrouter/features-memory";
import {
  getProviderSecretNames,
  providerAuthModeBelongsToKind,
  providerAuthModeSchema,
  providerKindForAuthMode,
  providerKindSchema,
  type ProviderAuthMode,
  type ProviderKind,
} from "@reviewrouter/features-review-providers";

export function readReviewConfigurationForm(
  formData: FormData,
): ReviewConfiguration {
  const providerCount = readFormNumber(formData, "providerCount");
  if (!Number.isInteger(providerCount) || providerCount < 1) {
    throw new Error("invalid_form_value:providerCount");
  }
  const providers = Array.from({ length: providerCount }, (_, index) => {
    const authMode = readProviderAuthMode(
      formData,
      `providerAuthMode.${index}`,
    );

    return {
      kind: providerKindForAuthMode(authMode),
      authMode,
      model: readFormString(formData, `providerModel.${index}`),
      reasoningEffort: readFormString(
        formData,
        `providerReasoningEffort.${index}`,
      ) as ReviewConfiguration["provider"]["reasoningEffort"],
      agenticContext: readFormBoolean(
        formData,
        `providerAgenticContext.${index}`,
      ),
      fastMode: readFormBoolean(formData, `providerFastMode.${index}`),
      requiredHealthy:
        readOptionalFormBoolean(formData, `providerRequiredHealthy.${index}`) ??
        index === 0,
    } satisfies ReviewConfiguration["provider"];
  });

  return parseReviewConfigurationStrict({
    schemaVersion: 2,
    providers,
    provider: providers[0]!,
    execution: {
      providerLimit: providers.length,
      providerMaxParallel: readFormNumber(formData, "providerMaxParallel"),
      inlineMinAgreement: readFormNumber(formData, "inlineMinAgreement"),
    },
    blockingPolicy: {
      failOnSeverity: readFormString(
        formData,
        "failOnSeverity",
      ) as ReviewConfiguration["blockingPolicy"]["failOnSeverity"],
    },
    limits: {
      inlineMaxComments: readFormNumber(formData, "inlineMaxComments"),
      targetTokensPerBatch: readFormNumber(formData, "targetTokensPerBatch"),
    },
    reviewLanguage:
      readOptionalFormString(formData, "reviewLanguage") ?? undefined,
  });
}

export function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing_form_value:${key}`);
  }
  return value;
}

export function readOptionalFormString(
  formData: FormData,
  key: string,
): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readOptionalPositiveInteger(
  formData: FormData,
  key: string,
): number | undefined {
  const value = readOptionalFormString(formData, key);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid_form_value:${key}`);
  }
  return parsed;
}

export function readMemoryScope(formData: FormData): MemoryScope {
  const value = readFormString(formData, "scope");
  if (
    value === "repository" ||
    value === "workspace" ||
    value === "user_prefs"
  ) {
    return value;
  }
  throw new Error("invalid_form_value:memoryScope");
}

export function readOptionalEditedMemory(formData: FormData): {
  readonly optionalEditedBody?: string;
  readonly optionalScope?: MemoryScope;
} {
  const body = readOptionalFormString(formData, "body");
  const rawScope = readOptionalFormString(formData, "scope");
  const optionalScope =
    rawScope === null ? undefined : readMemoryScopeValue(rawScope);
  return {
    ...(body === null ? {} : { optionalEditedBody: body }),
    ...(optionalScope === undefined ? {} : { optionalScope }),
  };
}

export function readWorkflowStyle(formData: FormData): "reusable" | "explicit" {
  const value = formData.get("workflowStyle");
  return value === "explicit" ? "explicit" : "reusable";
}

export function readReviewDiscussionMode(
  formData: FormData,
): ReviewRouterDiscussionMode {
  const value = formData.get("reviewDiscussionMode");
  return value === "suggest" ? "suggest" : "off";
}

export function readProviderSetupSelection(formData: FormData): {
  readonly providerKind: ProviderKind;
  readonly authMode: ProviderAuthMode;
} {
  const providerKind = providerKindSchema.safeParse(
    readFormString(formData, "providerKind"),
  );
  const authMode = providerAuthModeSchema.safeParse(
    readFormString(formData, "authMode"),
  );

  if (
    providerKind.success &&
    authMode.success &&
    providerAuthModeBelongsToKind(authMode.data, providerKind.data)
  ) {
    return normalizeProductionProviderSetupSelection({
      providerKind: providerKind.data,
      authMode: authMode.data,
    });
  }

  throw new Error("invalid_form_value:providerSetup");
}

function normalizeProductionProviderSetupSelection(input: {
  readonly providerKind: ProviderKind;
  readonly authMode: ProviderAuthMode;
}): {
  readonly providerKind: ProviderKind;
  readonly authMode: ProviderAuthMode;
} {
  if (
    input.providerKind === "codex" &&
    (input.authMode === "codex_subscription_oauth" ||
      input.authMode === "codex_openai_api_key")
  ) {
    return {
      providerKind: "codex",
      authMode: "codex_subscription_oauth_rotating",
    };
  }

  return input;
}

export function readProviderSecretScope(
  formData: FormData,
): ProviderSecretScope {
  const value = readFormString(formData, "secretScope");
  if (
    value === "repository" ||
    value === "organization_selected_repositories" ||
    value === "organization_private_repositories" ||
    value === "organization_all_repositories"
  ) {
    return value;
  }

  throw new Error("invalid_form_value:secretScope");
}

export function readProviderSetupConfirmationMode(
  formData: FormData,
): "verified" | "manual" {
  const value = formData.get("confirmationMode");
  if (value === null) return "verified";
  if (value === "verified" || value === "manual") return value;

  throw new Error("invalid_form_value:confirmationMode");
}

export function providerSecretNamesForAuthMode(
  authMode: ProviderAuthMode,
): readonly string[] {
  return getProviderSecretNames(authMode);
}

export function providerSetupStateForSecretCheckError(
  error: unknown,
): "missing" | "stale_or_invalid" | "unknown" | null {
  if (!(error instanceof Error)) return null;

  switch (error.message) {
    case "provider_secret_not_found":
      return "missing";
    case "provider_secret_not_available_to_repository":
      return "stale_or_invalid";
    case "provider_secret_check_permission_required":
      return "unknown";
    case "repository_not_visible_to_github_app":
      return "unknown";
    default:
      return null;
  }
}

export function providerSecretAvailabilityStatusForError(
  error: unknown,
): "not_available_to_repository" | "missing" | "permission_required" | null {
  if (!(error instanceof Error)) return null;

  switch (error.message) {
    case "provider_secret_not_found":
      return "missing";
    case "provider_secret_not_available_to_repository":
      return "not_available_to_repository";
    case "provider_secret_check_permission_required":
    case "repository_not_visible_to_github_app":
      return "permission_required";
    default:
      return null;
  }
}

function readMemoryScopeValue(value: string): MemoryScope {
  if (
    value === "repository" ||
    value === "workspace" ||
    value === "user_prefs"
  ) {
    return value;
  }
  throw new Error("invalid_form_value:memoryScope");
}

function readProviderAuthMode(
  formData: FormData,
  key: string,
): ProviderAuthMode {
  const authMode = providerAuthModeSchema.safeParse(
    readFormString(formData, key),
  );
  if (!authMode.success) {
    throw new Error(`invalid_form_value:${key}`);
  }
  return authMode.data;
}

function readFormNumber(formData: FormData, key: string): number {
  const value = Number(readFormString(formData, key));
  if (!Number.isFinite(value)) {
    throw new Error(`invalid_form_number:${key}`);
  }
  return value;
}

function readFormBoolean(formData: FormData, key: string): boolean {
  const value = readFormString(formData, key);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`invalid_form_boolean:${key}`);
}

function readOptionalFormBoolean(
  formData: FormData,
  key: string,
): boolean | undefined {
  const value = readOptionalFormString(formData, key);
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid_form_boolean:${key}`);
}
