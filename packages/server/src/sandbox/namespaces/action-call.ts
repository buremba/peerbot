import type { Env } from "../../index";
import type { ToolContext } from "../../tools/registry";

type AdminHandler = (args: any, env: Env, ctx: ToolContext) => Promise<unknown>;

export function createActionCaller(handler: AdminHandler, env: Env, ctx: ToolContext) {
  const manage = <T>(payload: object): Promise<T> =>
    handler(payload as never, env, ctx) as Promise<T>;

  const action = <T>(actionName: string, input: object = {}): Promise<T> => {
    // Spread caller input FIRST, then force `action` so a caller-supplied
    // `action` key (e.g. from a read-only query_sdk script) can never override
    // the discriminator and reach a write/delete handler.
    const { action: _ignored, ...rest } = input as Record<string, unknown>;
    return manage({ ...rest, action: actionName });
  };

  return { manage, action };
}
