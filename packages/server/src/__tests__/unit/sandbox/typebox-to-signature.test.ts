import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";
import { typeboxToSignature } from "../../../sandbox/typebox-to-signature";

describe("typeboxToSignature", () => {
  it("renders primitives", () => {
    expect(typeboxToSignature(Type.String())).toBe("string");
    expect(typeboxToSignature(Type.Number())).toBe("number");
    expect(typeboxToSignature(Type.Integer())).toBe("number");
    expect(typeboxToSignature(Type.Boolean())).toBe("boolean");
    expect(typeboxToSignature(Type.Null())).toBe("null");
  });

  it("renders enum literal unions", () => {
    const schema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
    expect(typeboxToSignature(schema)).toBe("'asc' | 'desc'");
  });

  it("renders arrays with primitive element", () => {
    expect(typeboxToSignature(Type.Array(Type.String()))).toBe("string[]");
  });

  it("uses Array<> syntax when element has spaces", () => {
    const schema = Type.Array(
      Type.Union([Type.Literal("a"), Type.Literal("b")])
    );
    expect(typeboxToSignature(schema)).toBe("Array<'a' | 'b'>");
  });

  it("renders objects with required + optional fields", () => {
    const schema = Type.Object({
      id: Type.Number(),
      name: Type.Optional(Type.String()),
    });
    const sig = typeboxToSignature(schema);
    expect(sig).toContain("id: number;");
    expect(sig).toContain("name?: string;");
  });

  it("annotates with description as inline comment", () => {
    const schema = Type.Object({
      status: Type.String({ description: "Entity status" }),
    });
    const sig = typeboxToSignature(schema);
    expect(sig).toContain("// Entity status");
  });

  it("inlines nested objects", () => {
    const schema = Type.Object({
      outer: Type.Object({
        inner: Type.String(),
      }),
    });
    const sig = typeboxToSignature(schema);
    expect(sig).toContain("outer: {");
    expect(sig).toContain("inner: string;");
  });

  it("caps recursion at maxDepth", () => {
    // A self-reference would recurse forever; use a fake depth trap.
    const schema: unknown = { type: "object", properties: {} };
    (schema as Record<string, unknown>).properties = { self: schema };
    expect(typeboxToSignature(schema as never, { maxDepth: 2 })).toContain(
      "unknown"
    );
  });

  it("handles const literal", () => {
    const schema = Type.Literal("fixed");
    expect(typeboxToSignature(schema)).toBe("'fixed'");
  });

  it("escapes backslashes in literal values", () => {
    // Regression: an unescaped trailing backslash would produce the
    // unterminated literal `'\'`.
    const schema = Type.Literal("path\\to\\file");
    expect(typeboxToSignature(schema)).toBe("'path\\\\to\\\\file'");
  });

  it("escapes single quotes in literal values", () => {
    const schema = Type.Literal("it's");
    expect(typeboxToSignature(schema)).toBe("'it\\'s'");
  });
});
