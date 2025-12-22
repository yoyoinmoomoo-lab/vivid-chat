#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 버전 타입 검증
const versionType = process.argv[2];
if (!['patch', 'minor', 'major'].includes(versionType)) {
  console.error('Usage: node scripts/bumpVersion.mjs [patch|minor|major]');
  process.exit(1);
}

// manifest.json 읽기
const manifestPath = join(projectRoot, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

// 현재 버전 파싱
const currentVersion = manifest.version;
const [major, minor, patch] = currentVersion.split('.').map(Number);

if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
  console.error(`Invalid version format in manifest.json: ${currentVersion}`);
  console.error('Expected format: MAJOR.MINOR.PATCH (e.g., 0.1.0)');
  process.exit(1);
}

// 새 버전 계산
let newMajor = major;
let newMinor = minor;
let newPatch = patch;

switch (versionType) {
  case 'major':
    newMajor += 1;
    newMinor = 0;
    newPatch = 0;
    break;
  case 'minor':
    newMinor += 1;
    newPatch = 0;
    break;
  case 'patch':
    newPatch += 1;
    break;
}

const newVersion = `${newMajor}.${newMinor}.${newPatch}`;

// manifest.json 업데이트
manifest.version = newVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// package.json 업데이트 (존재하는 경우)
const packageJsonPath = join(projectRoot, 'package.json');
try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  packageJson.version = newVersion;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`Updated: manifest.json, package.json, VERSION.md`);
} catch (err) {
  // package.json이 없으면 무시
  console.log(`Updated: manifest.json, VERSION.md`);
}

// VERSION.md 업데이트
const versionMdPath = join(projectRoot, 'VERSION.md');
const versionMdContent = `# Version

Current version: ${newVersion}

This file is automatically updated by the version bump script.
`;
writeFileSync(versionMdPath, versionMdContent);

// 결과 출력
console.log(`Bumped version: ${currentVersion} → ${newVersion}`);


