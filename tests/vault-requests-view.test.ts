import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  fieldList,
  isFilled,
  itemLine,
  needTitle,
  parseRequestView,
  parseWaitingRequests,
  refusalText,
  requestHref,
} from "../src/launchpad/vault-requests-view";

// An agent's secret request as the page reads and words it (decision F54;
// the wireframe's screens/SecretRequest.tsx): the routes' answers read as
// plain values, the agent's words as the person reads them, and what a
// refusal means for the person. How it looks is checked in a browser (root
// decision 0178).

const id = "abcdefghijklmnopqrstuvwx";
const answer = {
  kind: "vault-request",
  id,
  item: "Fakturace API klient",
  need: "klíč pro připojení k fakturaci",
  why: "Abych mohl hledat a číst faktury.",
  where: "Najdete ho ve Fakturaci v Nastavení → API klienti.",
  fields: [
    { name: "Client ID", secret: false },
    { name: "Client secret", secret: true },
  ],
  createdAt: "2026-10-14T00:00:00.000Z",
  state: "pending",
  answeredAt: null,
};

test("a request of the routes is read as plain values; anything else is not a request", () => {
  expect(parseRequestView(answer)).toEqual({
    id,
    item: answer.item,
    need: answer.need,
    why: answer.why,
    where: answer.where,
    fields: answer.fields,
    state: "pending",
  });
  for (const broken of [
    null,
    "request",
    { ...answer, id: "x" },
    { ...answer, need: "" },
    { ...answer, fields: [] },
    { ...answer, fields: [{ name: "Client ID" }] },
    { ...answer, fields: [{ name: 1, secret: true }] },
    { ...answer, state: "saving" },
  ])
    expect([broken, parseRequestView(broken)]).toEqual([broken, null]);
  // The section lists those that wait.
  expect(
    parseWaitingRequests({
      kind: "vault-requests",
      requests: [
        answer,
        { ...answer, id: "bcdefghijklmnopqrstuvwxy", state: "saved" },
      ],
    })?.map((request) => request.id),
  ).toEqual([id]);
  expect(
    parseWaitingRequests({ kind: "vault-requests", requests: [{}] }),
  ).toBeNull();
  expect(parseWaitingRequests({ kind: "other", requests: [] })).toBeNull();
});

test("the agent's words read as the person reads them, in both languages", () => {
  const request = parseRequestView(answer);
  if (request === null) throw new Error("Expected a request");
  const cs = messages("cs");
  const en = messages("en");
  expect(needTitle(request.need)).toBe("Klíč pro připojení k fakturaci");
  expect(fieldList(request.fields, cs)).toBe("Client ID a Client secret");
  expect(fieldList(request.fields, en)).toBe("Client ID and Client secret");
  expect(
    fieldList(
      [
        { name: "A", secret: false },
        { name: "B", secret: true },
        { name: "C", secret: true },
      ],
      cs,
    ),
  ).toBe("A, B a C");
  expect(fieldList([{ name: "API klíč", secret: true }], cs)).toBe("API klíč");
  expect(itemLine(request, cs)).toBe(
    "Uloží se do trezoru Prostředí jako položka Fakturace API klient.",
  );
  expect(itemLine(request, en)).toBe(
    "It is saved in the Environment's vault as the item Fakturace API klient.",
  );
  expect(requestHref(request)).toBe(`/settings/vault/requests/${id}`);
  // Saved only with every field filled, white space alone is not a value.
  const filled = new Map([
    ["Client ID", "fake-id"],
    ["Client secret", "fake-secret"],
  ]);
  expect(isFilled(request, filled)).toBe(true);
  expect(isFilled(request, new Map([["Client ID", "fake-id"]]))).toBe(false);
  expect(
    isFilled(
      request,
      new Map([
        ["Client ID", "fake-id"],
        ["Client secret", "  "],
      ]),
    ),
  ).toBe(false);
});

test("a refusal says what the person can do; an answered request is read again", () => {
  const cs = messages("cs");
  expect(refusalText("answered", cs)).toBeNull();
  expect(refusalText("values-invalid", cs)).toBe("Vyplňte všechna pole.");
  for (const reason of ["busy", "locked", "unreachable"])
    expect(refusalText(reason, cs)).toBe(
      "Trezor teď neodpovídá. Zkuste to prosím za chvíli.",
    );
  expect(refusalText("not-connected", cs)).toBe(
    "Trezor Prostředí zatím není připravený.",
  );
  expect(refusalText("no-vault", cs)).toBe("Toto Prostředí zatím trezor nemá.");
  // A public Organization's Environment: none, not "yet" (DEV-6631).
  expect(refusalText("no-tailnet", cs)).toBe("Toto Prostředí trezor nemá.");
  expect(refusalText("not-found", cs)).toBe("Žádost neexistuje.");
  expect(refusalText("vault-failed", cs)).toBe(
    "Uložení se nepodařilo. Zkuste to znovu.",
  );
  expect(refusalText(undefined, cs)).toBe(
    "Uložení se nepodařilo. Zkuste to znovu.",
  );
});
