import { createHash } from "node:crypto";
import fsSync, { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertDirectoryIdentitySync, readDirectoryIdentity } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  PackageUpdateTargetSchema,
  type PackageUpdateTarget,
} from "../../../packages/gateway-protocol/src/schema/config.js";
import { readArchiveEntry } from "../../infra/archive.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { readPackageName } from "../../infra/package-json.js";
import { createPrivateSqliteTempDirectory } from "../../infra/sqlite-private-directory.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { readPackageUpdateIdentity } from "./update-command-package-identity.js";

export function parsePackageUpdateTarget(value: unknown): PackageUpdateTarget {
  if (!Value.Check(PackageUpdateTargetSchema, value) || !path.isAbsolute(value.path)) {
    throw new UpdatePreMutationError(
      "invalid-package-target",
      "Package target requires an absolute archive path, exact version, build ID, and SHA-256.",
    );
  }
  return { ...value };
}

export function parsePackageUpdateTargetJson(value: string): PackageUpdateTarget {
  let target: unknown;
  try {
    target = JSON.parse(value);
  } catch {
    throw new UpdatePreMutationError("invalid-package-target", "--package-target must be JSON.");
  }
  return parsePackageUpdateTarget(target);
}

/** npm lifecycle scripts may run during installation, before staged admission. */
async function assertArchiveIdentity(archive: string, target: PackageUpdateTarget) {
  const readJson = async (entry: string): Promise<unknown> =>
    JSON.parse(
      (await readArchiveEntry(archive, entry, { maxBytes: 1024 * 1024 })).toString("utf8"),
    );
  let manifest: unknown;
  let build: unknown;
  try {
    manifest = await readJson("package/package.json");
    build = await readJson("package/dist/build-info.json");
  } catch {
    throw new UpdatePreMutationError(
      "package-target-identity-mismatch",
      "The reviewed archive must contain readable package and build identities; no update was started.",
    );
  }
  if (
    !isRecord(manifest) ||
    !isRecord(build) ||
    manifest.name !== "openclaw" ||
    manifest.version !== target.version ||
    build.buildId !== target.buildId
  ) {
    throw new UpdatePreMutationError(
      "package-target-identity-mismatch",
      "Archive package name, version, or build ID does not match the reviewed target; no update was started.",
    );
  }
}

/** The package manager only reads a private copy whose bytes match the request. */
export async function withPinnedPackageUpdate<T>(
  opts: UpdateCommandOptions,
  use: (opts: UpdateCommandOptions) => Promise<T>,
): Promise<T> {
  if (!opts.packageTarget) {
    return await use(opts);
  }
  const target = parsePackageUpdateTarget(opts.packageTarget);
  if (opts.tag || opts.sha || opts.channel || opts.sourceUpdate || opts.reapplyLocalOverrides) {
    throw new UpdatePreMutationError(
      "conflicting-package-target",
      "--package-target cannot be combined with another target, channel switch, or local overrides.",
    );
  }
  // A dry run validates the request shape only and never stages or hashes an archive.
  if (opts.dryRun) {
    return await use({ ...opts, packageTarget: target, tag: target.path });
  }
  const rootIdentity = await readDirectoryIdentity(resolvePreferredOpenClawTmpDir());
  const tempRoot = rootIdentity.realPath;
  const assertRoot = () => assertDirectoryIdentitySync(tempRoot, rootIdentity);
  assertRoot();
  const directory = await createPrivateSqliteTempDirectory(tempRoot, "openclaw-update-pinned-");
  assertRoot();
  const identity = await readDirectoryIdentity(directory);
  const archive = path.join(directory, "openclaw.tgz");
  let retain = false;
  try {
    const source = await fs.open(
      target.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await source.stat()).isFile()) {
        throw new UpdatePreMutationError(
          "invalid-package-target",
          "Package archive is not a regular file.",
        );
      }
      const output = await fs.open(archive, "wx", 0o600);
      const hash = createHash("sha256");
      try {
        for await (const chunk of source.createReadStream({ autoClose: false })) {
          hash.update(chunk);
          await output.writeFile(chunk);
        }
        await output.sync();
      } finally {
        await output.close();
      }
      if (hash.digest("hex") !== target.sha256) {
        throw new UpdatePreMutationError(
          "package-target-integrity-mismatch",
          "Package archive SHA-256 does not match the reviewed target; no update was started.",
        );
      }
    } finally {
      await source.close();
    }
    await assertArchiveIdentity(archive, target);
    return await use({ ...opts, packageTarget: target, tag: archive });
  } catch (error) {
    // Accepted subprocesses may still need the archive until their owner settles.
    retain = hasCommandProcessCleanupError(error);
    throw error;
  } finally {
    if (!retain) {
      await removePathWithinRoot({
        rootDir: tempRoot,
        relativePath: path.basename(directory),
        recursive: true,
        symlinks: "unlink",
        assertBeforeMutation: () => {
          assertRoot();
          if (fsSync.lstatSync(directory, { bigint: true, throwIfNoEntry: false })) {
            assertDirectoryIdentitySync(directory, identity);
          }
        },
      });
    }
  }
}

/** Runs before candidate lifecycle, admission, and the already-current decision. */
export async function assertPackageUpdateTargetIdentity(root: string, target: PackageUpdateTarget) {
  const [name, identity] = await Promise.all([
    readPackageName(root),
    readPackageUpdateIdentity(root),
  ]);
  if (
    name !== "openclaw" ||
    identity.version !== target.version ||
    identity.buildId !== target.buildId
  ) {
    throw new UpdatePreMutationError(
      "package-target-identity-mismatch",
      "Staged package name, version, or build ID does not match the reviewed target; the live installation was left unchanged.",
    );
  }
}
