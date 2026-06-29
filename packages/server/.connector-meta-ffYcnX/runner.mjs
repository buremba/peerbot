
import { pathToFileURL } from 'node:url';

async function main() {
  try {
    const mod = await import(pathToFileURL(process.argv[2]).href);

    let RuntimeClass = null;
    for (const key of Object.keys(mod)) {
      const val = mod[key];
      if (
        typeof val === 'function' &&
        val.prototype &&
        typeof val.prototype.sync === 'function' &&
        typeof val.prototype.execute === 'function'
      ) {
        RuntimeClass = val;
        break;
      }
    }

    if (!RuntimeClass && mod.default) {
      const val = mod.default;
      if (
        typeof val === 'function' &&
        val.prototype &&
        typeof val.prototype.sync === 'function' &&
        typeof val.prototype.execute === 'function'
      ) {
        RuntimeClass = val;
      }
    }

    if (!RuntimeClass) {
      throw new Error(
        'No ConnectorRuntime class found in compiled code. Expected a class with sync() and execute() methods.'
      );
    }

    const instance = new RuntimeClass();
    const def = instance.definition;

    if (!def || typeof def !== 'object') {
      throw new Error('ConnectorRuntime class must expose a definition property.');
    }

    const metadata = {
      key: def.key || null,
      name: def.name || null,
      description: def.description || null,
      version: def.version || null,
      kind: def.kind || null,
      authSchema: def.authSchema || null,
      webhook: def.webhook || null,
      feeds: def.feeds || null,
      actions: def.actions || null,
      optionsSchema: def.optionsSchema || null,
      faviconDomain: def.faviconDomain || null,
      mcpConfig: def.mcpConfig || null,
      openapiConfig: def.openapiConfig || null,
      requiredCapability: def.requiredCapability || null,
      runtime: def.runtime || null,
    };

    process.send({ success: true, metadata });
  } catch (error) {
    process.send({ success: false, error: error.message });
  }
}

main();
