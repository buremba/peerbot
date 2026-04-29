# Security

Lobu runs as a single Node process — gateway, embedded workers, embeddings, and the Owletto memory backend in-process; Postgres + Redis are user-provided externals. There is no Docker or Kubernetes deployment manager. This page documents what's isolated, what's policy, and what isn't a security boundary at all.

## Threat model

**Lobu is single-tenant.** Ownership is `(platform, userId)` — one Lobu instance serves your users / your bot, not adversarial third parties. Everything below is calibrated against that model. Do not deploy Lobu as a multi-tenant SaaS where mutually distrusting customers share an instance without first reviewing the gaps in this doc.

What we protect against:
- Prompt injection convincing an agent to misuse its tools.
- A skill or MCP server returning unexpected output.
- A worker process crashing or going OOM without taking the gateway down.
- Credential leaks from worker code or its tools.

What we **do not** claim to fully protect against:
- Sandbox escapes in `just-bash` or `isolated-vm` (both are best-effort, see below).
- A worker process bypassing `HTTP_PROXY` on macOS dev hosts (advisory at the language layer).
- A malicious agent declaring `nixPackages: ["nodejs"]` or other interpreters and using them to run arbitrary code through `just-bash` (the binary allowlist is agent-declared — treat each allowed binary as a capability).

If your threat model includes hostile code execution, run Lobu inside a stronger isolation primitive (per-tenant VM, gVisor, or Firecracker) at the *deployment* layer.

## What `just-bash` actually is

`just-bash` (`@mariozechner/pi-coding-agent`) is the shell sandbox the worker uses for every shell command an agent issues. It enforces:

- `maxCommandCount: 50_000`, `maxLoopIterations: 50_000`, `maxCallDepth: 50` — these help against DoS, **not** sandbox escape.
- A binary allowlist scoped to `/nix/store/` plus a known list (`owletto`, etc.). The allowlist is built at worker spawn from the agent's `nixPackages` config.

This is a **policy layer**, not a security boundary. If you allow `nodejs`, `python3`, `bash`, `sh`, `curl`, `git`, `bun`, `nix`, or any package manager into `nixPackages`, the agent has full code-execution capability and the depth caps no longer matter.

## What `isolated-vm` actually is

`isolated-vm` runs the MCP `execute` tool's user JS inside a V8 isolate with hard caps (64 MB / 60 s / 200 SDK calls / 1 MB output). The package is in maintenance mode and has had RCE-class issues historically (CVE-2022-39266 on ≤4.3.6 via untrusted V8 cached data). Upstream itself recommends a multi-process architecture for hostile code. Pin to the latest patched version, but do not lean on V8 isolates as the only boundary.

## Network egress

Workers run with `HTTP_PROXY=http://localhost:8118`. The gateway's in-process proxy enforces:
- **Allowlist mode** — only configured domains reachable.
- **Blocklist mode** — allow all except denied domains.
- **LLM egress judge** — risky domains get LLM verdict per request, with a 5 min cache and a circuit breaker.

In embedded mode, `HTTP_PROXY` is **advisory** at the language layer — a worker process that explicitly bypasses the env var can `connect()` directly. On Linux production hosts, the worker spawn path uses `systemd-run --user --scope` with `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1` so the kernel drops anything that isn't going to the local proxy. On macOS dev hosts there is no kernel-level enforcement.

## Worker process hardening (Linux)

When `systemd-run` is available on the host, `EmbeddedDeploymentManager` wraps each worker spawn in a transient unit with:

- `NoNewPrivileges=yes`
- `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `ReadWritePaths=<workspace>`
- `MemoryMax=512M`, `CPUQuota=200%`, `TasksMax=64`, `LimitNOFILE=1024`
- `IPAddressDeny=any`, `IPAddressAllow=127.0.0.1`
- `CapabilityBoundingSet=` (drop all)
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` (no `AF_PACKET` / raw sockets)

This closes most of the gap between "subprocess on the same host" and what Docker namespaces gave us. Recommended for any production deployment on Linux.

## Credentials

- Provider credentials and client secrets live on the gateway.
- The `secret-proxy` swaps `lobu_secret_<uuid>` placeholders for real keys at egress. **Workers never see real provider keys**, regardless of mode.
- MCP credentials are resolved per-user via device-auth and injected by the gateway proxy at call time.
- Third-party API auth (GitHub, Google, etc.) is handled by Owletto — workers call these through Owletto MCP tools and never see OAuth tokens.

A compromised worker session cannot leak global platform tokens or MCP client secrets.

## Skills and policy

Skills are executable, security-sensitive input:

- Use curated skill lists by default.
- Review skill `nixPackages` declarations: each binary on the allowlist is a capability, treat them as such.
- Skills declare `networkConfig.allowedDomains`; gateway egress controls apply on top.
- Destructive MCP tool calls require in-thread approval unless pre-approved in `[agents.<id>.tools]` in `lobu.toml`.

## What changed from earlier docs

Previous versions of this page described Kubernetes pod isolation, NetworkPolicies, gVisor, Kata, and per-pod PVCs. None of that is shipped any more — Lobu deploys as a single Node process. The kernel-level protections that mattered most (egress block, cgroup limits, capability drops) are now on the systemd-run worker spawn path on Linux. The rest were paying isolation costs for a multi-tenant deployment Lobu doesn't ship.
