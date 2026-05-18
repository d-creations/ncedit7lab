#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const targets = ['dist', 'build'];

async function main() {
  for (const target of targets) {
    const targetPath = resolve(process.cwd(), target);
    try {
      await rm(targetPath, { recursive: true, force: true });
      console.log(`removed ${targetPath}`);
    } catch (error) {
      console.error(`failed to remove ${targetPath}:`, error.message ?? error);
      process.exitCode = 1;
    }
  }
}

main();