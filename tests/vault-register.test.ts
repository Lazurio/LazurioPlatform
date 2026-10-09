import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
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
      b64(await vr.deriveMasterKey("password", "user@example.com", 5000)),
    ).toBe("pj9prw/OHPleXI6bRdmlaD+saJS4awrMiQsQiDjeu2I=");
  });

  // bitwarden/sdk-internal crates/bitwarden-crypto/src/keys/master_key.rs test_password_hash_pbkdf2
  test("master password hash, salt trimmed and lowercased", async () => {
    for (const salt of [
      "test@bitwarden.com",
      "TEST@bitwarden.com",
      " test@bitwarden.com",
    ]) {
      const masterKey = await vr.deriveMasterKey("asdfasdf", salt, 100_000);
      expect(await vr.makeMasterPasswordHash(masterKey, "asdfasdf")).toBe(
        "wmyadRMyBZOH7P/a/ucTCbSghKgdzDpPqUnu/DAVtSw=",
      );
    }
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
      600_000,
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
