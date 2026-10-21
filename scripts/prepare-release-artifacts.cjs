const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/** Preserve public download links without making updater URLs mutable. */
function prepareReleaseArtifacts(directory, version) {
  const names = fs.readdirSync(directory)
  for (const manifest of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    assert.ok(names.includes(manifest), `Missing update manifest: ${manifest}`)
    const body = fs.readFileSync(path.join(directory, manifest), 'utf8')
    assert.match(body, new RegExp(`^version: ['"]?${version.replaceAll('.', '\\.')}['"]?\\s*$`, 'm'))
    const urls = [...body.matchAll(/^\s*(?:-\s*)?url:\s*(.+)\s*$/gm)]
    assert.ok(urls.length > 0, `Empty update manifest: ${manifest}`)
    for (const [, value] of urls) {
      const name = decodeURIComponent(value.trim().replace(/^['"]|['"]$/g, ''))
      assert.equal(path.basename(name), name, `Unexpected artifact URL: ${name}`)
      assert.ok(name.startsWith(`Watchtower-${version}-`), `Unversioned update artifact: ${name}`)
      assert.ok(names.includes(name), `Missing update artifact: ${name}`)
    }
  }
  for (const name of names) {
    if (name.startsWith(`Watchtower-${version}-`) && /\.(exe|dmg|zip|AppImage|deb)$/.test(name)) {
      fs.copyFileSync(path.join(directory, name), path.join(directory, name.replace(`-${version}-`, '-')))
    }
  }
}

if (require.main === module) {
  const version = require('../package.json').version
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Release tag must match package.json')
  prepareReleaseArtifacts(path.resolve(process.argv[2] ?? 'artifacts'), version)
}

module.exports = { prepareReleaseArtifacts }
