// The id of an agent's secret request (decision F53): 24 lowercase base32
// characters, its file in the account's custody and its page in the
// Launchpad (`/settings/vault/requests/<id>`). Without any import, so the
// page's routes read it as the core does.

export const secretRequestIdPattern = /^[a-z2-7]{24}$/;

export const isSecretRequestId = (value: unknown): value is string =>
  typeof value === "string" && secretRequestIdPattern.test(value);

/** The request's page in the Launchpad. */
export const secretRequestPath = (id: string): string =>
  `/settings/vault/requests/${encodeURIComponent(id)}`;
