import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Vault } from "../src/vault.ts";

const newVaultPath = () => join(mkdtempSync(join(tmpdir(), "vault-")), "vault.json");

describe("Vault", () => {
  it("round-trips keys across reopen", () => {
    const path = newVaultPath();
    const vault = Vault.open(path, "correct horse");
    vault.addKey("alice", "sk-or-alice-secret", "alice stake");
    vault.addKey("bob", "sk-or-bob-secret");
    expect(vault.getKey("alice")).toBe("sk-or-alice-secret");

    const reopened = Vault.open(path, "correct horse");
    expect(reopened.getKey("alice")).toBe("sk-or-alice-secret");
    expect(reopened.getKey("bob")).toBe("sk-or-bob-secret");
    expect(reopened.getKey("mallory")).toBeNull();
  });

  it("removes keys and persists the removal", () => {
    const path = newVaultPath();
    const vault = Vault.open(path, "pw");
    vault.addKey("alice", "sk-or-alice");
    expect(vault.removeKey("alice")).toBe(true);
    expect(vault.getKey("alice")).toBeNull();
    expect(vault.removeKey("alice")).toBe(false);
    expect(Vault.open(path, "pw").getKey("alice")).toBeNull();
  });

  it("replaces the entry when a player stakes twice", () => {
    const vault = Vault.open(newVaultPath(), "pw");
    vault.addKey("alice", "sk-or-first");
    vault.addKey("alice", "sk-or-second", "restaked");
    expect(vault.entries()).toHaveLength(1);
    expect(vault.getKey("alice")).toBe("sk-or-second");
  });

  it("throws on a wrong passphrase", () => {
    const path = newVaultPath();
    Vault.open(path, "correct horse");
    expect(() => Vault.open(path, "wrong pony")).toThrow(/wrong passphrase/);
  });

  it("never exposes key material in entries() or on disk", () => {
    const path = newVaultPath();
    const vault = Vault.open(path, "pw");
    vault.addKey("alice", "sk-or-super-secret", "alice stake");
    const [entry] = vault.entries();
    expect(entry).toEqual({
      playerId: "alice",
      label: "alice stake",
      addedAt: expect.any(String),
    });
    expect(JSON.stringify(vault.entries())).not.toContain("sk-or-super-secret");
    expect(readFileSync(path, "utf8")).not.toContain("sk-or-super-secret");
  });
});
