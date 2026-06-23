import { afterEach, describe, expect, it } from "bun:test";
import { signalWorkerGroup } from "../../gateway/orchestration/deployment-manager";

const realKill = process.kill;
afterEach(() => {
  process.kill = realKill;
});

describe("signalWorkerGroup", () => {
  it("signals the negative pid (process group), not just the child", () => {
    const calls: Array<[number, string | number]> = [];
    process.kill = ((pid: number, sig: string | number) => {
      calls.push([pid, sig]);
      return true;
    }) as typeof process.kill;
    const childKill = () => {
      throw new Error("child.kill should not be called when group send works");
    };

    const ok = signalWorkerGroup({ pid: 4242, kill: childKill as any }, "SIGTERM");

    expect(ok).toBe(true);
    expect(calls).toEqual([[-4242, "SIGTERM"]]);
  });

  it("falls back to child.kill when the group send fails", () => {
    process.kill = (() => {
      throw new Error("ESRCH");
    }) as typeof process.kill;
    let childSignal: NodeJS.Signals | undefined;
    const child = {
      pid: 99,
      kill: (sig: NodeJS.Signals) => {
        childSignal = sig;
        return true;
      },
    };

    const ok = signalWorkerGroup(child as any, "SIGKILL");

    expect(ok).toBe(true);
    expect(childSignal).toBe("SIGKILL");
  });

  it("returns false when there is no pid", () => {
    const ok = signalWorkerGroup({ pid: undefined, kill: () => true } as any, "SIGTERM");
    expect(ok).toBe(false);
  });

  it("returns false when both the group send and child.kill throw", () => {
    process.kill = (() => {
      throw new Error("ESRCH");
    }) as typeof process.kill;
    const child = {
      pid: 7,
      kill: () => {
        throw new Error("already gone");
      },
    };
    expect(signalWorkerGroup(child as any, "SIGKILL")).toBe(false);
  });
});
