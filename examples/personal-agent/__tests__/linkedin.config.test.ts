import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

describe("LinkedIn worker network configuration", () => {
  test("allows only the exact LinkedIn post-shortener host", () => {
    const agent = config.agents?.find(
      (candidate) => candidate.id === "personal-agent"
    );
    expect(agent?.network?.allowed).toContain("lnkd.in");
    expect(agent?.network?.allowed).not.toContain(".lnkd.in");
  });
});
