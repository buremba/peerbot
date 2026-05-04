import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOBU_CONFIG_DIR } from "./context.js";

const THREADS_FILE = join(LOBU_CONFIG_DIR, "threads.json");

interface ThreadEntry {
  threadId: string;
  updatedAt: string;
}

interface StoredThreads {
  /** Keyed as `${context}|${agent}`. */
  threads: Record<string, ThreadEntry>;
}

async function readStore(): Promise<StoredThreads> {
  try {
    const raw = await readFile(THREADS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredThreads>;
    return { threads: parsed.threads ?? {} };
  } catch {
    return { threads: {} };
  }
}

async function writeStore(store: StoredThreads): Promise<void> {
  await mkdir(LOBU_CONFIG_DIR, { recursive: true });
  await writeFile(THREADS_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

function key(context: string, agent: string): string {
  return `${context}|${agent}`;
}

export async function getLastThread(
  context: string,
  agent: string
): Promise<string | undefined> {
  const store = await readStore();
  return store.threads[key(context, agent)]?.threadId;
}

export async function setLastThread(
  context: string,
  agent: string,
  threadId: string
): Promise<void> {
  const store = await readStore();
  store.threads[key(context, agent)] = {
    threadId,
    updatedAt: new Date().toISOString(),
  };
  await writeStore(store);
}
