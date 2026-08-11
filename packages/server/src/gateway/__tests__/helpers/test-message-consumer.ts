import type { MessagePayload } from "@lobu/core";
import type { IMessageQueue } from "../../infrastructure/queue/index.js";
import type {
  DeploymentManager,
  OrchestratorConfig,
} from "../../orchestration/deployment-manager.js";
import { MessageConsumer } from "../../orchestration/message-consumer.js";

type RecordRunInput = (payload: MessagePayload, deploymentName: string) => Promise<void>;

/**
 * A `MessageConsumer` whose tooling fold is stubbed, for tests that drive
 * `handleMessage` with fakes and must NOT touch Postgres.
 *
 * `handleMessage` unconditionally calls `foldConnectorTooling`, which folds
 * org-scoped connector tooling via a live `connections` query. Tests that only
 * exercise routing / ownership / model-gating pass fakes for the queue and
 * deployment manager and otherwise never open a database; without this stub
 * they hit the real `connections` table, and fail (or flake, racing a
 * co-running file's schema reset) the moment that table is absent.
 */
export class TestMessageConsumer extends MessageConsumer {
  constructor(
    config: OrchestratorConfig,
    deploymentManager: DeploymentManager,
    queue: IMessageQueue = {} as IMessageQueue,
    recordRunInput: RecordRunInput = async () => {},
  ) {
    super(config, deploymentManager, queue, recordRunInput);
  }

  /** No connector tooling contribution — fake-based tests never need one. */
  protected async foldConnectorTooling(_data: MessagePayload): Promise<string> {
    return "";
  }
}
