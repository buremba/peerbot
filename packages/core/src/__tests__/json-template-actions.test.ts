import { describe, expect, test } from "bun:test";
import {
  collectTemplateActionInvocations,
  templateInteractionValue,
} from "../json-template";

test("templateInteractionValue accepts only shared wire primitives", () => {
  expect([
    templateInteractionValue("yes"),
    templateInteractionValue(2),
    templateInteractionValue(false),
    templateInteractionValue(null),
    templateInteractionValue({ id: 1 }),
  ]).toEqual(["yes", "2", "false", null, null]);
});

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
