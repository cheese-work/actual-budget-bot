import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersionInfo } from './version.js';
import { logger } from './logger.js';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const packageVersion = JSON.parse(readFileSync(join(rootDirectory, 'package.json'), 'utf8')).version;
const stampScript = join(rootDirectory, '.github/release-tools/release-stamp.sh');

test('local builds keep the plain package version without a stamp', () => {
  assert.deepEqual(getVersionInfo(''), {
    version: packageVersion,
    build: '',
    displayVersion: packageVersion,
  });
});

test('release metadata keeps version and build separate from the display string', () => {
  assert.deepEqual(getVersionInfo('20261008-1331'), {
    version: packageVersion,
    build: '20261008-1331',
    displayVersion: `${packageVersion}-20261008-1331`,
  });
});

test('bot_started health logging preserves its event and reports release metadata', () => {
  const originalLog = console.log;
  let output = '';
  try {
    console.log = (line: string) => { output = line; };
    logger.info('bot_started', getVersionInfo('20261008-1331'));
  } finally {
    console.log = originalLog;
  }
  const entry = JSON.parse(output);
  assert.equal(entry.event, 'bot_started');
  assert.equal(entry.version, packageVersion);
  assert.equal(entry.build, '20261008-1331');
  assert.equal(entry.displayVersion, `${packageVersion}-20261008-1331`);
  const startup = readFileSync(join(rootDirectory, 'src/index.ts'), 'utf8');
  assert.ok(startup.includes("logger.info('bot_started', versionInfo)"));
});

test('release metadata reads the build stamp supplied by the image', () => {
  const originalBuild = process.env.RELEASE_BUILD;
  try {
    process.env.RELEASE_BUILD = '20261008-1331';
    assert.equal(getVersionInfo().build, '20261008-1331');
    delete process.env.RELEASE_BUILD;
    assert.equal(getVersionInfo().displayVersion, packageVersion);
  } finally {
    if (originalBuild === undefined) delete process.env.RELEASE_BUILD;
    else process.env.RELEASE_BUILD = originalBuild;
  }
});

test('malformed release stamps fail instead of being reported as build metadata', () => {
  for (const build of [
    '20261008',
    '2026-10-08-1331',
    '20261008-1331-extra',
    '0.1.0-20261008-1331',
    '20261008-1331\n',
    ' 20261008-1331',
  ]) {
    assert.throws(() => getVersionInfo(build), /Invalid RELEASE_BUILD/);
  }
});

test('release stamping uses the exact pinned shared script', () => {
  assert.equal(
    createHash('sha256').update(readFileSync(stampScript)).digest('hex'),
    '689f5b64bdb31796de1d0980f930e6db36e69260393c47d9c7b82c3f906be389',
  );
});

test('the release job resolves one ICT stamp across host timezones and UTC midnight', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'actual-bot-release-'));
  try {
    writeFileSync(
      join(temporaryDirectory, 'date'),
      '#!/bin/sh\nprintf "called\\n" >> "$STAMP_CALLS"\nexec /bin/date --date="2026-10-08T17:31:00Z" "$@"\n',
      { mode: 0o755 },
    );
    writeFileSync(join(temporaryDirectory, 'release-stamp.sh'), readFileSync(stampScript));
    const workflow = readFileSync(join(rootDirectory, '.github/workflows/cd-deploy.yml'), 'utf8');
    assert.ok(workflow.includes('--build-arg "RELEASE_BUILD=${{ steps.tag.outputs.build }}"'));
    const dockerfile = readFileSync(join(rootDirectory, 'Dockerfile'), 'utf8');
    assert.ok(dockerfile.includes('ARG RELEASE_BUILD=""'));
    assert.ok(dockerfile.includes('ENV RELEASE_BUILD=${RELEASE_BUILD}'));
    const releaseStep = workflow.match(
      /- name: Resolve release version\n[\s\S]*?run: \|\n((?:          [^\n]*\n)+)/,
    );
    assert.ok(releaseStep, 'release version step exists');
    const script = releaseStep[1].replace(/^          /gm, '');
    assert.equal((script.match(/release-stamp\.sh/g) ?? []).length, 1);

    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Ho_Chi_Minh']) {
      const outputPath = join(temporaryDirectory, 'github-output');
      const callsPath = join(temporaryDirectory, 'stamp-calls');
      writeFileSync(outputPath, '');
      writeFileSync(callsPath, '');
      execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
        cwd: rootDirectory,
        env: {
          ...process.env,
          PATH: `${temporaryDirectory}:${process.env.PATH}`,
          TZ: timezone,
          RUNNER_TEMP: temporaryDirectory,
          GITHUB_OUTPUT: outputPath,
          STAMP_CALLS: callsPath,
        },
      });
      const outputs = Object.fromEntries(
        readFileSync(outputPath, 'utf8').trim().split('\n').map((line) => line.split('=')),
      );
      assert.equal(outputs.version, packageVersion);
      assert.equal(outputs.build, '20261009-0031');
      const commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        cwd: rootDirectory,
        encoding: 'utf8',
      }).trim();
      assert.equal(outputs.tag, `${packageVersion}-20261009-0031-${commit}`);
      assert.equal(readFileSync(callsPath, 'utf8'), 'called\n');
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
