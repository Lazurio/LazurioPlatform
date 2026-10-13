import { expect, test } from "bun:test";
import {
  admitRuntimeSecrets,
  declaredSecretsFinding,
  type RuntimeSecretSource,
  RuntimeSecretUnavailable,
  readRuntimeSecrets,
} from "../src/modules/runtime-secrets";
import type {
  SecretApplication,
  VaultSecret,
  VaultSecretsRefusal,
  VaultSecretsResult,
} from "../src/vault/flow";

// What an application's declared runtime secrets become at its start
// (decision F46 as F52 amends it, root decisions 0177 and 0196): the values
// of its required and optional names as `LAZURIO_RUNTIME_SECRET_<NAME>`, a
// refusal naming every required name without a value, and a note for the
// optional ones it starts without. Which applications the vault serves is
// the vault's to say: it is asked with the application's Organization and
// whether it is a Personalspace module. The source is a fake; every name and
// value is invented.

const value = "fake-runtime-secret-value-4d2a";

const runtime = (
  secrets: readonly string[],
  optional: readonly string[] = [],
  company = "example",
) => ({ company, secrets, optional_secrets: optional });

/** A source that holds `values` and answers `refused` when given. */
function source(
  values: Readonly<Record<string, VaultSecret>>,
  refused?: VaultSecretsRefusal,
) {
  const reads: (readonly string[])[] = [];
  const admitted: SecretApplication[] = [];
  const asked: SecretApplication[] = [];
  const fake: RuntimeSecretSource = {
    admit: async (application) => {
      admitted.push(application);
      return refused === "workstation" ||
        refused === "no-vault-identity" ||
        refused === "other-organization" ||
        refused === "personalspace" ||
        refused === "personal-environment"
        ? refused
        : null;
    },
    read: async ({
      company,
      personalspace,
      names,
    }): Promise<VaultSecretsResult> => {
      reads.push(names);
      asked.push({ company, personalspace });
      if (refused !== undefined)
        return { kind: "vault-secrets-refused", reason: refused };
      return {
        kind: "vault-secrets",
        secrets: new Map(
          names.map((name) => [
            name,
            values[name] ?? { kind: "absent", reason: "missing" },
          ]),
        ),
      };
    },
  };
  return { fake, reads, admitted, asked };
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof RuntimeSecretUnavailable)) throw error;
    // Neither the message nor anything the finding carries holds a value.
    expect(error.message).toBe("Runtime secret unavailable");
    expect(`${error}`).not.toContain(value);
    expect(JSON.stringify(error.secrets)).not.toContain(value);
    expect(error.stack ?? "").not.toContain(value);
    return error.secrets;
  }
  throw new Error("Expected a refusal");
}

test("declared names with a value become LAZURIO_RUNTIME_SECRET_<NAME>; nothing declared reads nothing", async () => {
  const { fake, reads } = source({
    EXTERNAL_API_KEY: { kind: "value", value },
    OPTIONAL_KEY: { kind: "value", value: "fake-optional-value" },
  });
  expect(
    await readRuntimeSecrets({
      runtime: runtime(["EXTERNAL_API_KEY"], ["OPTIONAL_KEY"]),
      personalspace: false,
      source: fake,
    }),
  ).toEqual({
    variables: {
      LAZURIO_RUNTIME_SECRET_EXTERNAL_API_KEY: value,
      LAZURIO_RUNTIME_SECRET_OPTIONAL_KEY: "fake-optional-value",
    },
    notProvided: [],
  });
  expect(reads).toEqual([["EXTERNAL_API_KEY", "OPTIONAL_KEY"]]);
  // No declaration: the vault is not asked at all.
  expect(
    await readRuntimeSecrets({
      runtime: runtime([]),
      personalspace: true,
      source: fake,
    }),
  ).toEqual({ variables: {}, notProvided: [] });
  await admitRuntimeSecrets({
    runtime: runtime([]),
    personalspace: true,
  });
  expect(reads.length).toBe(1);
});

test("a required name that is missing, held twice or empty refuses the start, naming each one and why", async () => {
  const { fake } = source({
    PRESENT: { kind: "value", value },
    TWICE: { kind: "absent", reason: "ambiguous" },
    EMPTY: { kind: "absent", reason: "empty" },
  });
  expect(
    await refusal(
      readRuntimeSecrets({
        runtime: runtime(["PRESENT", "MISSING", "TWICE", "EMPTY"]),
        personalspace: false,
        source: fake,
      }),
    ),
  ).toEqual([
    { name: "MISSING", reason: "missing" },
    { name: "TWICE", reason: "ambiguous" },
    { name: "EMPTY", reason: "empty" },
  ]);
});

test("an optional name without an item is not set and only noted; held twice or empty it refuses like a required one (root decision 0196)", async () => {
  const { fake } = source({ PRESENT: { kind: "value", value } });
  expect(
    await readRuntimeSecrets({
      runtime: runtime(["PRESENT"], ["OPTIONAL_KEY"]),
      personalspace: false,
      source: fake,
    }),
  ).toEqual({
    variables: { LAZURIO_RUNTIME_SECRET_PRESENT: value },
    notProvided: [{ name: "OPTIONAL_KEY", reason: "missing" }],
  });
  for (const reason of ["ambiguous", "empty"] as const) {
    const { fake: misconfigured } = source({
      OPTIONAL_KEY: { kind: "absent", reason },
    });
    expect(
      await refusal(
        readRuntimeSecrets({
          runtime: runtime([], ["OPTIONAL_KEY"]),
          personalspace: false,
          source: misconfigured,
        }),
      ),
    ).toEqual([{ name: "OPTIONAL_KEY", reason }]);
  }
});

test("a vault the app cannot use refuses every required name, and with only optional names the app starts without them", async () => {
  for (const reason of [
    "workstation",
    "no-vault-identity",
    "other-organization",
    "personalspace",
    "personal-environment",
    "not-connected",
    "locked",
    "busy",
    "unreachable",
    "vault-failed",
  ] as const) {
    const { fake } = source({}, reason);
    expect(
      await refusal(
        readRuntimeSecrets({
          runtime: runtime(["EXTERNAL_API_KEY"], ["OPTIONAL_KEY"]),
          personalspace: false,
          source: fake,
        }),
      ),
    ).toEqual([{ name: "EXTERNAL_API_KEY", reason }]);
    expect(
      await readRuntimeSecrets({
        runtime: runtime([], ["OPTIONAL_KEY", "SECOND_KEY"]),
        personalspace: false,
        source: fake,
      }),
    ).toEqual({
      variables: {},
      notProvided: [
        { name: "OPTIONAL_KEY", reason },
        { name: "SECOND_KEY", reason },
      ],
    });
  }
  // A source that throws is a vault that failed; nothing it said leaks.
  const throwing: RuntimeSecretSource = {
    admit: async () => {
      throw new Error(`bw said ${value}`);
    },
    read: async () => {
      throw new Error(`bw said ${value}`);
    },
  };
  expect(
    await refusal(
      readRuntimeSecrets({
        runtime: runtime(["EXTERNAL_API_KEY"]),
        personalspace: false,
        source: throwing,
      }),
    ),
  ).toEqual([{ name: "EXTERNAL_API_KEY", reason: "vault-failed" }]);
  expect(
    await refusal(
      admitRuntimeSecrets({
        runtime: runtime(["EXTERNAL_API_KEY"]),
        personalspace: false,
        source: throwing,
      }),
    ),
  ).toEqual([{ name: "EXTERNAL_API_KEY", reason: "vault-failed" }]);
});

test("the vault is asked with the application's Organization and kind, and decides; an Environment without a composed vault reads nothing", async () => {
  // A personal Environment's vault serves a Personalspace module.
  const served = source({ EXTERNAL_API_KEY: { kind: "value", value } });
  const personalspace = runtime(["EXTERNAL_API_KEY"], [], "personalspace");
  await admitRuntimeSecrets({
    runtime: personalspace,
    personalspace: true,
    source: served.fake,
  });
  expect(
    await readRuntimeSecrets({
      runtime: personalspace,
      personalspace: true,
      source: served.fake,
    }),
  ).toEqual({
    variables: { LAZURIO_RUNTIME_SECRET_EXTERNAL_API_KEY: value },
    notProvided: [],
  });
  expect(served.admitted).toEqual([
    { company: "personalspace", personalspace: true },
  ]);
  expect(served.asked).toEqual([
    { company: "personalspace", personalspace: true },
  ]);
  // A work Environment's vault refuses it, before anything is installed.
  const refused = source({}, "personalspace");
  expect(
    await refusal(
      admitRuntimeSecrets({
        runtime: personalspace,
        personalspace: true,
        source: refused.fake,
      }),
    ),
  ).toEqual([{ name: "EXTERNAL_API_KEY", reason: "personalspace" }]);
  expect(
    await readRuntimeSecrets({
      runtime: runtime([], ["OPTIONAL_KEY"], "personalspace"),
      personalspace: true,
      source: refused.fake,
    }),
  ).toEqual({
    variables: {},
    notProvided: [{ name: "OPTIONAL_KEY", reason: "personalspace" }],
  });
  // No vault composed: nothing is asked.
  expect(
    await refusal(
      readRuntimeSecrets({
        runtime: runtime(["EXTERNAL_API_KEY"]),
        personalspace: false,
      }),
    ),
  ).toEqual([{ name: "EXTERNAL_API_KEY", reason: "no-vault-identity" }]);
  // The admission asks about the application only, never its items.
  const other = source({}, "other-organization");
  expect(
    await refusal(
      admitRuntimeSecrets({
        runtime: runtime(["EXTERNAL_API_KEY"], [], "gamma"),
        personalspace: false,
        source: other.fake,
      }),
    ),
  ).toEqual([{ name: "EXTERNAL_API_KEY", reason: "other-organization" }]);
  expect(other.admitted).toEqual([{ company: "gamma", personalspace: false }]);
  expect(other.reads).toEqual([]);
  // Optional names never refuse the admission.
  await admitRuntimeSecrets({
    runtime: runtime([], ["OPTIONAL_KEY"]),
    personalspace: true,
  });
});

test("the catalog's check knows, without the vault, a workstation and the applications a work or a personal Environment does not serve", async () => {
  type Place = Parameters<typeof declaredSecretsFinding>[2];
  const workstation: Place = async () => ({ kind: "workstation" });
  const owned: Place = async () => ({
    kind: "hosted",
    organization: "example",
  });
  const personal: Place = async () => ({ kind: "hosted", organization: null });
  const unknown: Place = async () => ({ kind: "unknown" });
  const required = runtime(["EXTERNAL_API_KEY"], ["OPTIONAL_KEY"], "Example");
  expect(await declaredSecretsFinding(required, false, owned)).toEqual({});
  expect(await declaredSecretsFinding(required, false, unknown)).toEqual({});
  expect(await declaredSecretsFinding(required, false, workstation)).toEqual({
    reason: "runtime-secret-unavailable",
    secrets: [{ name: "EXTERNAL_API_KEY", reason: "workstation" }],
  });
  expect(
    await declaredSecretsFinding(
      runtime(["EXTERNAL_API_KEY"], [], "gamma"),
      false,
      owned,
    ),
  ).toEqual({
    reason: "runtime-secret-unavailable",
    secrets: [{ name: "EXTERNAL_API_KEY", reason: "other-organization" }],
  });
  // A personal Environment's vault serves the Personalspace's modules, not
  // an Organization's app (root decision 0198 point 4).
  expect(await declaredSecretsFinding(required, false, personal)).toEqual({
    reason: "runtime-secret-unavailable",
    secrets: [{ name: "EXTERNAL_API_KEY", reason: "personal-environment" }],
  });
  expect(await declaredSecretsFinding(required, true, personal)).toEqual({});
  // A work Environment's vault does not serve a Personalspace module.
  expect(await declaredSecretsFinding(required, true, owned)).toEqual({
    reason: "runtime-secret-unavailable",
    secrets: [{ name: "EXTERNAL_API_KEY", reason: "personalspace" }],
  });
  expect(await declaredSecretsFinding(required, true, workstation)).toEqual({
    reason: "runtime-secret-unavailable",
    secrets: [{ name: "EXTERNAL_API_KEY", reason: "workstation" }],
  });
  // Unknown: the start decides.
  expect(await declaredSecretsFinding(required, true, unknown)).toEqual({});
  // Only optional names: a note, never a refusal.
  expect(
    await declaredSecretsFinding(runtime([], ["OPTIONAL_KEY"]), true, owned),
  ).toEqual({
    secretsNotProvided: [{ name: "OPTIONAL_KEY", reason: "personalspace" }],
  });
  expect(await declaredSecretsFinding(runtime([]), true, owned)).toEqual({});
});
