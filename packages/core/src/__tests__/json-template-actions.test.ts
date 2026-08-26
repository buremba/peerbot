import { describe, expect, test } from "bun:test";
import { collectTemplateActionInvocations } from "../json-template";

describe("collectTemplateActionInvocations", () => {
  test("uses the same portable button aliases as every renderer", () => {
    expect(
      collectTemplateActionInvocations(
        {
          type: "card",
          children: [
            {
              type: "button",
              props: { onPress: "@approve", value: "yes" },
            },
            {
              type: "button",
              onSubmit: "@refresh",
            },
          ],
        },
        {}
      )
    ).toEqual([
      { action: "approve", value: "yes" },
      { action: "refresh", value: null },
    ]);
  });
});
