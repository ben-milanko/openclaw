# GitHub

Read GitHub issues, pull requests, and commits beside your conversation in
OpenClaw. This official plugin is included with OpenClaw and enabled by default.

## What it adds

- Hover or focus issue and pull request links for a quick preview.
- Open supported GitHub links in the reader beside chat.
- Read descriptions, discussion and review comments, and expandable file diffs.
- Inspect pull request checks for the current head commit and refresh their status.

## Get started

Click a GitHub issue, pull request, or commit link in chat. The reader opens
beside the conversation. Use **Open on GitHub** for the full page.

Manage the plugin from **Plugins → GitHub**. If you use a plugin allowlist, include
`github` in that list. Disabling the plugin removes previews and the reader;
GitHub links then open externally.

## Tools and access

This plugin contributes the Control UI reader and link previews. It does not
register agent tools or a GitHub Copilot model provider. Gateway administrators
can read private repositories accessible to the selected GitHub credential.
Other viewers can read only public repositories. The reader does not change
issues, post comments, or merge pull requests. Use **Open on GitHub** for editing.

No GitHub sign-in is required for public content. When available, the reader uses
the selected agent's managed GitHub identity or the configured Control UI GitHub
token for API requests. GitHub rate limits still apply, and large discussions or
diffs can be incomplete; the reader marks those limits.

See the [GitHub plugin documentation](https://docs.openclaw.ai/plugins/github) for
reader behavior, access, and troubleshooting. For model access, see the separate
[GitHub Copilot provider](https://docs.openclaw.ai/providers/github-copilot).
