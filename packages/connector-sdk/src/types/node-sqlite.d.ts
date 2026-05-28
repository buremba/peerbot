declare module "node:sqlite" {
  interface DatabaseSyncOptions {
    readOnly?: boolean;
  }

  interface StatementSync {
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
