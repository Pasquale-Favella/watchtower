// Fails a release whose tag disagrees with package.json.
//
// package.json is the single source of truth for the app version —
// electron-builder reads it directly, and `artifactName` in electron-builder.yml
// is version-less on purpose (ADR 0015), so a mismatched tag would ship an
// installer that reports one version on a release page titled another. One
// comparison covers it because no other file in the repo declares a version.
//
// Usage:
//   RELEASE_TAG=v0.2.5 node scripts/check-release-version.cjs
// GITHUB_REF_NAME is read as a fallback (the release workflow already sets it),
// so running the script inside CI needs no extra wiring.
'use strict'

const { readFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')

// Semver, tolerating prerelease/build suffixes so a `-rc.1` tag is releasable.
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/

function fail(message, hint) {
  console.error(`[check-release-version] ${message}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(1)
}

const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME

if (!tag) {
  fail(
    'RELEASE_TAG or GITHUB_REF_NAME is required.',
    'Run it from the release workflow, or set RELEASE_TAG explicitly.',
  )
}
if (!TAG_PATTERN.test(tag)) {
  fail(`Refusing to release: "${tag}" is not a v<major>.<minor>.<patch> tag.`)
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (version !== tag.slice(1)) {
  fail(
    `Refusing to release: tag says ${tag} but package.json says ${version}.`,
    `Bump "version" in package.json to ${tag.slice(1)}, or tag v${version} instead.`,
  )
}

console.log(`[check-release-version] Release version consistent: ${version}`)
