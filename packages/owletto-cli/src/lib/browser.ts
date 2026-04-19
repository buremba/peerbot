import { spawn } from 'node:child_process';

export function openInBrowser(url: string): boolean {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    if (platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
