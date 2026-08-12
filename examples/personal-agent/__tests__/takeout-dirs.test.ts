/**
 * Regression coverage for the takeout-dir footgun.
 *
 * An apply run without these env vars once wrote `./takeout/...` over every
 * prod `takeout_dir`, and each takeout feed then read an empty directory. Two
 * properties have to hold at the same time, and they pull in opposite
 * directions:
 *
 *   1. a full apply must FAIL rather than silently substitute a path, and
 *   2. `lobu apply --only agents` must still LOAD — it never touches a feed,
 *      so it must not require connector env vars.
 *
 * Which is why resolution is lazy: constructing the config is safe, reading
 * `takeout_dir` is what enforces (1).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { localTakeoutDir, takeoutConfig } from "../takeout-dirs.ts";

const VARS = ["GOOGLE_YOUTUBE_TAKEOUT_DIR", "LOCAL_TAKEOUT_ROOT"];
const saved = new Map<string, string | undefined>();
for (const v of VARS) saved.set(v, process.env[v]);

afterEach(() => {
  for (const v of VARS) {
    const was = saved.get(v);
    if (was === undefined) delete process.env[v];
    else process.env[v] = was;
  }
});

function clear() {
  for (const v of VARS) delete process.env[v];
}

describe("localTakeoutDir", () => {
  test("throws naming the missing variable rather than returning a relative path", () => {
    clear();
    expect(() => localTakeoutDir("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt")).toThrow(
      /GOOGLE_YOUTUBE_TAKEOUT_DIR is not set/
    );
    // The specific regression: `./takeout/yt` is a plausible-looking string
    // that apply would happily persist over a correct absolute path.
    try {
      localTakeoutDir("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt");
    } catch (err) {
      expect(String(err)).not.toContain("./takeout/yt");
    }
  });

  test("an explicit variable wins", () => {
    clear();
    process.env.GOOGLE_YOUTUBE_TAKEOUT_DIR = "/Users/x/Downloads/Takeout 3";
    expect(localTakeoutDir("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt")).toBe(
      "/Users/x/Downloads/Takeout 3"
    );
  });

  test("LOCAL_TAKEOUT_ROOT supplies a shared parent when set explicitly", () => {
    clear();
    process.env.LOCAL_TAKEOUT_ROOT = "/archives";
    expect(localTakeoutDir("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt")).toBe(
      "/archives/yt"
    );
  });

  test("an explicit variable still beats the shared root", () => {
    clear();
    process.env.LOCAL_TAKEOUT_ROOT = "/archives";
    process.env.GOOGLE_YOUTUBE_TAKEOUT_DIR = "/explicit";
    expect(localTakeoutDir("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt")).toBe(
      "/explicit"
    );
  });
});

describe("takeoutConfig laziness", () => {
  test("building the config does not throw when the variable is unset", () => {
    clear();
    // This is what `--only agents` depends on: the module loads, the feed
    // config object exists, and nothing resolves until someone reads it.
    expect(() =>
      takeoutConfig("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt")
    ).not.toThrow();
  });

  test("reading takeout_dir is what fails closed", () => {
    clear();
    const cfg = takeoutConfig("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt");
    expect(() => cfg.takeout_dir).toThrow(/is not set/);
  });

  test("reading resolves the current value, not one captured at build time", () => {
    clear();
    const cfg = takeoutConfig("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt");
    process.env.GOOGLE_YOUTUBE_TAKEOUT_DIR = "/set/afterwards";
    expect(cfg.takeout_dir).toBe("/set/afterwards");
  });

  test("serializing the config surfaces the failure — apply maps via JSON", () => {
    clear();
    const cfg = takeoutConfig("GOOGLE_YOUTUBE_TAKEOUT_DIR", "yt");
    // A getter that stayed invisible to serialization would let a full apply
    // write `{}` for the feed config instead of failing.
    expect(() => JSON.stringify(cfg)).toThrow(/is not set/);

    process.env.GOOGLE_YOUTUBE_TAKEOUT_DIR = "/Users/x/Takeout 3";
    expect(JSON.parse(JSON.stringify(cfg))).toEqual({
      takeout_dir: "/Users/x/Takeout 3",
    });
  });
});
