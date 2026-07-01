# docs/archive/ — historical design & worklog docs

These documents are **shipped, superseded, or complete**. They are kept as the design
record and post-mortem history — **not** as current guidance. The live source of truth is
`/CLAUDE.md`. Do not treat anything here as a description of how the system works *today*.

| File | What it was | Status |
|---|---|---|
| `vps-hub-plan.md` | VPS-as-the-hub architecture plan | SHIPPED (Phases 1–2 built) |
| `vps-hub-phase1.md` | Multi-tenant hub passthrough | SHIPPED 2026-06-29 |
| `vps-hub-phase2.md` | GPU bridge + multi-provider catalog | BUILD COMPLETE (live GPU-transcode test → `gputest.md` Phase 2) |
| `termination-system-plan.md` | Universal termination / lease system | SHIPPED (migrations `…000009`/`…000010`) |
| `web-rebuild-spec.md` | Front-end rebuild (shadcn / Base UI) | SHIPPED 2026-06-28→29 |
| `audit-fixes.md` | 2026-06-30 soundness-audit fix worklog | COMPLETE (all committed) |
| `vps-hub-livetest.md` | VPS-hub passthrough live-test runbook | SUPERSEDED by `hevcpasstest.md` |
| `gputest.md` | GPU provider/protocol uniformity + transcode-bridge live test | Phase 1 SHIPPED (`a7347a6`) + Phase 2 PASSED 2026-07-01 |
| `hevcpasstest.md` | VPS-hub passthrough live-test runbook | COMPLETE — proven live (supersedes `vps-hub-livetest.md`) |
| `srt-rtmp-split-plan.md` | Contingency: split SRT/RTMP to reopen TCP-only GPUs | SUPERSEDED — the shipped hub bridge already feeds the GPU mpegts-over-TCP |
| `phase5-review-notes.md` | Phase 5 (billing/margin integrity) deferred-items log | Phase 5 SHIPPED; open items to revisit at billing go-live |
| `Slimcast_Complete_Architecture_Blueprint.pdf` | Pre-2026-06-29 architecture blueprint | STALE (predates the all-in-one deletion) |

_Archived 2026-06-30 during a docs cleanup; extended 2026-07-01 (scattered root planning docs
consolidated into `docs/`). If a doc here becomes relevant again, lift the specific fact into
`CLAUDE.md` rather than reviving the whole file._
