import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { createControlUiHandlers } from "./control-ui.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

describe("private GitHub reader access", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["controlUi.githubPreview", "controlUi.githubDetail"])(
    "%s allows administrators without exposing cached private content to other readers",
    async (method) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: { controlUi: { github: { token: "synthetic-private-reader-token" } } },
      };
      setRuntimeConfigSnapshot(cfg);
      const repo = method === "controlUi.githubPreview" ? "private-preview" : "private-detail";
      const repositoryUrl = `https://api.github.com/repos/octocat/${repo}`;
      const itemStarted = createDeferred();
      const itemResponse = createDeferred();
      let holdItem = false;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer synthetic-private-reader-token",
          );
          const url = input instanceof Request ? input.url : input.toString();
          if (url === repositoryUrl) {
            return Response.json({ id: 123, private: true, visibility: "private" });
          }
          if (url === `${repositoryUrl}/pulls/572`) {
            if (holdItem) {
              itemStarted.resolve();
              await itemResponse.promise;
            }
            return Response.json({
              title: "Private pull request",
              state: "open",
              created_at: "2026-10-01T08:00:00Z",
              updated_at: "2026-10-01T09:00:00Z",
              user: { login: "octocat" },
              body: "Private description",
              comments: 0,
              review_comments: 0,
              changed_files: 0,
              base: { repo: { url: repositoryUrl }, ref: "main" },
              head: { ref: "fix", sha: "a".repeat(40) },
            });
          }
          return Response.json([]);
        }),
      );
      const client = { ...identifiedClient("private-reader"), connId: "private-reader" };
      client.connect.scopes = ["operator.read"];
      const requestOptions = createControlUiRequestOptions(() => cfg);
      const target = { owner: "octocat", repo, kind: "pull", number: 572 };
      const handler = expectDefined(createControlUiHandlers()[method], "GitHub reader handler");
      const read = async (refresh = false) => {
        const respond = vi.fn<RespondFn>();
        await handler({
          ...requestOptions({ ...target, refresh }, respond, { client }),
          hasCurrentClientAuthority: () => true,
        });
        return respond;
      };
      const expectUnavailable = (respond: ReturnType<typeof vi.fn<RespondFn>>) =>
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );

      expectUnavailable(await read());
      client.connect.scopes = ["operator.admin"];
      expect(await read()).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ title: "Private pull request" }),
        undefined,
      );
      client.connect.scopes = ["operator.read"];
      expectUnavailable(await read());

      client.connect.scopes = ["operator.admin"];
      holdItem = true;
      const pending = read(true);
      await itemStarted.promise;
      client.connect.scopes = ["operator.read"];
      itemResponse.resolve();
      expectUnavailable(await pending);
    },
  );
});
