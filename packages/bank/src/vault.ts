import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Encrypted key vault: losers stake spend-capped OpenRouter keys here.
 * AES-256-GCM per entry with a scrypt-derived key, so the file at rest never
 * contains key material in the clear. One vault file per table.
 */

/** Known plaintext encrypted at vault creation; failing to decrypt it means a wrong passphrase. */
const CHECK_MARKER = "table-stakes-vault";

interface EncryptedBlob {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface VaultEntry extends EncryptedBlob {
  readonly playerId: string;
  readonly label: string;
  readonly addedAt: string;
}

interface VaultFile {
  readonly version: 1;
  readonly salt: string;
  readonly check: EncryptedBlob;
  entries: VaultEntry[];
}

function encrypt(key: Buffer, plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

function decrypt(key: Buffer, blob: EncryptedBlob): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export class Vault {
  private constructor(
    private readonly filePath: string,
    private readonly key: Buffer,
    private readonly file: VaultFile,
  ) {}

  /** Opens an existing vault (throws on wrong passphrase) or creates a fresh one. */
  static open(filePath: string, passphrase: string): Vault {
    if (existsSync(filePath)) {
      const file = JSON.parse(readFileSync(filePath, "utf8")) as VaultFile;
      if (file.version !== 1) {
        throw new Error(`unsupported vault version in ${filePath}`);
      }
      const key = scryptSync(passphrase, file.salt, 32);
      let marker: string;
      try {
        marker = decrypt(key, file.check);
      } catch {
        throw new Error(`wrong passphrase for vault: ${filePath}`);
      }
      if (marker !== CHECK_MARKER) {
        throw new Error(`wrong passphrase for vault: ${filePath}`);
      }
      return new Vault(filePath, key, file);
    }
    const salt = randomBytes(16).toString("hex");
    const key = scryptSync(passphrase, salt, 32);
    const vault = new Vault(filePath, key, {
      version: 1,
      salt,
      check: encrypt(key, CHECK_MARKER),
      entries: [],
    });
    vault.persist();
    return vault;
  }

  /** Stakes (or replaces) a player's key. Only the ciphertext ever touches disk. */
  addKey(playerId: string, apiKey: string, label?: string): void {
    const entry: VaultEntry = {
      playerId,
      label: label ?? "",
      addedAt: new Date().toISOString(),
      ...encrypt(this.key, apiKey),
    };
    const index = this.file.entries.findIndex((e) => e.playerId === playerId);
    if (index >= 0) this.file.entries[index] = entry;
    else this.file.entries.push(entry);
    this.persist();
  }

  getKey(playerId: string): string | null {
    const entry = this.file.entries.find((e) => e.playerId === playerId);
    return entry ? decrypt(this.key, entry) : null;
  }

  removeKey(playerId: string): boolean {
    const remaining = this.file.entries.filter((e) => e.playerId !== playerId);
    if (remaining.length === this.file.entries.length) return false;
    this.file.entries = remaining;
    this.persist();
    return true;
  }

  /** Metadata only — never exposes key material. */
  entries(): ReadonlyArray<{ playerId: string; label: string; addedAt: string }> {
    return this.file.entries.map(({ playerId, label, addedAt }) => ({ playerId, label, addedAt }));
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
  }
}
