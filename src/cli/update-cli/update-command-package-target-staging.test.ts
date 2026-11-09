import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { stagePackageInstallUpdate } from "./update-command-package.js";
import { createPackageInstallFixture } from "./update-command-package.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { version: "3.0.0", buildId: "reviewed-build" },
  { version: "2.0.0", buildId: "unreviewed-build" },
  // Even an otherwise already-current package must satisfy the caller's build pin.
  { version: "1.0.0", buildId: "unreviewed-build" },
])("rejects staged identity drift before admission or no-op: %j", async (actual) => {
  await withTestDir({ prefix: "update-pinned-identity-" }, async (base) => {
    const fixture = await createPackageInstallFixture(base, actual.version, actual.buildId);
    const candidateAdmission = vi.fn();
    const target = {
      kind: "package" as const,
      path: path.join(base, "reviewed.tgz"),
      version: actual.version === "1.0.0" ? "1.0.0" : "2.0.0",
      buildId: "reviewed-build",
      sha256: "a".repeat(64),
    };
    await expect(
      stagePackageInstallUpdate({
        ...fixture.params,
        tag: target.path,
        packageTarget: target,
        beforeVerifyCandidate: candidateAdmission,
        pauseBeforeVerification: true,
      }),
    ).rejects.toMatchObject({ reason: "package-target-identity-mismatch" });
    expect(candidateAdmission).not.toHaveBeenCalled();
    await fixture.expectOriginalInstallation();
  });
});

it("admits the matching package identity without activating the live installation", async () => {
  await withTestDir({ prefix: "update-pinned-admission-" }, async (base) => {
    const fixture = await createPackageInstallFixture(base, "2.0.0", "reviewed-build");
    const stage = await stagePackageInstallUpdate({
      ...fixture.params,
      tag: path.join(base, "reviewed.tgz"),
      packageTarget: {
        kind: "package",
        path: path.join(base, "reviewed.tgz"),
        version: "2.0.0",
        buildId: "reviewed-build",
        sha256: "a".repeat(64),
      },
      pauseBeforeVerification: true,
    });
    try {
      expect(
        JSON.parse(await fs.readFile(path.join(stage.root, "package.json"), "utf8")).version,
      ).toBe("2.0.0");
      await fixture.expectOriginalInstallation();
    } finally {
      await stage.close();
    }
  });
});
