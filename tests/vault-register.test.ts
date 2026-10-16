import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { bitwardenRegionOf, bitwardenRegions } from "../src/vault/endpoints";
import * as vr from "../src/vault/register";

// The registration of an Environment vault account (decision F43): the
// crypto against Bitwarden's own vectors and round trips, and the requests
// against a scripted vault: exact bodies, Vaultwarden's refusals, 204, a
// text/plain token and 429. No network.

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const server = "https://vaultwarden.example.lazurio.io";
const email = "vaultwarden@example.lazurio.io";

describe("Bitwarden vectors", () => {
  // bitwarden/clients libs/legacy-crypto/src/services/web-crypto-function.service.spec.ts
  test("PBKDF2-SHA256(password, user@example.com, 5000)", async () => {
    expect(
      b64(
        await vr.deriveMasterKey(
          "password",
          "user@example.com",
          vr.pbkdf2Kdf(5000),
        ),
      ),
    ).toBe("pj9prw/OHPleXI6bRdmlaD+saJS4awrMiQsQiDjeu2I=");
  });

  // bitwarden/sdk-internal crates/bitwarden-crypto/src/keys/master_key.rs test_password_hash_pbkdf2
  test("master password hash, salt trimmed and lowercased", async () => {
    for (const salt of [
      "test@bitwarden.com",
      "TEST@bitwarden.com",
      " test@bitwarden.com",
    ]) {
      const masterKey = await vr.deriveMasterKey(
        "asdfasdf",
        salt,
        vr.pbkdf2Kdf(100_000),
      );
      expect(await vr.makeMasterPasswordHash(masterKey, "asdfasdf")).toBe(
        "wmyadRMyBZOH7P/a/ucTCbSghKgdzDpPqUnu/DAVtSw=",
      );
    }
  });

  // bitwarden/sdk-internal crates/bitwarden-crypto/src/keys/master_key.rs,
  // the Argon2id master key: the salt is the SHA-256 of the e-mail (here
  // "test_key"), the memory in MiB, 32 bytes.
  test("Argon2id(password, SHA-256(test_key), 4 passes, 32 MiB, parallelism 2)", async () => {
    expect([
      ...(await vr.deriveMasterKey("67t9b5g67$%Dh89n", "test_key", {
        type: vr.KDF_ARGON2ID,
        iterations: 4,
        memory: 32,
        parallelism: 2,
      })),
    ]).toEqual([
      207, 240, 225, 177, 162, 19, 163, 76, 98, 106, 179, 175, 224, 9, 17, 240,
      20, 147, 237, 47, 246, 150, 141, 184, 62, 225, 131, 242, 51, 53, 225, 242,
    ]);
  });

  // bitwarden/sdk-internal crates/bitwarden-crypto/src/keys/utils.rs test_stretch_kdf_key
  test("stretched master key (HKDF-Expand enc/mac)", async () => {
    const masterKey = new Uint8Array([
      31, 79, 104, 226, 150, 71, 177, 90, 194, 80, 172, 209, 17, 129, 132, 81,
      138, 167, 69, 167, 254, 149, 2, 27, 39, 197, 64, 42, 22, 195, 86, 75,
    ]);
    const stretched = await vr.stretchMasterKey(masterKey);
    expect([...stretched.enc]).toEqual([
      111, 31, 178, 45, 238, 152, 37, 114, 143, 215, 124, 83, 135, 173, 195, 23,
      142, 134, 120, 249, 61, 132, 163, 182, 113, 197, 189, 204, 188, 21, 237,
      96,
    ]);
    expect([...stretched.mac]).toEqual([
      221, 127, 206, 234, 101, 27, 202, 38, 86, 52, 34, 28, 78, 28, 185, 16, 48,
      61, 127, 166, 209, 247, 194, 87, 232, 26, 48, 85, 193, 249, 179, 155,
    ]);
  });
});

describe("round trips", () => {
  test("EncString type 2 decrypts and rejects tampering", async () => {
    const key = vr.symmetricKey(vr.randomBytes(64));
    const encString = await vr.encrypt("Environmenty/Osobní · example", key);
    expect(encString).toMatch(
      /^2\.[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/,
    );
    expect(new TextDecoder().decode(await vr.decrypt(encString, key))).toBe(
      "Environmenty/Osobní · example",
    );
    const [head, ct, mac] = encString.split("|") as [string, string, string];
    const tampered = `${head}|${ct.slice(0, -4)}AAA=|${mac}`;
    await expect(vr.decrypt(tampered, key)).rejects.toThrow("MAC mismatch");
  });

  test("account keys unwrap the way bw unlock does", async () => {
    const keys = await vr.makeAccountKeys(
      " Vaultwarden@Example.lazurio.io ",
      "throwaway-unit-test",
    );
    const masterKey = await vr.deriveMasterKey("throwaway-unit-test", email);
    const userKey = await vr.decrypt(
      keys.protectedUserKey,
      await vr.stretchMasterKey(masterKey),
    );
    expect(userKey.length).toBe(64);
    const privateKey = await vr.decrypt(
      keys.encryptedPrivateKey,
      vr.symmetricKey(userKey),
    );
    const organizationKey = vr.randomBytes(64);
    expect([
      ...(await vr.rsaDecrypt(
        privateKey,
        await vr.rsaEncrypt(keys.publicKey, organizationKey),
      )),
    ]).toEqual([...organizationKey]);
    expect(keys.kdf).toEqual({
      kdfType: 0,
      iterations: 600_000,
      memory: null,
      parallelism: null,
    });
    // The hash the vault receives is the one a login derives again.
    expect(keys.masterPasswordHash).toBe(
      await vr.makeMasterPasswordHash(masterKey, "throwaway-unit-test"),
    );
  });

  test("a generated master password is 32 random bytes on one line", () => {
    const first = vr.generateMasterPassword();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(vr.generateMasterPassword()).not.toBe(first);
  });

  // A personal Environment's agents' account (root decision 0203 point 7):
  // its keys as Bitwarden keeps them, made here from a fixed password,
  // e-mail, KDF and user key, open with the KDF its vault reports.
  test("an entered account unlocks with PBKDF2 or Argon2id, and refuses a wrong password or keys of another form", async () => {
    const password = "Correct horse battery staple 7";
    const email = "  Agents.Example+Lazurio@Example.COM ";
    const userKey = new Uint8Array(64).map((_, index) => (index * 7 + 1) % 256);
    for (const kdf of [
      vr.pbkdf2Kdf(5_000),
      {
        type: vr.KDF_ARGON2ID,
        iterations: 2,
        memory: 16,
        parallelism: 1,
      } as const,
    ]) {
      const masterKey = await vr.deriveMasterKey(password, email, kdf);
      // Deterministic: the same password, e-mail and KDF give the same key,
      // whatever the case and white space of the e-mail.
      expect([
        ...(await vr.deriveMasterKey(
          password,
          "agents.example+lazurio@example.com",
          kdf,
        )),
      ]).toEqual([...masterKey]);
      const protectedUserKey = await vr.encrypt(
        userKey,
        await vr.stretchMasterKey(masterKey),
      );
      const pair = await vr.makeKeyPair(vr.symmetricKey(userKey));
      const keys = {
        email,
        protectedUserKey,
        encryptedPrivateKey: pair.encryptedPrivateKey,
        kdf,
      };
      const privateKey = await vr.unlockPrivateKey({ ...keys, password });
      expect(await vr.publicKeyOf(privateKey)).toBe(pair.publicKey);
      const reason = (input: Parameters<typeof vr.unlockPrivateKey>[0]) =>
        vr.unlockPrivateKey(input).then(
          () => "opened",
          (error: unknown) => (error as vr.VaultwardenError).reason,
        );
      expect(await reason({ ...keys, password: `${password}!` })).toBe(
        "wrong-password",
      );
      // The other KDF derives another key: never the account's.
      expect(
        await reason({
          ...keys,
          password,
          kdf:
            kdf.type === vr.KDF_ARGON2ID
              ? vr.pbkdf2Kdf(5_000)
              : {
                  type: vr.KDF_ARGON2ID,
                  iterations: 2,
                  memory: 16,
                  parallelism: 1,
                },
        }),
      ).toBe("wrong-password");
      // Keys of another form (a v2 account's), a user key that opens to
      // something else and a private key that is none are not guessed.
      for (const other of [
        { protectedUserKey: `7.${protectedUserKey.slice(2)}` },
        { encryptedPrivateKey: "0.aGVsbG8=|d29ybGQ=" },
        {
          protectedUserKey: await vr.encrypt(
            userKey.slice(0, 32),
            await vr.stretchMasterKey(masterKey),
          ),
        },
        {
          encryptedPrivateKey: await vr.encrypt(
            "not a private key",
            vr.symmetricKey(userKey),
          ),
        },
      ])
        expect(await reason({ ...keys, password, ...other })).toBe(
          "unsupported-keys",
        );
    }
  });

  test("a KDF is taken only within Bitwarden's own bounds", () => {
    const kdf = (
      type: unknown,
      iterations: unknown,
      memory: unknown = null,
      parallelism: unknown = null,
    ) => vr.kdfOf({ type, iterations, memory, parallelism });
    expect(kdf(0, 600_000)).toEqual({ type: 0, iterations: 600_000 });
    expect(kdf(0, 5_000)).not.toBeNull();
    expect(kdf(0, 10_000_000)).not.toBeNull();
    expect(kdf(1, 3, 64, 4)).toEqual({
      type: 1,
      iterations: 3,
      memory: 64,
      parallelism: 4,
    });
    expect(kdf(1, 2, 15, 1)).not.toBeNull();
    expect(kdf(1, 10, 1024, 16)).not.toBeNull();
    for (const refused of [
      kdf(0, 4_999),
      kdf(0, 10_000_001),
      kdf(0, "600000"),
      kdf(0, 600_000.5),
      kdf(1, 3),
      kdf(1, 1, 64, 4),
      kdf(1, 11, 64, 4),
      kdf(1, 3, 14, 4),
      kdf(1, 3, 1025, 4),
      kdf(1, 3, 64, 0),
      kdf(1, 3, 64, 17),
      kdf(2, 3, 64, 4),
      kdf(undefined, 600_000),
    ])
      expect(refused).toBeNull();
  });
});

type Seen = { url: string; init: RequestInit };

/** A vault answering each path with what the test scripts. */
function scripted(
  answers: Record<string, (body: unknown, init: RequestInit) => Response>,
) {
  const seen: Seen[] = [];
  const fetch: vr.VaultFetch = async (url, init) => {
    seen.push({ url, init });
    const path = new URL(url).pathname;
    const answer = answers[path];
    if (answer === undefined) return new Response("not found", { status: 404 });
    const text = typeof init.body === "string" ? init.body : "";
    const body =
      (init.headers as Record<string, string>)["Content-Type"] ===
      "application/x-www-form-urlencoded"
        ? Object.fromEntries(new URLSearchParams(text))
        : text === ""
          ? null
          : JSON.parse(text);
    return answer(body, init);
  };
  return { fetch, seen };
}

const refusal = (message: string, status = 400) =>
  Response.json(
    {
      message,
      validationErrors: { "": [message] },
      ErrorModel: { Message: message, Object: "error" },
      object: "error",
    },
    { status },
  );

const jwt = (claims: unknown) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;

describe("the requests", () => {
  test("register sends exactly the documented bodies, JSON asked for, and takes a token in either shape", async () => {
    for (const plain of [false, true]) {
      const finished: unknown[] = [];
      const vault = scripted({
        "/identity/accounts/register/send-verification-email": (body, init) => {
          expect(body).toEqual({
            email,
            name: "Environment Osobní · example",
            receiveMarketingEmails: false,
          });
          expect((init.headers as Record<string, string>).Accept).toBe(
            "application/json",
          );
          return plain
            ? new Response("registration-token", {
                headers: { "content-type": "text/plain" },
              })
            : Response.json("registration-token");
        },
        "/identity/accounts/register/finish": (body) => {
          finished.push(body);
          return Response.json({ object: "registerFinish" });
        },
      });
      const created = await vr.registerAccount(
        { fetch: vault.fetch },
        {
          serverUrl: server,
          email: ` ${email.toUpperCase()} `,
          password: "throwaway-unit-test",
          name: "Environment Osobní · example",
        },
      );
      expect(created.email).toBe(email);
      const body = (finished as Record<string, unknown>[])[0] ?? {};
      const kdf = {
        kdfType: 0,
        iterations: 600_000,
        memory: null,
        parallelism: null,
      };
      expect(Object.keys(body).sort()).toEqual([
        "email",
        "emailVerificationToken",
        "masterPasswordAuthentication",
        "masterPasswordHint",
        "masterPasswordUnlock",
        "userAsymmetricKeys",
      ]);
      expect(body).toMatchObject({
        email,
        emailVerificationToken: "registration-token",
        masterPasswordHint: null,
        userAsymmetricKeys: { publicKey: created.publicKey },
        masterPasswordAuthentication: { kdf, salt: email },
        masterPasswordUnlock: { kdf, salt: email },
      });
      const masterKey = await vr.deriveMasterKey("throwaway-unit-test", email);
      expect(
        (body.masterPasswordAuthentication as Record<string, unknown>)
          .masterPasswordAuthenticationHash,
      ).toBe(await vr.makeMasterPasswordHash(masterKey, "throwaway-unit-test"));
      // The wrapped user key opens with the password, as bw unlock opens it.
      const userKey = await vr.decrypt(
        (body.masterPasswordUnlock as Record<string, string>)
          .masterKeyWrappedUserKey as string,
        await vr.stretchMasterKey(masterKey),
      );
      expect(userKey.length).toBe(64);
    }
  });

  test("Vaultwarden's refusals become fixed reasons", async () => {
    const register = (answer: () => Response) =>
      vr.registerAccount(
        {
          fetch: scripted({
            "/identity/accounts/register/send-verification-email": answer,
          }).fetch,
        },
        { serverUrl: server, email, password: "throwaway-unit-test" },
      );
    const reason = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error) =>
          error instanceof vr.VaultwardenError ? error.reason : error,
      );
    expect(
      await reason(
        register(() =>
          refusal("Registration not allowed or user already exists"),
        ),
      ),
    ).toBe("not-invited");
    expect(
      await reason(register(() => new Response(null, { status: 204 }))),
    ).toBe("smtp-enabled");
    expect(
      await reason(
        register(() => refusal("Too many requests, try again later.", 429)),
      ),
    ).toBe("rate-limited");
    expect(
      await reason(
        register(() => new Response("bad gateway", { status: 502 })),
      ),
    ).toBe("unreachable");
    expect(
      await reason(
        vr.registerAccount(
          {
            fetch: async () => {
              throw new Error("connect ECONNREFUSED");
            },
          },
          { serverUrl: server, email, password: "throwaway-unit-test" },
        ),
      ),
    ).toBe("unreachable");
    // Never anything but https.
    expect(
      await reason(
        vr.registerAccount(
          { fetch: async () => Response.json("token") },
          {
            serverUrl: "http://vaultwarden.example.lazurio.io",
            email,
            password: "throwaway-unit-test",
          },
        ),
      ),
    ).toBe("unreachable");
  });

  test("a password login with the Environment's one device, then its API key", async () => {
    const device = {
      identifier: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
      name: "Lazurio Launchpad",
      type: vr.DEVICE_TYPE_SDK,
    };
    const userId = "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d";
    const masterKey = await vr.deriveMasterKey(
      "throwaway-unit-test",
      email,
      vr.pbkdf2Kdf(600_000),
    );
    const hash = await vr.makeMasterPasswordHash(
      masterKey,
      "throwaway-unit-test",
    );
    const vault = scripted({
      "/identity/accounts/prelogin": (body) => {
        expect(body).toEqual({ email });
        return Response.json({ kdf: 0, kdfIterations: 600_000 });
      },
      "/identity/connect/token": (body) => {
        expect(body).toEqual({
          grant_type: "password",
          scope: "api offline_access",
          client_id: "cli",
          username: email,
          password: hash,
          deviceType: "21",
          deviceIdentifier: device.identifier,
          deviceName: device.name,
        });
        return Response.json({ access_token: jwt({ sub: userId }) });
      },
      "/api/accounts/api-key": (body, init) => {
        expect(body).toEqual({ masterPasswordHash: hash });
        expect((init.headers as Record<string, string>).Authorization).toBe(
          `Bearer ${jwt({ sub: userId })}`,
        );
        return Response.json({
          apiKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
          object: "apiKey",
        });
      },
    });
    const login = await vr.passwordLogin(
      { fetch: vault.fetch },
      { serverUrl: server, email, password: "throwaway-unit-test", device },
    );
    expect(login.userId).toBe(userId);
    expect(await vr.fetchApiKey({ fetch: vault.fetch }, login)).toEqual({
      clientId: `user.${userId}`,
      clientSecret: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    });
    // A refused login and the rate limit are told apart.
    for (const [answer, expected] of [
      [
        () =>
          Response.json(
            {
              error: "invalid_grant",
              error_description: "invalid_username_or_password",
            },
            { status: 400 },
          ),
        "invalid-credentials",
      ],
      [() => refusal("Too many login requests", 429), "rate-limited"],
    ] as const) {
      const refused = scripted({
        "/identity/accounts/prelogin": () =>
          Response.json({ kdf: 0, kdfIterations: 600_000 }),
        "/identity/connect/token": answer,
      });
      expect(
        await vr
          .passwordLogin(
            { fetch: refused.fetch },
            {
              serverUrl: server,
              email,
              password: "throwaway-unit-test",
              device,
            },
          )
          .then(
            () => "resolved",
            (error) => (error as vr.VaultwardenError).reason,
          ),
      ).toBe(expected);
    }
    // A KDF other than PBKDF2-SHA256 is not guessed at.
    const argon = scripted({
      "/identity/accounts/prelogin": () =>
        Response.json({ kdf: 1, kdfIterations: 3 }),
    });
    expect(
      await vr
        .passwordLogin(
          { fetch: argon.fetch },
          { serverUrl: server, email, password: "throwaway-unit-test", device },
        )
        .then(
          () => "resolved",
          (error) => (error as vr.VaultwardenError).reason,
        ),
    ).toBe("unsupported-kdf");
  });
});

// The Environment's own vault (decision F53): the account signs in with its
// API key, unlocks its own keys and asks the vault's API with any method.
describe("the own vault's requests", () => {
  const ownEmail = "vaultwarden-ndbrmzvjpwxtt3q7m2e4fihgsa@example.lazurio.io";
  const userId = "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d";
  const device = {
    identifier: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
    name: "Lazurio Launchpad",
    type: vr.DEVICE_TYPE_SDK,
  };

  test("the public key of a private key is the one generated with it", async () => {
    const wrap = vr.symmetricKey(vr.randomBytes(64));
    const pair = await vr.makeKeyPair(wrap);
    const privateKey = await vr.decrypt(pair.encryptedPrivateKey, wrap);
    expect(await vr.publicKeyOf(privateKey)).toBe(pair.publicKey);
  });

  test("the account's private key unlocks from its master password and what the vault keeps", async () => {
    const keys = await vr.makeAccountKeys(
      ownEmail,
      "throwaway-unit-test",
      5_000,
    );
    const privateKey = await vr.unlockPrivateKey({
      email: ownEmail,
      password: "throwaway-unit-test",
      protectedUserKey: keys.protectedUserKey,
      encryptedPrivateKey: keys.encryptedPrivateKey,
      kdf: vr.pbkdf2Kdf(5_000),
    });
    expect(await vr.publicKeyOf(privateKey)).toBe(keys.publicKey);
    await expect(
      vr.unlockPrivateKey({
        email: ownEmail,
        password: "another-password",
        protectedUserKey: keys.protectedUserKey,
        encryptedPrivateKey: keys.encryptedPrivateKey,
        kdf: vr.pbkdf2Kdf(5_000),
      }),
    ).rejects.toMatchObject({ reason: "wrong-password" });
  });

  test("the API-key login sends client_credentials with the one device and returns what unlocking needs", async () => {
    const answer = {
      access_token: jwt({ sub: userId }),
      token_type: "Bearer",
      Key: "2.a|b|c",
      PrivateKey: "2.d|e|f",
      Kdf: 0,
      KdfIterations: 600_000,
    };
    const vault = scripted({
      "/identity/connect/token": (body) => {
        expect(body).toEqual({
          grant_type: "client_credentials",
          scope: "api",
          client_id: `user.${userId}`,
          client_secret: "a1b2c3d4e5f6a1b2",
          deviceType: "21",
          deviceIdentifier: device.identifier,
          deviceName: device.name,
        });
        return Response.json(answer);
      },
    });
    const login = {
      serverUrl: server,
      clientId: `user.${userId}`,
      clientSecret: "a1b2c3d4e5f6a1b2",
      device,
    };
    expect(await vr.apiKeyLogin({ fetch: vault.fetch }, login)).toEqual({
      serverUrl: server,
      userId,
      accessToken: answer.access_token,
      protectedUserKey: "2.a|b|c",
      encryptedPrivateKey: "2.d|e|f",
      kdf: { type: 0, iterations: 600_000 },
    });
    // Refusals and answers this core does not read are fixed reasons.
    for (const [response, reason] of [
      [refusal("Incorrect client_secret"), "invalid-credentials"],
      [Response.json({ ...answer, Kdf: 1 }), "unsupported-kdf"],
      [Response.json({ ...answer, KdfIterations: 10 }), "unsupported-kdf"],
      [
        Response.json({
          ...answer,
          access_token: jwt({ sub: device.identifier }),
        }),
        "unexpected",
      ],
      [Response.json({ ...answer, Key: null }), "unexpected"],
      // A v2 account cryptographic state: keys of another form.
      [Response.json({ ...answer, Key: "7.a|b|c" }), "unsupported-keys"],
      [Response.json({ ...answer, PrivateKey: "7.d" }), "unsupported-keys"],
      [new Response("", { status: 503 }), "unreachable"],
    ] as const) {
      const refused = scripted({ "/identity/connect/token": () => response });
      const error = await vr
        .apiKeyLogin({ fetch: refused.fetch }, login)
        .catch((caught: unknown) => caught);
      expect([reason, (error as vr.VaultwardenError).reason]).toEqual([
        reason,
        reason,
      ]);
    }
    // Argon2id as the answer carries it, and an answer without a KDF, whose
    // KDF the prelogin of the account's e-mail then says.
    const argon2 = {
      ...answer,
      Kdf: 1,
      KdfIterations: 3,
      KdfMemory: 64,
      KdfParallelism: 4,
    };
    const { Kdf: _, KdfIterations: __, ...without } = answer;
    const vault2 = scripted({
      "/identity/connect/token": () => Response.json(argon2),
    });
    expect((await vr.apiKeyLogin({ fetch: vault2.fetch }, login)).kdf).toEqual({
      type: 1,
      iterations: 3,
      memory: 64,
      parallelism: 4,
    });
    const silent = scripted({
      "/identity/connect/token": () => Response.json(without),
      "/identity/accounts/prelogin": (body) => {
        expect(body).toEqual({ email: ownEmail });
        return Response.json({
          kdf: 1,
          kdfIterations: 3,
          kdfMemory: 64,
          kdfParallelism: 4,
        });
      },
    });
    const signedIn = await vr.apiKeyLogin({ fetch: silent.fetch }, login);
    expect(signedIn.kdf).toBeNull();
    expect(
      await vr.accountKdf({ fetch: silent.fetch }, signedIn, ownEmail),
    ).toEqual({ type: 1, iterations: 3, memory: 64, parallelism: 4 });
    // A prelogin of a KDF this core does not know is refused.
    const unknown = scripted({
      "/identity/accounts/prelogin": () =>
        Response.json({ kdf: 2, kdfIterations: 3 }),
    });
    expect(
      await vr.prelogin({ fetch: unknown.fetch }, server, ownEmail).then(
        () => "resolved",
        (error) => (error as vr.VaultwardenError).reason,
      ),
    ).toBe("unsupported-kdf");
  });

  test("a request names its method, carries the token, and an organization the vault does not allow is a fixed reason", async () => {
    const vault = scripted({
      "/api/organizations/x": (_body, init) =>
        Response.json({ method: init.method }),
      "/api/organizations": () =>
        refusal("User not allowed to create organizations"),
    });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      expect(
        await vr.vaultRequest(
          { fetch: vault.fetch },
          server,
          "/api/organizations/x",
          {
            method,
            token: "token",
            ...(method === "PUT" ? { json: { name: "x" } } : {}),
          },
        ),
      ).toEqual({ method });
    }
    const headers = vault.seen.at(-1)?.init.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe("Bearer token");
    const error = await vr
      .vaultRequest({ fetch: vault.fetch }, server, "/api/organizations", {
        json: {},
        token: "token",
      })
      .catch((caught: unknown) => caught);
    expect((error as vr.VaultwardenError).reason).toBe("organization-refused");
  });
});

// A personal Environment's own Bitwarden (root decision 0203 point 7): the
// cloud's two regions, an allow-list, whose identity and API answer on hosts
// of their own.
describe("the Bitwarden cloud", () => {
  test("a region is exactly its web vault, and its identity and API requests reach their own hosts", async () => {
    expect(bitwardenRegionOf("https://vault.bitwarden.eu")).toBe("eu");
    expect(bitwardenRegionOf("https://vault.bitwarden.eu/")).toBe("eu");
    expect(bitwardenRegionOf("https://vault.bitwarden.com")).toBe("us");
    for (const other of [
      "http://vault.bitwarden.eu",
      "https://vault.bitwarden.eu.example.com",
      "https://bitwarden.eu",
      "https://api.bitwarden.eu",
      "https://VAULT.bitwarden.com",
      "https://vault.bitwarden.com:8443",
      server,
    ])
      expect([other, bitwardenRegionOf(other)]).toEqual([other, null]);
    expect(bitwardenRegions.eu).toEqual({
      web: "https://vault.bitwarden.eu",
      api: "https://api.bitwarden.eu",
      identity: "https://identity.bitwarden.eu",
    });
    expect(bitwardenRegions.us).toEqual({
      web: "https://vault.bitwarden.com",
      api: "https://api.bitwarden.com",
      identity: "https://identity.bitwarden.com",
    });
    const asked: string[] = [];
    const fetch: vr.VaultFetch = async (url) => {
      asked.push(url);
      return Response.json({});
    };
    for (const [web, path] of [
      ["https://vault.bitwarden.eu", "/identity/connect/token"],
      ["https://vault.bitwarden.eu", "/api/accounts/profile"],
      ["https://vault.bitwarden.com", "/identity/accounts/prelogin"],
      ["https://vault.bitwarden.com", "/api/organizations/x/users/invite"],
      [server, "/identity/connect/token"],
      [server, "/api/accounts/profile"],
    ] as const)
      await vr.vaultRequest({ fetch }, web, path, { json: {} });
    expect(asked).toEqual([
      "https://identity.bitwarden.eu/connect/token",
      "https://api.bitwarden.eu/accounts/profile",
      "https://identity.bitwarden.com/accounts/prelogin",
      "https://api.bitwarden.com/organizations/x/users/invite",
      `${server}/identity/connect/token`,
      `${server}/api/accounts/profile`,
    ]);
    // Nothing else of the cloud is asked for.
    expect(
      await vr
        .vaultRequest({ fetch }, "https://vault.bitwarden.eu", "/admin")
        .then(
          () => "resolved",
          (error) => (error as vr.VaultwardenError).reason,
        ),
    ).toBe("unexpected");
    expect(asked).toHaveLength(6);
  });

  // Only an identity server's explicit answer that it does not know the
  // client is "unknown": HTTP 400 invalid_client, as the Bitwarden cloud's
  // Identity answers through Duende IdentityServer 7.4.6 for an unknown
  // user.<id> or a secret that does not match (register.ts
  // `unknownClientAnswer`). Every other refusal of a token request stays
  // invalid-credentials without that mark; a rate limit, a 5xx and no answer
  // keep their own reasons.
  test("a token request's refusal is marked unknown only for HTTP 400 invalid_client", async () => {
    const refusal = async (
      answer: () => Promise<Response>,
      path = "/identity/connect/token",
    ) =>
      vr
        .vaultRequest({ fetch: answer }, "https://vault.bitwarden.eu", path, {
          form: { grant_type: "client_credentials" },
        })
        .then(
          () => "resolved",
          (error) => {
            const failure = error as vr.VaultwardenError;
            return [failure.reason, failure.status, failure.unknownClient];
          },
        );
    const json = (status: number, body: unknown) => async () =>
      Response.json(body, { status });
    expect(await refusal(json(400, { error: "invalid_client" }))).toEqual([
      "invalid-credentials",
      400,
      true,
    ]);
    expect(
      await refusal(
        json(400, { error: "invalid_client", error_description: null }),
      ),
    ).toEqual(["invalid-credentials", 400, true]);
    for (const [answer, status] of [
      [
        json(403, {
          error: "access_denied",
          error_description: "This account is blocked",
        }),
        403,
      ],
      [json(400, { error: "invalid_request" }), 400],
      [json(400, { error: "invalid_grant" }), 400],
      [json(400, { error: "unauthorized_client" }), 400],
      [json(401, { error: "invalid_client" }), 401],
      [json(400, ["invalid_client"]), 400],
      [json(400, { message: "invalid_client" }), 400],
      [async () => new Response("invalid_client", { status: 400 }), 400],
      [
        async () => new Response("<html>Forbidden</html>", { status: 403 }),
        403,
      ],
    ] as const)
      expect(await refusal(answer)).toEqual([
        "invalid-credentials",
        status,
        false,
      ]);
    expect(await refusal(json(429, { message: "Too many" }))).toEqual([
      "rate-limited",
      429,
      false,
    ]);
    expect(await refusal(json(502, { error: "invalid_client" }))).toEqual([
      "unreachable",
      502,
      false,
    ]);
    expect(
      await refusal(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    ).toEqual(["unreachable", undefined, false]);
    // Not a token request: never marked, whatever it says.
    expect(
      await refusal(
        json(400, { error: "invalid_client" }),
        "/identity/accounts/prelogin",
      ),
    ).toEqual(["unexpected", 400, false]);
    expect(vr.unknownClientAnswer(400, { error: "invalid_client" })).toBe(true);
    expect(vr.unknownClientAnswer(400, { error: "INVALID_CLIENT" })).toBe(
      false,
    );
    expect(vr.unknownClientAnswer(400, null)).toBe(false);
  });

  test("a second Free organization of an account that owns one is a fixed reason", async () => {
    const cloud = scripted({
      "/organizations": () =>
        refusal("You can only be an admin of one free organization."),
    });
    expect(
      await vr
        .vaultRequest(
          { fetch: cloud.fetch },
          "https://vault.bitwarden.eu",
          "/api/organizations",
          { json: {}, token: "token" },
        )
        .then(
          () => "resolved",
          (error) => (error as vr.VaultwardenError).reason,
        ),
    ).toBe("free-organization-limit");
    expect(cloud.seen[0]?.url).toBe("https://api.bitwarden.eu/organizations");
  });
});
