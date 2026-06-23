import { describe, expect, test } from "bun:test";
import {
  BaseError,
  ConfigError,
  ErrorCode,
  getErrorMessage,
  OrchestratorError,
  WorkerError,
  WorkspaceError,
} from "../errors";

describe("getErrorMessage", () => {
  test("returns .message for Error and subclasses", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage(new TypeError("bad type"))).toBe("bad type");
    expect(getErrorMessage(new ConfigError("bad config"))).toBe("bad config");
  });

  test("stringifies non-Error throws", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
    expect(getErrorMessage({ code: "X" })).toBe("[object Object]");
  });
});

describe("BaseError (via WorkerError)", () => {
  test("sets name, message, and prototype chain", () => {
    const err = new WorkerError("spawn", "boom");
    expect(err).toBeInstanceOf(WorkerError);
    expect(err).toBeInstanceOf(BaseError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WorkerError");
    expect(err.message).toBe("boom");
    expect(err.operation).toBe("spawn");
    expect(err.cause).toBeUndefined();
  });

  test("getFullMessage without cause", () => {
    const err = new WorkerError("spawn", "boom");
    expect(err.getFullMessage()).toBe("WorkerError: boom");
  });

  test("getFullMessage with plain Error cause", () => {
    const cause = new Error("underlying");
    const err = new WorkerError("spawn", "boom", cause);
    expect(err.getFullMessage()).toBe(
      "WorkerError: boom\nCaused by: underlying"
    );
    expect(err.cause).toBe(cause);
  });

  test("getFullMessage with nested BaseError cause recurses", () => {
    const inner = new WorkspaceError("init", "no perms");
    const outer = new WorkerError("spawn", "boom", inner);
    expect(outer.getFullMessage()).toBe(
      "WorkerError: boom\nCaused by: WorkspaceError: no perms"
    );
  });

  test("getFullMessage with deeply nested BaseError cause", () => {
    const innermost = new ConfigError("bad config");
    const middle = new WorkspaceError("init", "no perms", innermost);
    const outer = new WorkerError("spawn", "boom", middle);
    expect(outer.getFullMessage()).toBe(
      "WorkerError: boom\nCaused by: WorkspaceError: no perms\nCaused by: ConfigError: bad config"
    );
  });

  test("toJSON includes name, message, operation, stack", () => {
    const err = new WorkerError("spawn", "boom");
    const json = err.toJSON();
    expect(json.name).toBe("WorkerError");
    expect(json.message).toBe("boom");
    expect(json.operation).toBe("spawn");
    expect(typeof json.stack).toBe("string");
    expect(json.cause).toBeUndefined();
  });

  test("toJSON omits operation if not set", () => {
    const err = new ConfigError("bad");
    const json = err.toJSON();
    expect(json.name).toBe("ConfigError");
    expect(json).not.toHaveProperty("operation");
  });

  test("toJSON serialises a plain Error cause as its message", () => {
    const cause = new Error("underlying");
    const err = new WorkerError("spawn", "boom", cause);
    const json = err.toJSON();
    expect(json.cause).toBe("underlying");
  });

  test("toJSON serialises a nested BaseError cause via toJSON()", () => {
    const inner = new WorkspaceError("init", "no perms");
    const outer = new WorkerError("spawn", "boom", inner);
    const json = outer.toJSON();
    expect(json.cause).toMatchObject({
      name: "WorkspaceError",
      message: "no perms",
      operation: "init",
    });
  });
});

describe("WorkerError", () => {
  test("name is WorkerError", () => {
    const err = new WorkerError("op", "msg");
    expect(err.name).toBe("WorkerError");
    expect(err.operation).toBe("op");
  });
});

describe("WorkspaceError", () => {
  test("name is WorkspaceError and operation is set", () => {
    const err = new WorkspaceError("write", "denied");
    expect(err.name).toBe("WorkspaceError");
    expect(err.operation).toBe("write");
    expect(err).toBeInstanceOf(BaseError);
  });
});

describe("OrchestratorError", () => {
  test("stores code, details, shouldRetry default false", () => {
    const err = new OrchestratorError(
      ErrorCode.DEPLOYMENT_CREATE_FAILED,
      "create failed"
    );
    expect(err.name).toBe("OrchestratorError");
    expect(err.code).toBe(ErrorCode.DEPLOYMENT_CREATE_FAILED);
    expect(err.details).toBeUndefined();
    expect(err.shouldRetry).toBe(false);
  });

  test("stores explicit details and shouldRetry", () => {
    const details = { foo: "bar" };
    const err = new OrchestratorError(
      ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
      "queue failed",
      details,
      true
    );
    expect(err.details).toBe(details);
    expect(err.shouldRetry).toBe(true);
  });

  test("toJSON includes code, details, shouldRetry", () => {
    const err = new OrchestratorError(
      ErrorCode.DEPLOYMENT_DELETE_FAILED,
      "delete failed",
      { id: "abc" },
      true
    );
    const json = err.toJSON();
    expect(json.code).toBe(ErrorCode.DEPLOYMENT_DELETE_FAILED);
    expect(json.details).toEqual({ id: "abc" });
    expect(json.shouldRetry).toBe(true);
    expect(json.name).toBe("OrchestratorError");
  });

  test("fromDatabaseError builds from Error", () => {
    const dbErr = Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
      detail: "no socket",
    });
    const err = OrchestratorError.fromDatabaseError(dbErr);
    expect(err).toBeInstanceOf(OrchestratorError);
    expect(err.code).toBe(ErrorCode.DATABASE_CONNECTION_FAILED);
    expect(err.message).toBe("Database error: connection refused");
    expect(err.details).toEqual({ code: "ECONNREFUSED", detail: "no socket" });
    expect(err.shouldRetry).toBe(true);
    expect(err.cause).toBe(dbErr);
  });

  test("fromDatabaseError handles non-Error inputs", () => {
    const err = OrchestratorError.fromDatabaseError("plain string failure");
    expect(err.message).toBe("Database error: plain string failure");
    expect(err.code).toBe(ErrorCode.DATABASE_CONNECTION_FAILED);
    expect(err.shouldRetry).toBe(true);
  });
});

describe("ConfigError", () => {
  test("has correct name and prototype", () => {
    const err = new ConfigError("bad config");
    expect(err.name).toBe("ConfigError");
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(BaseError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("bad config");
  });

  test("getFullMessage works without cause", () => {
    const err = new ConfigError("bad config");
    expect(err.getFullMessage()).toBe("ConfigError: bad config");
  });
});

describe("ErrorCode enum", () => {
  test("values are stable strings", () => {
    // The enum's runtime values must equal their key names — log/Sentry
    // metadata depends on these being self-describing strings.
    for (const key of Object.keys(ErrorCode) as Array<keyof typeof ErrorCode>) {
      expect(ErrorCode[key]).toBe(key as unknown as ErrorCode);
    }
  });
});
