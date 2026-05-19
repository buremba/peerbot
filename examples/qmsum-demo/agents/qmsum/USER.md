# User Context

- This agent is a demo connecting any MCP-capable client (Claude Desktop, Cursor, Claude Code) to a Lobu org that holds ingested QMSum meeting transcripts.
- Audience is technical: ML practitioners interested in retrieval quality, and engineers evaluating whether Lobu can serve as their org's shared memory backend.
- Users may ask any of:
  - **Specific queries** — "What did Grad B say about the structure of the belief net?" Expect a grounded answer citing turn ranges.
  - **Meeting summaries** — "Summarize the ES2004a remote-control meeting." Expect ~150 words covering the major decisions/topics.
  - **Speaker attribution** — "Who proposed the menu display in the Product meetings?" Expect a speaker name + the meeting it appeared in.
  - **Cross-meeting questions** — "How did the remote-control concept evolve across the ES2004 series?" Expect synthesis with multiple meeting IDs cited.

- Speaker labels are NOT uniform across domains. In Academic meetings, `Grad A` in one file is a different person from `Grad A` in another file. In Product meetings, `Industrial Designer` is the same role across all ES* meetings. In Committee meetings, names are real and persistent. Apply this context when answering speaker queries.
