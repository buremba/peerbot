/**
 * Lightweight CDP Page
 *
 * A minimal Page-like interface over raw Chrome DevTools Protocol.
 * Used when Playwright's connectOverCDP crashes on browsers with many tabs
 * (it tries to enumerate all targets, which fails on real user browsers).
 *
 * Supports the subset of Playwright's Page API used by DOM scraper connectors:
 * goto, evaluate, waitForSelector, waitForTimeout, click, close.
 */

import { sdkLogger } from '../logger.js';

export class CdpPage {
  private ws: WebSocket;
  private sessionId: string;
  private targetId: string;
  private msgId = 1;

  private constructor(ws: WebSocket, sessionId: string, targetId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  /**
   * Create a new tab in the browser and return a CdpPage handle.
   * Does NOT enumerate existing tabs — avoids the Playwright crash.
   */
  static async create(browserWsUrl: string): Promise<CdpPage> {
    const ws = new WebSocket(browserWsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timeout')), 10000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket connection failed'));
      };
    });

    const sendBrowser = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
        const handler = (event: MessageEvent) => {
          const data = JSON.parse(event.data as string);
          if (data.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', handler);
            data.error ? reject(new Error(data.error.message)) : resolve(data.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    const { targetId } = await sendBrowser('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await sendBrowser('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    const page = new CdpPage(ws, sessionId, targetId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('DOM.enable');

    sdkLogger.info({ targetId }, '[CdpPage] Created tab');
    return page;
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
      const handler = (event: MessageEvent) => {
        const data = JSON.parse(event.data as string);
        if (data.id === id) {
          clearTimeout(timer);
          this.ws.removeEventListener('message', handler);
          data.error ? reject(new Error(data.error.message)) : resolve(data.result);
        }
      };
      this.ws.addEventListener('message', handler);
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }

  /** Navigate to a URL and wait for the page to load. */
  async goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    await this.send('Page.navigate', { url });

    // Wait for load event
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), timeout);
      const handler = (event: MessageEvent) => {
        const data = JSON.parse(event.data as string);
        if (data.method === 'Page.loadEventFired' && data.sessionId === this.sessionId) {
          clearTimeout(timer);
          this.ws.removeEventListener('message', handler);
          resolve();
        }
      };
      this.ws.addEventListener('message', handler);
    });
  }

  /** Evaluate a JavaScript expression in the page and return the result. */
  async evaluate<T = unknown>(expression: string | (() => T)): Promise<T> {
    const code = typeof expression === 'function' ? `(${expression.toString()})()` : expression;
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(
        `evaluate failed: ${exceptionDetails.text || exceptionDetails.exception?.description || 'unknown error'}`
      );
    }
    return result.value as T;
  }

  /**
   * Wait for a CSS selector to appear in the DOM.
   * Returns true if found, false on timeout.
   */
  async waitForSelector(selector: string, options?: { timeout?: number }): Promise<boolean> {
    const timeout = options?.timeout ?? 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await this.evaluate<boolean>(
        `!!document.querySelector(${JSON.stringify(selector)})`
      );
      if (found) return true;
      await this.waitForTimeout(500);
    }
    return false;
  }

  /** Click the first element matching a CSS selector. */
  async click(selector: string): Promise<void> {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  }

  /** Wait for a fixed duration. */
  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Get the current page URL. */
  async url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  /** Get the page title. */
  async title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  /** Close the tab and disconnect. */
  async close(): Promise<void> {
    try {
      await this.send('Page.close').catch(() => {});
      // Also close via Target API as fallback
      const id = this.msgId++;
      this.ws.send(
        JSON.stringify({
          id,
          method: 'Target.closeTarget',
          params: { targetId: this.targetId },
        })
      );
      await new Promise((r) => setTimeout(r, 300));
      this.ws.close();
    } catch {
      // Best-effort cleanup
    }
    sdkLogger.info({ targetId: this.targetId }, '[CdpPage] Tab closed');
  }
}
