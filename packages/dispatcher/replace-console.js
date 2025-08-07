const fs = require('fs');
const path = require('path');

const files = [
  'src/github/repository-manager.ts',
  'src/http-server.ts', 
  'src/slack/oauth-handler.ts',
  'src/slack/token-manager.ts',
  'src/kubernetes/job-manager.ts',
  'src/simple-http.ts'
];

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Add logger import if not present
  if (\!content.includes('import logger from')) {
    const importMatch = content.match(/^(import .+;?\n)+/m);
    if (importMatch) {
      const lastImportEnd = importMatch.index + importMatch[0].length;
      const relPath = path.relative(path.dirname(filePath), path.join(__dirname, 'src/logger.ts')).replace(/\.ts$/, '');
      content = content.slice(0, lastImportEnd) + `import logger from "${relPath}";\n` + content.slice(lastImportEnd);
    }
  }
  
  // Replace console statements
  content = content.replace(/console\.log\(/g, 'logger.info(');
  content = content.replace(/console\.error\(/g, 'logger.error(');
  content = content.replace(/console\.warn\(/g, 'logger.warn(');
  content = content.replace(/console\.debug\(/g, 'logger.debug(');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated ${file}`);
});
