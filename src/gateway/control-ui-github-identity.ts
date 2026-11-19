import { prepareGitHubReaderIdentity } from "./github-reader-identity.js";
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
  const { identity, assertSelected } = await prepareGitHubReaderIdentity(context, agentId, assertActive);
  if (!hasGatewayAdminScope(client)) {
    return { identity, assertSelected };
  }
  // Shared service/agent credentials reveal private content only to a current administrator.
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
