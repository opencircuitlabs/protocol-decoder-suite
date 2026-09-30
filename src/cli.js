#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { annotations, decode } from './index.js';

const [captureFile, configFile, output] = process.argv.slice(2);
try {
  if (!captureFile || !configFile) throw new Error('Usage: decode-capture capture.json decoder.json [output.json]');
  const result = decode(JSON.parse(readFileSync(captureFile, 'utf8')), JSON.parse(readFileSync(configFile, 'utf8'))); result.annotations = annotations(result);
  const text = JSON.stringify(result, null, 2) + '\n'; if (output) writeFileSync(output, text); else process.stdout.write(text);
  if (result.summary.errorCount) process.exitCode = 2;
} catch (error) { console.error(error.message); process.exitCode = 1; }
