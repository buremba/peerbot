#!/usr/bin/env bun
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubRepositoryError = exports.KubernetesError = exports.DispatcherError = void 0;
// Error types
class DispatcherError extends Error {
    operation;
    cause;
    constructor(operation, message, cause) {
        super(message);
        this.operation = operation;
        this.cause = cause;
        this.name = "DispatcherError";
    }
}
exports.DispatcherError = DispatcherError;
class KubernetesError extends Error {
    operation;
    cause;
    constructor(operation, message, cause) {
        super(message);
        this.operation = operation;
        this.cause = cause;
        this.name = "KubernetesError";
    }
}
exports.KubernetesError = KubernetesError;
class GitHubRepositoryError extends Error {
    operation;
    username;
    cause;
    constructor(operation, username, message, cause) {
        super(message);
        this.operation = operation;
        this.username = username;
        this.cause = cause;
        this.name = "GitHubRepositoryError";
    }
}
exports.GitHubRepositoryError = GitHubRepositoryError;
//# sourceMappingURL=types.js.map