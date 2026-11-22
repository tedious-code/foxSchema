/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_TTL_DAYS,
  buildManifest,
  isSafePath,
  parseManifest,
  publicKeyX,
  loadPrivateKey,
  serialize,
  sha256,
  signBytes,
  stageRelease,
  stageResign,
  stageRollback,
  verifyBytes,
} from "./bundle.mjs";

function keyPair(id) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { pem, pinned: { id, x: publicKeyX(loadPrivateKey(pem)) } };
}

function dist(
  files = {
    "index.html": "<!doctype html>",
    "assets/index-abc.js": "console.log(1)",
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "fox-ui-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const NOW = new Date("2026-11-22T10:00:00Z");
const key = keyPair("2026-11");
const pinned = [key.pinned];

/** What the bucket would hold after a staged release, as `published`. */
function publishedFrom(outputs) {
  return {
    bytes: outputs.get("channels/stable.json"),
    signature: outputs.get("channels/stable.json.sig"),
  };
}

function release(
  version,
  { distDir = dist(), published = null, apiContract = 1 } = {},
) {
  return stageRelease({
    distDir,
    version,
    apiContract,
    published,
    pinnedKeys: pinned,
    privateKeyPem: key.pem,
    now: NOW,
  });
}

describe("isSafePath", () => {
  it("accepts plain relative paths", () => {
    expect(isSafePath("index.html")).toBe(true);
    expect(isSafePath("assets/index-3f2a.js.br")).toBe(true);
  });

  it.each([
    "",
    "/etc/passwd",
    "../x",
    "a/../b",
    "a//b",
    "a/./b",
    "a\\b",
    "a b",
    "a/",
    "x".repeat(256),
  ])("refuses %j", (path) => expect(isSafePath(path)).toBe(false));
});

describe("buildManifest", () => {
  it("lists every file, sorted, with its hash and size", () => {
    const { manifest, sources } = buildManifest(dist(), {
      version: "1.0.0",
      sequence: 1,
      apiContract: 1,
      publishedAt: "now",
    });
    expect(manifest.files.map((f) => f.path)).toEqual([
      "assets/index-abc.js",
      "index.html",
    ]);
    const js = manifest.files[0];
    expect(js).toEqual({
      path: "assets/index-abc.js",
      sha256: sha256(Buffer.from("console.log(1)")),
      size: 14,
    });
    expect(sources.get(js.sha256)).toMatch(/index-abc\.js$/);
  });

  it("refuses a build without index.html", () => {
    expect(() =>
      buildManifest(dist({ "a.js": "x" }), {
        version: "1",
        sequence: 1,
        apiContract: 1,
      }),
    ).toThrow(/index\.html/);
  });

  it("refuses a file name a backend would refuse", () => {
    const dir = dist({ "index.html": "x", "assets/bad name.js": "x" });
    expect(() =>
      buildManifest(dir, { version: "1", sequence: 1, apiContract: 1 }),
    ).toThrow(/bad name/);
  });

  it("refuses symbolic links, which could point outside the bundle", () => {
    const dir = dist();
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    expect(() =>
      buildManifest(dir, { version: "1", sequence: 1, apiContract: 1 }),
    ).toThrow(/symbolic link/);
  });

  it("refuses a version that is not a plain path segment", () => {
    expect(() =>
      buildManifest(dist(), { version: "../1", sequence: 1, apiContract: 1 }),
    ).toThrow(/version/);
  });
});

describe("signatures", () => {
  const bytes = serialize({ hello: "world" });

  it("verify what was signed", () => {
    expect(
      verifyBytes(
        bytes,
        signBytes(bytes, loadPrivateKey(key.pem), "2026-11"),
        pinned,
      ),
    ).toBe(true);
  });

  it("fail when one byte changes", () => {
    const signature = signBytes(bytes, loadPrivateKey(key.pem), "2026-11");
    expect(verifyBytes(serialize({ hello: "World" }), signature, pinned)).toBe(
      false,
    );
  });

  it("fail for a key that is not pinned, even under a pinned key id", () => {
    const other = keyPair("2026-11");
    expect(
      verifyBytes(
        bytes,
        signBytes(bytes, loadPrivateKey(other.pem), "2026-11"),
        pinned,
      ),
    ).toBe(false);
  });

  it("fail for garbage", () => {
    expect(verifyBytes(bytes, Buffer.from("not json"), pinned)).toBe(false);
  });
});

describe("stageRelease", () => {
  it("stages the first release at sequence 1", () => {
    const { manifest, channel, outputs, files } = release("0.3.26");
    expect(manifest.sequence).toBe(1);
    expect(channel.sequence).toBe(1);
    expect(channel.releases["1"]).toMatchObject({
      version: "0.3.26",
      sequence: 1,
      manifest: "releases/0.3.26/manifest.json",
    });
    expect([...outputs.keys()]).toEqual([
      "releases/0.3.26/manifest.json",
      "releases/0.3.26/manifest.json.sig",
      "channels/stable.json",
      "channels/stable.json.sig",
    ]);
    expect(
      [...files.keys()].every((k) => /^files\/[0-9a-f]{64}$/.test(k)),
    ).toBe(true);
  });

  it("signs a manifest the channel names by hash", () => {
    const { outputs, channel } = release("0.3.26");
    const manifestBytes = outputs.get("releases/0.3.26/manifest.json");
    expect(channel.releases["1"].sha256).toBe(sha256(manifestBytes));
    expect(
      verifyBytes(
        manifestBytes,
        outputs.get("releases/0.3.26/manifest.json.sig"),
        pinned,
      ),
    ).toBe(true);
    expect(
      verifyBytes(
        outputs.get("channels/stable.json"),
        outputs.get("channels/stable.json.sig"),
        pinned,
      ),
    ).toBe(true);
  });

  it("sets the channel to expire after the TTL", () => {
    const { channel } = release("0.3.26");
    expect(new Date(channel.expiresAt).getTime() - NOW.getTime()).toBe(
      CHANNEL_TTL_DAYS * 86_400_000,
    );
  });

  it("takes the next sequence and keeps the other contracts", () => {
    const first = release("0.3.26", { apiContract: 1 });
    const second = release("0.4.0", {
      apiContract: 2,
      published: publishedFrom(first.outputs),
    });
    expect(second.manifest.sequence).toBe(2);
    expect(Object.keys(second.channel.releases)).toEqual(["1", "2"]);
    expect(second.channel.releases["1"].version).toBe("0.3.26");
  });

  it("refuses a version that is already published", () => {
    const first = release("0.3.26");
    expect(() =>
      release("0.3.26", { published: publishedFrom(first.outputs) }),
    ).toThrow(/already published/);
  });

  it("refuses to build on a channel not signed by a pinned key", () => {
    const first = release("0.3.26");
    const forged = {
      bytes: first.outputs.get("channels/stable.json"),
      signature: Buffer.from("{}"),
    };
    expect(() => release("0.3.27", { published: forged })).toThrow(
      /not signed by a pinned key/,
    );
  });

  it("names the key to pin when the signing key is not pinned", () => {
    expect(() =>
      stageRelease({
        distDir: dist(),
        version: "1",
        apiContract: 1,
        published: null,
        pinnedKeys: [],
        privateKeyPem: key.pem,
      }),
    ).toThrow(new RegExp(`x: '${key.pinned.x}'`));
  });
});

describe("stageRollback", () => {
  it("republishes the old files under a higher sequence", () => {
    const first = release("0.3.26");
    const second = release("0.3.27", {
      published: publishedFrom(first.outputs),
    });
    const target = {
      bytes: first.outputs.get("releases/0.3.26/manifest.json"),
      signature: first.outputs.get("releases/0.3.26/manifest.json.sig"),
    };
    const rollback = stageRollback({
      published: publishedFrom(second.outputs),
      target,
      pinnedKeys: pinned,
      privateKeyPem: key.pem,
      now: NOW,
    });
    expect(rollback.manifest.sequence).toBe(3);
    expect(rollback.manifest.version).toBe("0.3.26-r3");
    expect(rollback.manifest.files).toEqual(first.manifest.files);
    expect(rollback.channel.releases["1"].version).toBe("0.3.26-r3");
    expect(
      parseManifest(rollback.outputs.get("releases/0.3.26-r3/manifest.json"))
        .sequence,
    ).toBe(3);
  });

  it("refuses a target that is not signed", () => {
    const first = release("0.3.26");
    const target = {
      bytes: first.outputs.get("releases/0.3.26/manifest.json"),
      signature: Buffer.from("{}"),
    };
    expect(() =>
      stageRollback({
        published: publishedFrom(first.outputs),
        target,
        pinnedKeys: pinned,
        privateKeyPem: key.pem,
      }),
    ).toThrow(/not signed/);
  });
});

describe("stageResign", () => {
  it("keeps the releases and moves sequence and expiry forward", () => {
    const first = release("0.3.26");
    const later = new Date(NOW.getTime() + 7 * 86_400_000);
    const { channel } = stageResign({
      published: publishedFrom(first.outputs),
      pinnedKeys: pinned,
      privateKeyPem: key.pem,
      now: later,
    });
    expect(channel.sequence).toBe(2);
    expect(channel.releases).toEqual(first.channel.releases);
    expect(new Date(channel.expiresAt).getTime()).toBeGreaterThan(
      new Date(first.channel.expiresAt).getTime(),
    );
  });

  it("refuses when nothing is published", () => {
    expect(() =>
      stageResign({
        published: null,
        pinnedKeys: pinned,
        privateKeyPem: key.pem,
      }),
    ).toThrow(/Nothing is published/);
  });
});

describe("parseManifest", () => {
  it("refuses an unsafe path, so a backend never writes outside its folder", () => {
    const bad = serialize({
      schema: 1,
      version: "1",
      sequence: 1,
      apiContract: 1,
      files: [{ path: "../../.bashrc", sha256: "a".repeat(64), size: 1 }],
    });
    expect(() => parseManifest(bad)).toThrow(/unsafe path/);
  });
});
