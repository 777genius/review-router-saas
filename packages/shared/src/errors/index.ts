export class ReviewRouterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ReviewRouterError";
  }
}

export class ConfigurationError extends ReviewRouterError {
  constructor(message: string) {
    super(message, "configuration_error", false);
    this.name = "ConfigurationError";
  }
}
