#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// manifest.json에서 버전 읽기
const manifestPath = join(projectRoot, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const version = manifest.version;

// zip 파일명
const zipFileName = `rofan-visualboard-${version}.zip`;
const zipFilePath = join(projectRoot, zipFileName);

console.log(`Building zip file: ${zipFileName}`);
console.log(`Version: ${version}\n`);

// zip 명령어 생성 (제외할 파일/폴더 지정)
const zipCommand = `cd "${projectRoot}" && zip -r "${zipFileName}" . \\
  -x "node_modules/*" \\
  -x ".git/*" \\
  -x "*.zip" \\
  -x "scripts/*" \\
  -x "*.md" \\
  -x "package.json" \\
  -x "package-lock.json" \\
  -x ".gitignore" \\
  -x ".DS_Store"`;

try {
  execSync(zipCommand, { stdio: 'inherit', shell: '/bin/bash' });
  console.log(`\n✅ Successfully created: ${zipFileName}`);
  console.log(`Location: ${zipFilePath}`);
} catch (error) {
  console.error('❌ Failed to create zip file:', error.message);
  process.exit(1);
}

