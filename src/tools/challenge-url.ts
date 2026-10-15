// Only an https URL on exactly the expected host becomes a challenge of a
// curated sign-in (decision F19): no other scheme, port or credentials.
export function challengeUrl(
  candidate: string,
  hosts: readonly string[],
): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password)
      return undefined;
    if (url.port !== "" || !hosts.includes(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
