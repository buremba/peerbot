import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CREDENTIAL_PLACEHOLDER_PREFIX,
  CredentialVault,
  containsCredentialPlaceholder,
} from "../egress/credentials.js";

const HTTPS = new URL("https://api.example.com/v1/items?page=2");
const HTTP = new URL("http://127.0.0.1:8080/echo");
const PLACEHOLDER = /^lobu_secret_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("CredentialVault.mint", () => {
  test("mints the secret proxy's grammar, a fresh id per call", () => {
    const vault = new CredentialVault();
    const a = vault.mint("tok_a");
    const b = vault.mint("tok_a");
    expect(a).toMatch(PLACEHOLDER);
    expect(b).toMatch(PLACEHOLDER);
    expect(a).not.toBe(b);
    expect(a.startsWith(CREDENTIAL_PLACEHOLDER_PREFIX)).toBe(true);
    expect(vault.size).toBe(2);
    expect(containsCredentialPlaceholder(`Bearer ${a}`)).toBe(true);
    expect(containsCredentialPlaceholder("Bearer tok_a")).toBe(false);
  });
});

describe("CredentialVault.swapHeaders", () => {
  test("resolves a placeholder wherever it sits in a header value, over HTTPS, and reports the header", () => {
    const vault = new CredentialVault();
    const token = vault.mint("tok_real");
    const other = vault.mint("key_real");
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "X-Api-Key": other,
      "X-Both": `${token};${other}`,
      Accept: "application/json",
    });
    const spends = vault.swapHeaders(headers, HTTPS, { plaintextAllowed: false });
    expect(headers.get("authorization")).toBe("Bearer tok_real");
    expect(headers.get("x-api-key")).toBe("key_real");
    expect(headers.get("x-both")).toBe("tok_real;key_real");
    expect(headers.get("accept")).toBe("application/json");
    expect(spends).toEqual([
      { placeholder: token, header: "authorization" },
      { placeholder: other, header: "x-api-key" },
      { placeholder: token, header: "x-both" },
      { placeholder: other, header: "x-both" },
    ]);
  });

  test("refuses a placeholder this vault did not mint and leaves every header as it was", () => {
    const vault = new CredentialVault();
    const mine = vault.mint("tok_real");
    const foreign = `${CREDENTIAL_PLACEHOLDER_PREFIX}${randomUUID()}`;
    const headers = new Headers({ authorization: `Bearer ${mine}`, "x-replayed": foreign });
    expect(() => vault.swapHeaders(headers, HTTPS, { plaintextAllowed: false })).toThrow(
      /placeholder in header x-replayed is not valid for this run/,
    );
    expect(headers.get("authorization")).toBe(`Bearer ${mine}`);
    expect(headers.get("x-replayed")).toBe(foreign);
  });

  test("refuses the prefix without a well-formed id behind it", () => {
    const vault = new CredentialVault();
    const headers = new Headers({ authorization: `Bearer ${CREDENTIAL_PLACEHOLDER_PREFIX}nope` });
    expect(() => vault.swapHeaders(headers, HTTPS, { plaintextAllowed: false })).toThrow(TypeError);
  });

  test("refuses a placeholder in the URL before touching the headers", () => {
    const vault = new CredentialVault();
    const token = vault.mint("tok_real");
    const headers = new Headers({ authorization: `Bearer ${token}` });
    const url = new URL(`https://api.example.com/v1?access_token=${token}`);
    expect(() => vault.swapHeaders(headers, url, { plaintextAllowed: false })).toThrow(
      /only be sent in a request header, not in the URL/,
    );
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  test("applies the transport's HTTPS rule to a credential-bearing header, and only to one", () => {
    const vault = new CredentialVault();
    const token = vault.mint("tok_real");
    const withCredential = new Headers({ authorization: `Bearer ${token}` });
    expect(() => vault.swapHeaders(withCredential, HTTP, { plaintextAllowed: false })).toThrow(
      "Credential-bearing requests require HTTPS",
    );
    expect(withCredential.get("authorization")).toBe(`Bearer ${token}`);

    const anonymous = new Headers({ accept: "text/plain" });
    expect(vault.swapHeaders(anonymous, HTTP, { plaintextAllowed: false })).toEqual([]);
  });

  test("swaps over plaintext when the destination is vouched for", () => {
    const vault = new CredentialVault();
    const token = vault.mint("tok_real");
    const headers = new Headers({ authorization: `Bearer ${token}` });
    const spends = vault.swapHeaders(headers, HTTP, { plaintextAllowed: true });
    expect(headers.get("authorization")).toBe("Bearer tok_real");
    expect(spends).toEqual([{ placeholder: token, header: "authorization" }]);
  });

  test("clear() makes every placeholder dead", () => {
    const vault = new CredentialVault();
    const token = vault.mint("tok_real");
    vault.clear();
    expect(vault.size).toBe(0);
    const headers = new Headers({ authorization: `Bearer ${token}` });
    expect(() => vault.swapHeaders(headers, HTTPS, { plaintextAllowed: false })).toThrow(
      /not valid for this run/,
    );
  });
});
