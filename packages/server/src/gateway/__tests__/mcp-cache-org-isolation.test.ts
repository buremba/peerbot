/**
 * Regression coverage for the org-blind MCP caches (#5 + #6).
 *
 * The McpToolCache and the upstream-session key were keyed only by
 * (agentId, mcpId[, scope]) with NO organization. Both live in process-wide
 * singletons shared by every org. agentId is NOT globally unique (agents PK is
 * (organization_id, id) and ids are human slugs), so two orgs with the same
 * agentId+mcpId collided:
 *   #5 — org A's cached tool metadata/annotations satisfied an org B lookup,
 *        so a destructive tool the upstream marks safe for org A could
 *        auto-approve for org B (approval-gate poisoning).
 *   #6 — two orgs shared a single upstream Mcp-Session-Id (session-handle bleed).
 *
 * Both keys now derive the org from `runWithOrganizationContext`, so a lookup
 * in org B's context must NOT see org A's entry.
 */

import { describe, expect, test } from "bun:test";
import { orgContext } from "../../lobu/stores/org-context.js";
import { buildSessionKey } from "../auth/mcp/proxy-shared.js";
import { McpToolCache } from "../auth/mcp/tool-cache.js";

const ORG_A = "org-aaaaaaaa";
const ORG_B = "org-bbbbbbbb";
const AGENT = "shared-agent"; // same human slug in both orgs
const MCP = "github";

function inOrg<T>(orgId: string, fn: () => T): T {
  return orgContext.run({ organizationId: orgId }, fn);
}

describe("McpToolCache org isolation (#5)", () => {
  test("org A's cached tool list does NOT satisfy an org B lookup", () => {
    const cache = new McpToolCache();

    inOrg(ORG_A, () => {
      cache.set(MCP, [{ name: "delete_repo" }], AGENT);
    });

    // org A sees its own entry
    expect(inOrg(ORG_A, () => cache.get(MCP, AGENT))?.map((t) => t.name)).toEqual([
      "delete_repo",
    ]);

    // org B, same (agentId, mcpId), must get a clean miss — no cross-tenant bleed
    expect(inOrg(ORG_B, () => cache.get(MCP, AGENT))).toBeNull();
  });

  test("org A's annotations do NOT leak into org B's approval gate", () => {
    const cache = new McpToolCache();

    // Org A's upstream marks the tool read-only (would auto-approve).
    inOrg(ORG_A, () => {
      cache.set(
        MCP,
        [{ name: "wipe", annotations: { readOnlyHint: true } }],
        AGENT
      );
    });

    const orgATool = inOrg(ORG_A, () => cache.get(MCP, AGENT))?.[0];
    expect(orgATool?.annotations?.readOnlyHint).toBe(true);

    // Org B must NOT inherit org A's "safe" annotations — it gets a miss, which
    // at the proxy layer means `found=false` → approval required (fail closed).
    expect(inOrg(ORG_B, () => cache.get(MCP, AGENT))).toBeNull();
  });

  test("getServerInfo / getInstructions are also org-scoped", () => {
    const cache = new McpToolCache();
    inOrg(ORG_A, () => {
      cache.setServerInfo(MCP, { tools: [], instructions: "org-a only" }, AGENT);
    });
    expect(inOrg(ORG_A, () => cache.getInstructions(MCP, AGENT))).toBe(
      "org-a only"
    );
    expect(inOrg(ORG_B, () => cache.getInstructions(MCP, AGENT))).toBeUndefined();
    expect(inOrg(ORG_B, () => cache.getServerInfo(MCP, AGENT))).toBeNull();
  });
});

describe("MCP upstream session key org isolation (#6)", () => {
  test("two orgs with the same (agentId, mcpId, scope) get DIFFERENT session keys", () => {
    const scope = "user-1";
    const keyA = inOrg(ORG_A, () => buildSessionKey(AGENT, MCP, scope));
    const keyB = inOrg(ORG_B, () => buildSessionKey(AGENT, MCP, scope));

    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain(ORG_A);
    expect(keyB).toContain(ORG_B);
  });

  test("same org + same triple is stable (still shares a session within the org)", () => {
    const scope = "user-1";
    const first = inOrg(ORG_A, () => buildSessionKey(AGENT, MCP, scope));
    const second = inOrg(ORG_A, () => buildSessionKey(AGENT, MCP, scope));
    expect(first).toBe(second);
  });
});
