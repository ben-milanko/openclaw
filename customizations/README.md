# Ben's OpenClaw development branch

Development integration lives on `dev/ben-custom` in
[ben-milanko/openclaw](https://github.com/ben-milanko/openclaw/tree/dev/ben-custom).
The fork's existing `main`, original feature branches and upstream PRs are not
rewritten. `ben-custom.json` is the source/provenance inventory, not deployment
configuration.

## Included changes

| Change | Provenance | Treatment |
| --- | --- | --- |
| Full audio attachment durations | [PR 171798](https://github.com/openclaw/openclaw/pull/171798), Ben Milanko | Original source change and regression tests |
| Native Steer/Queue follow-ups during active replies | [PR 168604](https://github.com/openclaw/openclaw/pull/168604), Cavit Erginsoy | Ported to the current native transport/outbox contracts |
| Completed iPhone bubble render gate | [PR 137462](https://github.com/openclaw/openclaw/pull/137462), roboclaw-bot and Colin | Ported with current metadata, tools, sources and resolver invalidation; dynamic content bypasses the gate |
| Continuous Talk listening cue | Development customization | Short bundled audio cue on listening transitions; direct WebRTC waits for audio and control readiness |
| Native Talk terminal-reply correlation | Development customization | Only the exact caller-owned terminal assistant uses the caller run key; source attestation and other row identities remain unchanged |

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

## Maintenance and deployment

Initial focused verification: 41 Gateway tests and 226 shared Swift tests in 10
suites passed. Source formatting, changed-test type-aware lint and independent
native review passed. The existing `readMirroredAssistantText` union-type lint
diagnostic was reproduced unchanged on the upstream baseline; it is not a new
finding introduced by this integration. iOS build, simulator UI and physical
playback verification remain separate outcomes in the inventory.

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
