# Agent Model — Behaviors, Surfaces, Workflows

> **Status (2026-08-11):** **Implemented.** Reactive Behaviors and durable event
> chaining are live — connector-sourced event, workspace-sourced event, schedule,
> and manual activation share one model and editor. The current contract and
> limits live in `docs/BEHAVIORS.md`; the end-to-end event lifecycle is in
> `docs/CONCEPTS.md`. Correlated workflow WAIT, joins, and the broader proactivity
> policy remain future work.

Historical pointer for the design that consolidated the agent config surface
(superseding the separate "Reach", "Watchers", and "Schedules" tabs). The
original discussion remains in git history; the working documentation is
`docs/BEHAVIORS.md` and `docs/CONCEPTS.md`.
