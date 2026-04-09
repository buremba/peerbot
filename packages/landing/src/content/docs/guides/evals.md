---
title: Evaluations
description: Define automated quality checks for your agent with YAML eval files.
---

Evals are automated test cases that verify your agent behaves correctly. They live in your agent directory and run via the CLI.

## Quick start

```bash
# Run all evals for the default agent
npx @lobu/cli eval

# Run a specific eval
npx @lobu/cli eval ping

# Run with a different model
npx @lobu/cli eval --model anthropic/claude-sonnet-4

# CI mode (JSON output, exit 1 on failure)
npx @lobu/cli eval --ci --output results.json
```

The gateway must be running (`npx @lobu/cli run`) before running evals.

## Eval file format

Eval files are YAML, stored in `agents/{name}/evals/`. Each file defines a test case with one or more conversational turns and assertions.

### Minimal example

```yaml
# agents/my-agent/evals/ping.yaml
name: ping
description: Agent responds to a greeting

turns:
  - content: "Hello, are you there?"
    assert:
      - type: contains
        value: "hello"
        options: { case_insensitive: true }
```

### Full example

```yaml
name: follows-instructions
description: Agent follows formatting instructions without adding unrequested content
trials: 3
timeout: 60
tags: [behavioral]
rubric: follows-instructions.rubric.md

scoring:
  pass_threshold: 0.8

turns:
  - content: "List exactly 3 benefits of remote work. Use bullet points."
    assert:
      - type: regex
        value: "^[\\s\\S]*[-•].*[-•].*[-•]"
        weight: 0.5
      - type: llm-rubric
        value: "Lists exactly 3 benefits (not 2, not 4+), uses bullet points"
        weight: 0.5
```

### Multi-turn example

Test context retention across multiple messages:

```yaml
name: context-retention
description: Agent remembers context across turns
trials: 3
timeout: 60
tags: [behavioral, multi-turn]

turns:
  - content: "My name is Alice and I work at Acme Corp."

  - content: "What company do I work at?"
    assert:
      - type: contains
        value: "Acme"
        weight: 0.5
      - type: llm-rubric
        value: "Correctly recalls Acme Corp from the previous message"
        weight: 0.5

  - content: "And what's my name?"
    assert:
      - type: contains
        value: "Alice"
```

Turns without `assert` are sent but not graded — useful for setup messages.

## Schema reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Eval name (used in reports) |
| `description` | string | — | What this eval tests |
| `trials` | number | 3 | Number of times to run (for statistical confidence) |
| `timeout` | number | 120 | Per-turn timeout in seconds |
| `tags` | string[] | — | Tags for filtering (e.g., `smoke`, `behavioral`) |
| `rubric` | string | — | Path to a rubric markdown file (relative to eval file) |
| `scoring.pass_threshold` | number | 0.8 | Minimum score (0–1) for a trial to pass |
| `turns` | array | required | Conversational turns (min 1) |

### Turn

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | The user message to send |
| `assert` | array | Assertions to check against the agent's response |

### Assertion

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | required | `contains`, `regex`, or `llm-rubric` |
| `value` | string | required | The value to check (substring, regex pattern, or grading criteria) |
| `weight` | number | 1 | Relative weight in scoring |
| `options.case_insensitive` | boolean | false | Case-insensitive match (for `contains`) |

### Assertion types

**`contains`** — checks if the agent's response includes a substring.
```yaml
- type: contains
  value: "Acme Corp"
  options: { case_insensitive: true }
```

**`regex`** — tests the response against a regular expression (case-insensitive by default).
```yaml
- type: regex
  value: "\\d{3}-\\d{4}"  # matches a phone number pattern
```

**`llm-rubric`** — sends the response to an LLM for qualitative grading. Use this for subjective criteria that can't be captured with string matching.
```yaml
- type: llm-rubric
  value: "Response is friendly, acknowledges the user's question, and provides a helpful answer"
```

## Rubrics

For more detailed grading, create a rubric file. It's a markdown document with criteria the LLM evaluates against.

```markdown
<!-- agents/my-agent/evals/follows-instructions.rubric.md -->
# Instruction Following

## Direct Compliance
- Agent addresses the specific request, not a tangential topic
- Response format matches the formatting instructions given
- Exact count requested is respected (no more, no fewer)

## Boundary Respect
- Agent does not add unrequested features or disclaimers
- No unsolicited follow-up questions

## Tone
- Professional and helpful
- No unnecessary apologies or hedging
```

Reference it from your eval:
```yaml
rubric: follows-instructions.rubric.md
```

When a rubric is present, its score is weighted 50% alongside assertion scores (50%).

## Scoring

- Each assertion produces a score of 0 or 1, weighted by `weight`
- Trial score = weighted average of all assertion scores (+ rubric if present)
- A trial **passes** if score >= `pass_threshold` (default 0.8)
- The eval **pass rate** = fraction of trials that passed
- Multiple trials (default 3) provide statistical confidence against non-deterministic responses

## CLI options

| Flag | Description |
|------|-------------|
| `-a, --agent <id>` | Agent ID (defaults to first in `lobu.toml`) |
| `-g, --gateway <url>` | Gateway URL (default: from `.env` or `http://localhost:8080`) |
| `-m, --model <model>` | Model to evaluate (e.g., `anthropic/claude-sonnet-4`) |
| `--trials <n>` | Override trial count for all evals |
| `--ci` | CI mode: JSON output, exit code 1 on any failure |
| `--output <file>` | Write results to a JSON file |
| `--list` | List available evals without running them |

## Results and reports

Results are automatically saved to `agents/{name}/evals/.results/` as JSON after each run. A comparison report is generated at `agents/{name}/evals/evals-report.md` showing:

- Model comparison table (pass rate, avg score, latency, tokens)
- Rubric details per model
- Failed trial transcripts with trace IDs (for debugging via [observability](/guides/observability/))

Run evals with different `--model` values to build a comparison across providers.

## Directory structure

```
agents/my-agent/
  evals/
    ping.yaml
    context-retention.yaml
    follows-instructions.yaml
    follows-instructions.rubric.md
    .results/                          # auto-generated
      openrouter-claude-sonnet_1234.json
      gemini-gemini-pro_5678.json
    evals-report.md                    # auto-generated comparison
```
