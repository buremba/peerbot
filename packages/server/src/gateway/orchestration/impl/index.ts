/**
 * Deployment manager implementations.
 *
 * Embedded is the only supported deployment mode; the gateway spawns
 * workers as subprocesses on the same host (or systemd-run scopes on
 * Linux). Docker and Kubernetes deployment managers were removed when we
 * consolidated on embedded mode.
 */

export { EmbeddedDeploymentManager } from "./embedded-deployment.js";
