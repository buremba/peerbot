export function printText(text: string) {
  process.stdout.write(`${text}\n`);
}

export function printError(message: string) {
  process.stderr.write(`error: ${message}\n`);
}
