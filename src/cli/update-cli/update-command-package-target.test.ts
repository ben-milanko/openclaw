import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { create as createTar } from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { resolveUpdateCliArgv } from "../../infra/update-managed-service-handoff-command.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  parsePackageUpdateTargetJson,
  withPinnedPackageUpdate,
} from "./update-command-package-target.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = dirs.make("openclaw-exact-package-");
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
  const archive = path.join(root, "reviewed archive.tgz");
  // Multiple read chunks distinguish a complete streamed copy from a last-chunk write.
  const payload = dirs.make("openclaw-reviewed-package-");
  await fs.mkdir(path.join(payload, "package", "dist"), { recursive: true });
  await fs.writeFile(
    path.join(payload, "package", "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.10.5",
      scripts: { preinstall: "node -e \"require('fs').writeFileSync('lifecycle-ran','yes')\"" },
    }),
  );
  await fs.writeFile(
    path.join(payload, "package", "dist", "build-info.json"),
    JSON.stringify({ buildId: "reviewed-build" }),
  );
  await fs.writeFile(path.join(payload, "package", "padding.bin"), randomBytes(200_000));
  await createTar({ file: archive, cwd: payload, gzip: true }, ["package"]);
  const bytes = await fs.readFile(archive);
  return {
    root,
    bytes,
    target: {
      kind: "package" as const,
      path: archive,
      version: "2026.10.5",
      buildId: "reviewed-build",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

it("uses the reviewed bytes even when the source changes after admission, then cleans up", async () => {
  const { root, bytes, target } = await fixture();
  let pinned = "";
  await withPinnedPackageUpdate({ packageTarget: target }, async (opts) => {
    pinned = opts.tag!;
    expect(pinned).not.toBe(target.path);
    await fs.writeFile(target.path, "changed source");
    expect(await fs.readFile(pinned)).toEqual(bytes);
    expect(opts.packageTarget).toEqual(target);
    expect((await fs.stat(path.dirname(pinned))).mode & 0o777).toBe(0o700);
  });
  await expect(fs.stat(pinned)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(root)).toEqual([path.basename(target.path)]);
});

it("rejects a replaced archive before invoking any update operation", async () => {
  const { root, target } = await fixture();
  await fs.writeFile(target.path, "unreviewed replacement");
  const execute = vi.fn();
  await expect(withPinnedPackageUpdate({ packageTarget: target }, execute)).rejects.toMatchObject({
    reason: "package-target-integrity-mismatch",
  });
  expect(execute).not.toHaveBeenCalled();
  expect(await fs.readdir(root)).toEqual([path.basename(target.path)]);
});

it.each(["version", "buildId"] as const)(
  "rejects wrong archive %s before package execution",
  async (field) => {
    const { root, target } = await fixture();
    const execute = vi.fn(async () => fs.writeFile(path.join(root, "lifecycle-ran"), "yes"));
    await expect(
      withPinnedPackageUpdate(
        {
          packageTarget: {
            ...target,
            [field]: field === "version" ? "2026.10.6" : "another-build",
          },
        },
        execute,
      ),
    ).rejects.toMatchObject({ reason: "package-target-identity-mismatch" });
    expect(execute).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "lifecycle-ran"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("retains the private archive when accepted subprocess cleanup is uncertain", async () => {
  const { target, bytes } = await fixture();
  let pinned = "";
  const failure = new CommandProcessCleanupError();
  await expect(
    withPinnedPackageUpdate({ packageTarget: target }, async (opts) => {
      pinned = opts.tag!;
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await fs.readFile(pinned)).toEqual(bytes);
});

it("carries the exact target as one JSON argv value without a moving selector", async () => {
  const { target } = await fixture();
  const argv = resolveUpdateCliArgv({
    packageTarget: target,
    tag: "latest",
    channel: "stable",
    execPath: process.execPath,
    argv1: "/fixture/openclaw.mjs",
  });
  expect(parsePackageUpdateTargetJson(argv[argv.indexOf("--package-target") + 1]!)).toEqual(target);
  expect(argv).not.toContain("--tag");
  expect(argv).not.toContain("--channel");
});

it.each([{ tag: "latest" }, { channel: "dev" }, { reapplyLocalOverrides: true }])(
  "refuses a competing selector or byte-changing override: %j",
  async (conflict) => {
    const { target } = await fixture();
    await expect(
      withPinnedPackageUpdate({ packageTarget: target, ...conflict }, vi.fn()),
    ).rejects.toMatchObject({ reason: "conflicting-package-target" });
  },
);

it("keeps dry-run read-only and does not require the archive to exist", async () => {
  const { root, target } = await fixture();
  await fs.unlink(target.path);
  await withPinnedPackageUpdate({ packageTarget: target, dryRun: true }, async (opts) => {
    expect(opts.tag).toBe(target.path);
  });
  expect(await fs.readdir(root)).toEqual([]);
});
