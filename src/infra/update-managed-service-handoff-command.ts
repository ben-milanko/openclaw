import path from "node:path";
import type { PackageUpdateTarget } from "../../packages/gateway-protocol/src/schema/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveRuntimeArgs } from "./runtime-worker-url.js";
import type { UpdateChannel } from "./update-channels.js";

export function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  packageTarget?: PackageUpdateTarget;
  acceptCapabilities?: boolean;
  admission?: "auto" | "installed";
  reapplyLocalOverrides?: boolean;
  execPath?: string;
  argv1?: string;
}): string[] {
  return resolveManagedServiceCliArgv(params, [
    "update",
    "--yes",
    "--json",
    ...(params.reapplyLocalOverrides ? ["--reapply-local-overrides"] : []),
    ...(params.acceptCapabilities ? ["--accept-capabilities"] : []),
    ...(params.admission ? ["--admission", params.admission] : []),
    ...(params.packageTarget
      ? ["--package-target", JSON.stringify(params.packageTarget)]
      : [
          ...(params.channel ? ["--channel", params.channel] : []),
          ...(params.tag ? ["--tag", params.tag] : []),
        ]),
    ...(typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? ["--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000)))]
      : []),
  ]);
}

export function resolveManagedServiceCliArgv(
  params: { execPath?: string; argv1?: string },
  args: string[],
): string[] {
  const execPath = params.execPath?.trim();
  const argv1 = params.argv1?.trim();
  if (execPath && argv1) {
    return [execPath, ...resolveRuntimeArgs(execPath), argv1, ...args];
  }
  if (execPath && !/^(?:node|bun)(?:\.exe)?$/iu.test(path.basename(execPath))) {
    return [execPath, ...args];
  }
  return ["openclaw", ...args];
}

export function formatManagedServiceUpdateCommand(
  params?: Omit<Parameters<typeof resolveUpdateCliArgv>[0], "execPath" | "argv1">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return formatCliCommand(
    resolveUpdateCliArgv(params ?? {})
      .toSpliced(3, 1)
      .map(quoteCliArg)
      .join(" "),
    env,
  );
}

export function buildManagedServiceHandoffUnavailableMessage(command: string): string {
  return [
    "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
    `Stop the foreground Gateway, run \`${command}\` from a shell, then launch the Gateway again. For a managed deployment, use its host's stop, update, and restart workflow.`,
  ].join("\n");
}
