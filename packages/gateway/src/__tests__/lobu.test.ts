import { afterEach, describe, expect, test } from "bun:test";
import { Lobu } from "../lobu";

const originalMemoryUrl = process.env.MEMORY_URL;
const originalAdminPassword = process.env.ADMIN_PASSWORD;

afterEach(() => {
  if (originalMemoryUrl === undefined) {
    delete process.env.MEMORY_URL;
  } else {
    process.env.MEMORY_URL = originalMemoryUrl;
  }

  if (originalAdminPassword === undefined) {
    delete process.env.ADMIN_PASSWORD;
  } else {
    process.env.ADMIN_PASSWORD = originalAdminPassword;
  }
});

describe("Lobu", () => {
  test("applies config.memory to the gateway environment", () => {
    delete process.env.MEMORY_URL;

    new Lobu({
      redis: "redis://localhost:6379",
      memory: "https://memory.example.com",
    });

    expect(process.env.MEMORY_URL).toBe("https://memory.example.com");
  });
});
