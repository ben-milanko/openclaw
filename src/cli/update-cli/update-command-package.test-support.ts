import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import * as processRunner from "../../process/exec.js";

export async function createPackageInstallFixture(
  base: string,
  candidateVersion = "1.0.0",
  buildId?: string,
) {
  const globalRoot = path.join(base, "prefix", "lib", "node_modules");
  const target = createNpmTarget(globalRoot);
  const root = path.join(globalRoot, "openclaw");
  await writePackageRoot(root, "1.0.0");
  if (buildId) {
    await fs.writeFile(path.join(root, "dist", "build-info.json"), JSON.stringify({ buildId }));
    await writePackageDistInventory(root);
  }
  const launcher = path.join(base, "prefix", "bin", "openclaw");
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, "previous launcher\n");
  const installedPrefixes: string[] = [];
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
    let stdout = "";
    if (argv.join(" ") === "npm --version") {
      stdout = "12.0.0\n";
    } else if (argv.join(" ") === "npm root -g") {
      stdout = `${globalRoot}\n`;
    } else if (argv.includes("--prefix") && (argv.includes("install") || argv.includes("i"))) {
      const prefix = argv[argv.indexOf("--prefix") + 1];
      if (!prefix) {
        throw new Error("Missing actual staged prefix");
      }
      installedPrefixes.push(prefix);
      await writePackageRoot(
        path.join(prefix, "lib", "node_modules", "openclaw"),
        candidateVersion,
      );
      if (buildId) {
        const stagedRoot = path.join(prefix, "lib", "node_modules", "openclaw");
        await fs.writeFile(
          path.join(stagedRoot, "dist", "build-info.json"),
          JSON.stringify({ buildId }),
        );
        await writePackageDistInventory(stagedRoot);
      }
      await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
      await fs.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher\n");
    } else {
      throw new Error(`Unexpected package command: ${argv.join(" ")}`);
    }
    return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
  });
  const expectOriginalInstallation = async () => {
    expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version).toBe(
      "1.0.0",
    );
  };
  const params = {
    root,
    installKind: "package" as const,
    tag: candidateVersion,
    timeoutMs: 1000,
    startedAt: Date.now(),
    progress: {},
    installEnv: {},
    installTarget: target,
  };
  return { params, root, launcher, installedPrefixes, expectOriginalInstallation };
}
