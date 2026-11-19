import { expect, it, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import { assertPublicGitHubRepository, loadControlUiGitHubPreview } from "./preview.js";

it.each(["preview", "detail"] as const)(
  "%s keeps administrator-only private content separate from public readers",
  async (kind) => {
    const target = { kind: "issue" as const, owner: "example", repo: `private-${kind}`, number: 1 };
    const repositoryUrl = `https://api.github.com/repos/example/private-${kind}`;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === repositoryUrl) {
        return Response.json({ id: 123, private: true, visibility: "private" });
      }
      if (url === `${repositoryUrl}/issues/1`) {
        return Response.json({
          title: "Private fixture",
          body: "Private body",
          state: "open",
          created_at: "2026-10-01T08:00:00Z",
          updated_at: "2026-10-01T09:00:00Z",
          comments: 0,
          user: { login: "fixture-user" },
          repository_url: repositoryUrl,
        });
      }
      throw new Error("Unexpected synthetic request");
    });
    let admin = true;
    const assertSelected = () => {
      if (!admin) {
        throw new Error("synthetic administrator retired");
      }
    };
    const identity: ControlUiGitHubPreviewIdentity = {
      token: "synthetic-private-reader-token",
      cacheScope: "same-credential-and-reader",
      allowPrivateRepositories: true,
      assertSelected,
      revalidate: async () => assertSelected(),
    };
    const read = (selected: ControlUiGitHubPreviewIdentity) =>
      kind === "preview"
        ? loadControlUiGitHubPreview(target, selected, fetcher)
        : loadGitHubDetail(target, selected, fetcher);
    await expect(read(identity)).resolves.toMatchObject({ title: "Private fixture" });
    const publicIdentity: ControlUiGitHubPreviewIdentity = {
      token: identity.token,
      cacheScope: identity.cacheScope,
      assertSelected: () => {},
      revalidate: async () => {},
    };
    await expect(read(publicIdentity)).rejects.toMatchObject({ statusCode: 404 });
    admin = false;
    await expect(read(identity)).rejects.toThrow("synthetic administrator retired");
  },
);

it("keeps public agent search admission public even when handed a private reader identity", async () => {
  const identity: ControlUiGitHubPreviewIdentity = {
    token: "synthetic-private-reader-token",
    cacheScope: "private-reader",
    allowPrivateRepositories: true,
    assertSelected: () => {},
    revalidate: async () => {},
  };
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ id: 123, private: true, visibility: "private" }),
  );
  await expect(
    assertPublicGitHubRepository(
      "https://api.github.com/repos/example/private",
      fetcher,
      identity.token,
      identity,
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
});
