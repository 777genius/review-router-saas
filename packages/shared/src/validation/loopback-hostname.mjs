/**
 * Classifies URL hostnames that normalize to the local machine.
 *
 * This module is plain ESM so operational Node scripts and TypeScript
 * packages share exactly the same hostname policy.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  const normalized = normalizeUrlHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(normalized)
  ) {
    return true;
  }

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

/** @param {string} hostname */
function normalizeUrlHostname(hostname) {
  const raw = hostname.trim().toLowerCase().replace(/\.$/u, "");
  const unbracketed =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;

  try {
    const authority = unbracketed.includes(":")
      ? `[${unbracketed}]`
      : unbracketed;
    return new URL(`http://${authority}/`).hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .replace(/\.$/u, "");
  } catch {
    return unbracketed;
  }
}
