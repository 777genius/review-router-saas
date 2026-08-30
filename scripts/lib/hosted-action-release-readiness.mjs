export function validateHostedActionReleaseReadiness(source) {
  const read = (name) => String(source[name] ?? "").trim();
  const errors = [];
  const tag = read("REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG");
  const sha = read("REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA").toLowerCase();
  const digest = read(
    "REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256",
  ).toLowerCase();
  if (!/^v[1-9][0-9]*\.[0-9]+\.[0-9]+$/u.test(tag)) {
    errors.push(
      "REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG must be an immutable vN.N.N tag.",
    );
  }
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    errors.push(
      "REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA must be a lowercase 40-character commit SHA.",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    errors.push(
      "REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256 must be a lowercase 64-character SHA-256.",
    );
  }
  if (
    read("REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF") !==
    `777genius/review-router@${sha}`
  ) {
    errors.push(
      "The hosted-pool Action SHA must equal REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF.",
    );
  }
  return errors;
}
