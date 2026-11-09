import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { hasGatewayAdminScope } from "./operator-scopes.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

export class GitHubReadRequestInactiveError extends Error {
  constructor() {
    super("GitHub request is no longer active. Try again.");
  }
}

export async function prepareControlUiGitHubIdentity(
  { context, client, signal, hasCurrentClientAuthority }: GatewayRequestHandlerOptions,
  agentId: string,
) {
  const config = context.getRuntimeConfig();
  const configuredIdentity = () => {
    const current = context.getRuntimeConfig();
    if (resolveConfiguredGitHubHost(current) !== "github.com") {
      return undefined;
    }
    return (
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "system" })
    );
  };
  // Nested plugin requests may decorate the client; transport authority retains its owner.
  const assertActive = () => {
    if (
      signal?.aborted ||
      (hasCurrentClientAuthority
        ? !hasCurrentClientAuthority()
        : client?.connId &&
          !context.getClientConnIds?.((current) => current === client).has(client.connId))
    ) {
      throw new GitHubReadRequestInactiveError();
    }
  };
  assertActive();
  // Without a managed selection, retain service/env/anonymous access without
  // probing native gh. Both paths must still own the selection at delivery.
  const identity = configuredIdentity()
    ? await prepareGitHubReadIdentity({
        config,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        agentId,
        allowStale: true,
        getCurrentConfig: () => context.getRuntimeConfig(),
        assertActive,
        refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      })
    : undefined;
  const assertSelected =
    identity?.assertSelected ??
    (() => {
      assertActive();
      if (configuredIdentity()) {
        throw new GitHubIdentityError("changed");
      }
    });
  if (!hasGatewayAdminScope(client)) {
    return { identity, assertSelected };
  }
  // Shared service/agent credentials may reveal private content only to an
  // administrator. Recheck the live connection for dispatch and cached delivery.
  const assertPrivateSelected = () => {
    assertActive();
    assertSelected();
    if (!hasGatewayAdminScope(client)) {
      throw new GitHubReadRequestInactiveError();
    }
  };
  const privateIdentity = gitHubPublicApi.resolveControlUiGitHubReadIdentity(
    identity,
    assertPrivateSelected,
  );
  return { identity: privateIdentity, assertSelected: privateIdentity.assertSelected };
}
