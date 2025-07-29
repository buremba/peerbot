#!/usr/bin/env bun
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerError = exports.GcsError = exports.SessionError = void 0;
// Error types
class SessionError extends Error {
    sessionKey;
    code;
    cause;
    constructor(sessionKey, code, message, cause) {
        super(message);
        this.sessionKey = sessionKey;
        this.code = code;
        this.cause = cause;
        this.name = "SessionError";
    }
}
exports.SessionError = SessionError;
class GcsError extends Error {
    operation;
    cause;
    constructor(operation, message, cause) {
        super(message);
        this.operation = operation;
        this.cause = cause;
        this.name = "GcsError";
    }
}
exports.GcsError = GcsError;
class WorkerError extends Error {
    workerId;
    operation;
    cause;
    constructor(workerId, operation, message, cause) {
        super(message);
        this.workerId = workerId;
        this.operation = operation;
        this.cause = cause;
        this.name = "WorkerError";
    }
}
exports.WorkerError = WorkerError;
//# sourceMappingURL=types.js.map