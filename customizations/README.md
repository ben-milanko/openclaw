# Ben's OpenClaw development branch

Development integration lives on `dev/ben-custom` in
[ben-milanko/openclaw](https://github.com/ben-milanko/openclaw/tree/dev/ben-custom).
The fork's existing `main`, original feature branches and upstream PRs are not
rewritten. `ben-custom.json` is the source/provenance inventory, not deployment
configuration.

## Included changes

| Change                                              | Provenance                                                                            | Treatment                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Full audio attachment durations                     | [PR 171798](https://github.com/openclaw/openclaw/pull/171798), Ben Milanko            | Original source change and regression tests                                                                                                  |
| Native Steer/Queue follow-ups during active replies | [PR 168604](https://github.com/openclaw/openclaw/pull/168604), Cavit Erginsoy         | Ported to the current native transport/outbox contracts                                                                                      |
| Completed iPhone bubble render gate                 | [PR 137462](https://github.com/openclaw/openclaw/pull/137462), roboclaw-bot and Colin | Ported with current metadata, tools, sources and resolver invalidation; dynamic content bypasses the gate                                    |
| Continuous Talk listening cue                       | Development customization                                                             | Short bundled audio cue on listening transitions; direct WebRTC waits for audio and control readiness                                        |
| Native Talk terminal-reply correlation              | Development customization                                                             | Only the exact caller-owned terminal assistant uses the caller run key; source attestation and other row identities remain unchanged         |
| iOS automation-session visibility                   | Development customization                                                             | Persistent **Show automation sessions** filter in the sidebar and All Sessions, off by default; jobs and open conversations remain unchanged |

The render gate is a bounded reduction in unnecessary work, **not a claim that
all physical-iPhone scrolling lag is resolved**. Relative timestamp updates
remain owned by the footer's minute-cadence clock.

### Source credit

The busy-send port comes from Cavit Erginsoy's commits
`858fbbbaf40efeb05a68e06b3ecc6f6ec31b54a0`,
`9d6406e4181558249cd47d69e85539ffe41095b7`,
`6f96a96d74d168008bcc481e9ca2becae06cf15d`, and
`7f2ad38f95a116409c1ca37c842330e1996434c4`.
The completed-bubble proposal is `3efb58c99d290f9a849440b7db231ddfee68cdfb`
(roboclaw-bot), with Colin's compilation repair
`40fd6d369ac8199c3d7c9356f0bfe458baeefb35`. The development port retains their
contribution while adapting it to newer upstream render inputs.

## Scoped storage decision

The requested chat-fix integration includes the additive native client-state
outbox v10 migration from PR 168604: nullable queue mode and authorization
columns, with claim/retry guards so an older client cannot silently replay an
explicit Steer/Queue choice as the session default. Existing ordinary outbox
rows retain their behavior. This is a development-fork implementation decision
within the requested chat-fix scope, not a Gateway schema change.

Development installation must use a distinct local bundle identity and preserve
the existing App Store application and its storage. Build and migration tests
are required before installing that development application.

## Deliberately not duplicated

The older scheduled-WebChat-audio workaround is superseded by the upstream
producer-owned internal-source admission and delivery fix. Do not reintroduce
special message-target or prompt exceptions beside that owner.

[PR 11464](https://github.com/openclaw/openclaw/pull/11464) remains historically
closed and unmerged. Its old Gemini image-model fallback is not resurrected:
current Google text forward compatibility deliberately excludes image surfaces,
which have a dedicated supported image provider.

Third-party plugin compatibility overlays are maintained separately from core
OpenClaw. Private settings, credentials, authentication caches, personal
automation payloads, runtime backups and diagnostic evidence do not belong in
this public source fork.

## Automation-session filter verification

Verified filter code revision: `49b30c0ad5d43891f3571cf81e17578f117bb4d0`.
The iOS simulator compiled and 87 focused tests passed (107 parameterized
executions). The real UI workflow passed: both lists respond to the toggle,
Briefings and human chats remain visible, and both enabled and disabled states
survive relaunches. Six synthetic screenshots were inspected; shown/hidden and
menu proof was delivered as downloadable chat attachments. Temporary demo rows
and UI-test instrumentation were restored before building the phone application.

The native source hash is
`b5e91050cc600734ef1904ffeb534068114fa5914e7f563f5c53b2fa54e97c9e`.
Independent Claude Code review was clean through P2; the Codex review CLI was
unavailable because it rejected a required helper option. The native localization
check reproduced the previous development head's same three missing translations;
this filter adds no untranslated strings. Phone installation and physical-device
interaction remain distinct from the simulator proof.

## Maintenance and deployment

### Archived-session sidebar behavior

The iOS sidebar uses the same Active scope as All Sessions, including for pinned
and selected rows. A complete active roster is authoritative: a selected key
omitted from it is not synthesized as a placeholder. Cached or partial rosters
still allow placeholders while loading. This does not close the open chat.

New Chat creates the Gateway session before switching, and RootTabs immediately
refreshes the roster whenever the selected key changes. A newly switched row may
therefore wait for that refresh before appearing in the sidebar; the conversation
itself stays open. This bounded tradeoff avoids maintaining a second archive-key
cache or fetching the entire archive on every sidebar refresh.

Archive-fix revision: `460c3d9b72f9a981c20e564f12204acc30a88246`.
All 67 focused tests passed (89 executions), as did both synthetic before/after
UI tests. Both screenshots were inspected and delivered. The complete native
source hash is pinned in the inventory; screenshot fixtures were removed before
signing. Opus second review found no blocking issue. The original AutoReview P2
placeholder suggestion was checked against the source and declined as the display
tradeoff described above, not relabeled scoped-clean.

Development build 3 passed deep strict signature and all four bundle/profile
checks. Installation and a fresh phone app listing confirm 2026.10.3/build 3.
The phone was locked when launch was attempted, so launch and live connection
readback remain pending unlock. Physical sidebar interaction is not independently
observed. The Store app and live Gateway were not changed.

The following verification covers the original chat and Talk integration.
Verified code revision: `c9088c0e1da5fd3007970772196a7b7c71a47f03`.
The native source manifest is pinned in the inventory. Verification passed:
41 Gateway tests, 226 shared Swift tests in 10 suites, and 79 focused iOS tests
in four suites with complete simulator compilation. The full macOS application
compiled, and a separately identified iPhone development application built and
passed deep strict signature verification. Pre/post-build source hashes matched.
Source formatting, changed-test type-aware lint and independent native review
passed. The existing `readMirroredAssistantText` union-type lint diagnostic was
reproduced unchanged on the upstream baseline; it is not a new finding.

Two synthetic UI test runs passed against the exact upstream baseline and this
candidate. Inspected before/after screenshots show blocked versus enabled Send,
the Steer/Queue menu, and the follow-up remaining visible with Stop available.
A UUID-scoped temporary outbox and exact text/mode/original-run admission receipt
prevented optimistic failed-delivery bubbles from passing the test. Instrumentation
was confined to isolated proof copies; seven production owners remained unchanged,
then all fixture edits were restored byte-exactly. The unsigned fixture applications
are not the signed development artifact. Screenshots and signed artifacts are
private deliverables, not public source or release uploads.

Physical-phone installation, listening-sound playback and broader scrolling-lag
measurement are still pending an awake, connected phone. Neither the existing
Store application nor the running Gateway was replaced by this task.

Update from an explicitly pinned upstream revision in an isolated checkout.
Reconcile the tracked PR heads and any newer Ben-authored OpenClaw PRs, preserving
authors and original branches. Remove a custom delta only after proving upstream
contains its intended behavior. Resolve conflicts at the owning source contract,
then rerun the affected tests and review the exact candidate head before a
normal fast-forward push. Never force-push this branch or push the upstream's
`main`.

Source upkeep does not deploy or restart a running Gateway and does not publish
App Store/TestFlight releases. Native installation and physical-device playback
remain separate verification outcomes. The inventory records proof gaps
explicitly until those checks complete.
