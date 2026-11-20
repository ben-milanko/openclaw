import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  waitForConfirmModal,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it("does not warn for a thread without an enabled scheduled worker", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const target = sessionRow("agent:main:finished-review", "Finished review", Date.now(), {
      hasAutomation: false,
      hasActiveRun: false,
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([target]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:main",
    });
    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      const row = page.locator(".session-data-row").filter({ hasText: "Finished review" });
      await row.getByRole("button", { name: "Open session menu" }).click();
      await activateSelfRemovingControl(
        page
          .locator("openclaw-session-menu")
          .getByRole("menuitem", { name: "Archive session", exact: true }),
      );
      await waitForPatch(
        gateway,
        (params) => params.key === target.key && params.archived === true,
      );
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      expect(await page.locator("openclaw-modal-dialog dialog[open]").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("confirms a mixed bulk archive before dispatching the original targets", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const main = sessionRow("agent:main:main", "Main", Date.now());
    const targets = [
      sessionRow("agent:main:scheduled", "Scheduled review", Date.now() - 1000, {
        hasAutomation: true,
      }),
      sessionRow("agent:main:ordinary", "Ordinary review", Date.now() - 2000, {
        hasAutomation: false,
      }),
    ];
    const gateway = await installMockGateway(page, {
      featureMethods: ["sessions.patch", "sessions.patchMany"],
      methodResponses: {
        "sessions.list": sessionsListResponse([main, ...targets]),
        "sessions.patchMany": {
          outcomes: targets.map((row) => ({ ok: true, key: row.key, agentId: "main" })),
        },
      },
      sessionKey: main.key,
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const rowFor = (key: string) =>
        page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      for (const row of targets) {
        await rowFor(row.key).click({ modifiers: ["Alt"] });
      }
      const requestArchive = async () => {
        await rowFor(targets[0]!.key).click({ button: "right" });
        await activateSelfRemovingControl(
          page
            .locator("openclaw-session-menu")
            .getByRole("menuitem", { name: "Archive 2", exact: true }),
        );
        return waitForConfirmModal(page);
      };
      let dialog = await requestArchive();
      await dialog
        .getByText("Archiving pauses attached scheduled workers.", { exact: false })
        .waitFor();
      expect(await gateway.getRequests("sessions.patchMany")).toEqual([]);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests("sessions.patchMany")).toEqual([]);
      dialog = await requestArchive();
      await dialog.getByRole("button", { name: "Archive 2", exact: true }).click();
      const patch = await gateway.waitForRequest("sessions.patchMany");
      expect(requireRecord(patch.params).targets).toEqual(
        targets.map((row) => ({ key: row.key, agentId: "main", expectedSessionId: row.sessionId })),
      );
      expect(requireRecord(patch.params).patch).toEqual({ archived: true });
      expect(await gateway.getRequests("sessions.patchMany")).toHaveLength(1);
      expect(await gateway.getRequests("cron.update")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it.each(["sidebar", "sessions page", "header"])(
    "warns before archiving an idle scheduled worker from the %s",
    async (surface) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const main = sessionRow("agent:main:main", "Main", Date.now());
      const target = sessionRow(
        "agent:main:scheduled-review",
        "Scheduled review",
        Date.now() - 1000,
        {
          hasAutomation: true,
          hasActiveRun: false,
        },
      );
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([main, target]),
          "sessions.patch": {},
        },
        sessionKey: main.key,
      });
      try {
        await page.goto(
          surface === "header"
            ? controlUiSessionUrl(suite.server.baseUrl, target.key)
            : `${suite.server.baseUrl}${surface === "sidebar" ? "chat" : "sessions"}`,
        );
        const row =
          surface !== "sessions page"
            ? page.locator(`.sidebar-recent-session[data-session-key="${target.key}"]`)
            : page.locator(".session-data-row").filter({ hasText: "Scheduled review" });
        await row.waitFor({ state: "visible" });
        await captureUiProof(
          suite,
          page,
          `scheduled-worker-${surface.replace(" ", "-")}-before.png`,
        );
        const requestArchive = async () => {
          if (surface === "sidebar") {
            await row.hover();
            await activateSelfRemovingControl(row.locator("[data-sidebar-session-archive]"));
          } else if (surface === "header") {
            await page.locator(".chat-header-session-menu__trigger").click();
            await activateSelfRemovingControl(
              page
                .locator("openclaw-chat-header-session-menu")
                .getByRole("menuitem", { name: "Archive session", exact: true }),
            );
          } else {
            await row.getByRole("button", { name: "Open session menu" }).click();
            await activateSelfRemovingControl(
              page
                .locator("openclaw-session-menu")
                .getByRole("menuitem", { name: "Archive session", exact: true }),
            );
          }
          return waitForConfirmModal(page);
        };
        let dialog = await requestArchive();
        await dialog
          .getByText("Archiving pauses attached scheduled workers.", { exact: false })
          .waitFor();
        await dialog
          .getByText("Restoring a session does not resume its workers", { exact: false })
          .waitFor();
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        await captureUiProof(
          suite,
          page,
          `scheduled-worker-${surface.replace(" ", "-")}-warning.png`,
        );
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        await row.waitFor({ state: "visible" });
        dialog = await requestArchive();
        await dialog.getByRole("button", { name: "Archive session", exact: true }).click();
        const patch = await waitForPatch(
          gateway,
          (params) => params.key === target.key && params.archived === true,
        );
        expect(requireRecord(patch.params)).toMatchObject({
          key: target.key,
          expectedSessionId: target.sessionId,
          archived: true,
        });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
        expect(await gateway.getRequests("cron.update")).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});
