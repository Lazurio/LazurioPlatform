import {
  type VaultHost,
  type VaultSecretAbsence,
  type VaultSecretsRefusal,
  type VaultSecretsResult,
  vaultSecrets,
  vaultSecretsAdmission,
} from "../vault/flow";

// The secrets an application declares in `lazurio.runtime` (root decision
// 0177, decision F46): its required `secrets` and its `optional_secrets`
// (root decision 0196, the Environment ceiling), names only. Before every
// start their values are read from the Environment vault and passed to the
// application's own process as `LAZURIO_RUNTIME_SECRET_<NAME>`, and to no
// other process. A required secret that cannot be read keeps the
// application from starting with a typed finding; an optional one whose
// item is not in the collection, or that a vault the application cannot use
// does not provide, is only noted. A value never reaches an error, a
// finding, a journal line or a file of this Platform.

/** Why a declared secret has no value: why the vault cannot be used for the
 * application at all, the same for each of its names, or why its own item
 * gives none. */
export const runtimeSecretReasons = [
  /** A Personalspace module: its secrets have no vault yet (DEV-6631). */
  "personalspace",
  "workstation",
  "no-vault-identity",
  "other-organization",
  "not-connected",
  "locked",
  "busy",
  "unreachable",
  "vault-failed",
  "missing",
  "ambiguous",
  "empty",
] as const satisfies readonly (
  | "personalspace"
  | VaultSecretsRefusal
  | VaultSecretAbsence
)[];
export type RuntimeSecretReason = (typeof runtimeSecretReasons)[number];

/** One declared name without a value, and why. Never a value. */
export type RuntimeSecretFinding = Readonly<{
  name: string;
  reason: RuntimeSecretReason;
}>;

/** The finding `runtime-secret-unavailable`: a declared secret the
 * application cannot start without has no value. The message is fixed and
 * never shown; `secrets` names each one with its reason. */
export class RuntimeSecretUnavailable extends Error {
  readonly secrets: readonly RuntimeSecretFinding[];
  constructor(secrets: readonly RuntimeSecretFinding[]) {
    super("Runtime secret unavailable");
    this.name = "RuntimeSecretUnavailable";
    this.secrets = Object.freeze(secrets.map((entry) => Object.freeze(entry)));
  }
}

/** Where the values come from: the Environment vault in the product, a fake
 * in tests. */
export type RuntimeSecretSource = Readonly<{
  /** Known without the vault's items: may an application of `company` read
   * from this Environment's vault at all? Null when it may. */
  admit: (company: string) => Promise<VaultSecretsRefusal | null>;
  read: (
    input: Readonly<{ company: string; names: readonly string[] }>,
  ) => Promise<VaultSecretsResult>;
}>;

export const vaultRuntimeSecretSource = (
  host: VaultHost,
): RuntimeSecretSource =>
  Object.freeze({
    admit: (company: string) => vaultSecretsAdmission(host, company),
    read: (input: Readonly<{ company: string; names: readonly string[] }>) =>
      vaultSecrets(host, input),
  });

type Declaration = Readonly<{
  company: string;
  secrets: readonly string[];
  optional_secrets: readonly string[];
}>;

type Input = Readonly<{
  runtime: Declaration;
  /** A Personalspace module: no vault serves it (decision F46). */
  personalspace: boolean;
  /** None where no vault is composed: as an Environment without one. */
  source?: RuntimeSecretSource | undefined;
}>;

export type RuntimeSecrets = Readonly<{
  /** `LAZURIO_RUNTIME_SECRET_<NAME>` of every name with a value. */
  variables: Readonly<Record<string, string>>;
  /** The optional names the application starts without, and why: their item
   * is not in the collection, or the vault cannot be used for it. */
  notProvided: readonly RuntimeSecretFinding[];
}>;

const none: RuntimeSecrets = Object.freeze({
  variables: Object.freeze({}),
  notProvided: Object.freeze([]),
});

export const runtimeSecretVariable = (name: string) =>
  `LAZURIO_RUNTIME_SECRET_${name}`;

/** Before anything is installed for a start: refuses an application whose
 * required secrets the vault cannot give it for a reason known without its
 * items (a Personalspace module, an Environment without a vault identity, an
 * application of another Organization). Optional secrets never refuse. */
export async function admitRuntimeSecrets(input: Input): Promise<void> {
  const required = input.runtime.secrets;
  if (required.length === 0) return;
  const reason: RuntimeSecretReason | null = input.personalspace
    ? "personalspace"
    : input.source === undefined
      ? "no-vault-identity"
      : await input.source
          .admit(input.runtime.company)
          .catch((): RuntimeSecretReason => "vault-failed");
  if (reason !== null)
    throw new RuntimeSecretUnavailable(
      required.map((name) => ({ name, reason })),
    );
}

/** The values of an application's declared secrets, read at this start.
 * Throws `RuntimeSecretUnavailable` naming every required name without a
 * value, and every optional one whose collection holds more than one item of
 * its name or an empty password (a misconfiguration, not an absence). */
export async function readRuntimeSecrets(
  input: Input,
): Promise<RuntimeSecrets> {
  const required = input.runtime.secrets;
  const optional = input.runtime.optional_secrets;
  if (required.length === 0 && optional.length === 0) return none;
  let unusable: RuntimeSecretReason | null = input.personalspace
    ? "personalspace"
    : input.source === undefined
      ? "no-vault-identity"
      : null;
  let result: VaultSecretsResult | null = null;
  if (unusable === null && input.source !== undefined) {
    // A throw of the source is a vault that did not answer as expected;
    // whatever it said stays there.
    result = await input.source
      .read({
        company: input.runtime.company,
        names: [...required, ...optional],
      })
      .catch(
        (): VaultSecretsResult => ({
          kind: "vault-secrets-refused",
          reason: "vault-failed",
        }),
      );
    if (result.kind === "vault-secrets-refused") unusable = result.reason;
  }
  if (unusable !== null || result?.kind !== "vault-secrets") {
    const reason = unusable ?? "vault-failed";
    if (required.length > 0)
      throw new RuntimeSecretUnavailable(
        required.map((name) => ({ name, reason })),
      );
    return Object.freeze({
      variables: Object.freeze({}),
      notProvided: Object.freeze(
        optional.map((name) => Object.freeze({ name, reason })),
      ),
    });
  }
  const variables: Record<string, string> = Object.create(null);
  const unavailable: RuntimeSecretFinding[] = [];
  const notProvided: RuntimeSecretFinding[] = [];
  for (const name of [...required, ...optional]) {
    const secret = result.secrets.get(name) ?? {
      kind: "absent" as const,
      reason: "missing" as const,
    };
    if (secret.kind === "value") {
      variables[runtimeSecretVariable(name)] = secret.value;
      continue;
    }
    const finding = Object.freeze({ name, reason: secret.reason });
    if (optional.includes(name) && secret.reason === "missing")
      notProvided.push(finding);
    else unavailable.push(finding);
  }
  if (unavailable.length > 0) throw new RuntimeSecretUnavailable(unavailable);
  return Object.freeze({
    variables: Object.freeze({ ...variables }),
    notProvided: Object.freeze(notProvided),
  });
}

/** What the Folder records of the Environment, for the catalog's check of
 * declared secrets without the vault (decision F46): a workstation (no
 * Machine binding), a Remote Environment and the Organization that owns
 * it (null for a person's), or unknown when the Folder state cannot be
 * read (the start decides then). */
export type SecretEnvironment =
  | Readonly<{ kind: "workstation" }>
  | Readonly<{ kind: "hosted"; organization: string | null }>
  | Readonly<{ kind: "unknown" }>;

/** The catalog's answer for an app's declared secrets, known without the
 * vault's items and without running anything: a required secret the vault
 * cannot give this app refuses its start (`runtime-secret-unavailable`, as
 * a preparation finding: the running app is still read and stopped); an
 * optional one is a note. Empty when the vault may serve the app, or when
 * that is only known at the start (connected, reachable, the item there). */
export async function declaredSecretsFinding(
  runtime: Declaration,
  personalspace: boolean,
  environment: () => Promise<SecretEnvironment>,
): Promise<
  Readonly<{
    reason?: "runtime-secret-unavailable";
    secrets?: readonly RuntimeSecretFinding[];
    secretsNotProvided?: readonly RuntimeSecretFinding[];
  }>
> {
  const required = runtime.secrets;
  const optional = runtime.optional_secrets;
  if (required.length === 0 && optional.length === 0) return {};
  let reason: RuntimeSecretReason | null = "personalspace";
  if (!personalspace) {
    const place = await environment();
    reason =
      place.kind === "workstation"
        ? "workstation"
        : place.kind === "hosted" &&
            (place.organization === null ||
              place.organization.toLowerCase() !==
                runtime.company.toLowerCase())
          ? "other-organization"
          : null;
  }
  if (reason === null) return {};
  const why: RuntimeSecretReason = reason;
  const findings = (
    names: readonly string[],
  ): readonly RuntimeSecretFinding[] =>
    Object.freeze(names.map((name) => Object.freeze({ name, reason: why })));
  return required.length > 0
    ? { reason: "runtime-secret-unavailable", secrets: findings(required) }
    : { secretsNotProvided: findings(optional) };
}
