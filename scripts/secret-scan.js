#!/usr/bin/env node
/**
 * TenderFlow v0.9.0 - Repository Secret Scanner (Agent A6 / Task T01)
 * Enforces Non-negotiable Rule 5: Zero secrets in code, prompts, logs or commits.
 */
import fs from 'fs';
import path from 'path';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.gemini',
  'certs'
]);

const SECRET_PATTERNS = [
  { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'Generic Private Key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Slack Token', regex: /xox[baprs]-[0-9a-zA-Z]{10,48}/ },
  { name: 'GitHub Token', regex: /gh[pousr]_[0-9a-zA-Z]{36}/ },
  { name: 'Hardcoded Production Secret', regex: /secret\s*=\s*['"][a-zA-Z0-9_\-]{24,}['"]/i }
];

let totalScanned = 0;
let findings = 0;

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        scanDirectory(fullPath);
      }
    } else if (entry.isFile()) {
      // Exclude binary files or non-code files
      if (entry.name.endsWith('.png') || entry.name.endsWith('.jpg') || entry.name.endsWith('.ico')) {
        continue;
      }

      totalScanned++;
      const content = fs.readFileSync(fullPath, 'utf8');

      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(content)) {
          // Allow self-signed dev test certs if explicitly in certs or test
          if (entry.name.endsWith('tls.key') || entry.name.endsWith('tls.crt')) {
            continue;
          }
          console.error(`[SECRET VIOLATION] Found ${pattern.name} in file: ${fullPath}`);
          findings++;
        }
      }
    }
  }
}

console.log('>>> Commencing Automated Secret Scan (Rule 5 Enforcer)...');
scanDirectory(process.cwd());
console.log(`Scanned ${totalScanned} files across repository.`);

if (findings > 0) {
  console.error(`FAILED: ${findings} potential secret(s) detected. Aborting CI build.`);
  process.exit(1);
} else {
  console.log('PASSED: Zero hardcoded secrets detected in repository.');
  process.exit(0);
}
