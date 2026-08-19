# Owletto UI-surface classification

The `ui-review` gate normally requires a hosted before/after screenshot
comparison for any Owletto pointer change that isn't confined to `deploy/`.
That requirement exists to catch visual regressions — but a change with no
visual surface at all has nothing for a screenshot to show, and demanding one
anyway just teaches people to fabricate or skip the gate.

Your job: read the diff below (file list + unified diffs) and the merged
Owletto PR's own description (its test plan, if any), then judge whether this
EXACT range introduces or changes ANYTHING a human would see rendered:

- Chrome extension: popup, sidepanel, options page, injected page UI,
  notifications, icons/badges, any HTML/CSS.
- Mac app: SwiftUI/AppKit views, menu bar UI, window layouts, icons, copy
  shown in a window or menu.
- Any user-visible string surfaced in a rendered UI (not a log line, not an
  internal error message, not a tool/action description an LLM reads).

This is a fail-closed gate: `has_ui_surface` must be `true` whenever there is
real ambiguity, the range is large or mixed, or you cannot fully account for
every changed file's effect. Answering `false` incorrectly means a real visual
regression ships without a human ever looking at it — that is the failure
mode this exists to prevent. Only answer `false` when you can point at every
changed file and say concretely why it has no rendered surface.

`reasoning` must name the actual changed files and explain the call per file
(or per small group), not a general summary. `verification_summary` must cite
concrete evidence already in the diff/PR content (specific test files, pass
counts, what was run) — never invent evidence that isn't there; if none is
cited in the source material, say so rather than filling it in.

Final output is exactly one JSON object matching the provided schema. No
prose, no Markdown fences, no commentary before or after.

## Range under review
