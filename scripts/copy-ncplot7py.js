import { copyFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const copyDir = (src, dest) => {
  try {
    mkdirSync(dest, { recursive: true });
  } catch (err) {
    // Directory may already exist
  }

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '__pycache__' || entry.name === 'node_modules') {
      continue;
    }
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
};

// Copy ncplot7py to dist
const src = 'ncplot7py';
const dest = 'dist/ncplot7py';

console.log(`Copying ${src} to ${dest}...`);
copyDir(src, dest);
console.log('Copy completed!');
