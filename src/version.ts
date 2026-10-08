import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export function getVersionInfo(build = process.env.RELEASE_BUILD ?? '') {
  if (build && (build.length !== 13 || !/^\d{8}-\d{4}$/.test(build))) {
    throw new Error('Invalid RELEASE_BUILD: expected YYYYMMDD-hhmm');
  }
  return { version, build, displayVersion: build ? `${version}-${build}` : version };
}
