const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/** Validate the complete release without creating duplicate download aliases. */
function prepareReleaseArtifacts(directory, version) {
  const names = fs.readdirSync(directory)
  const artifacts = [
    'Watchtower-win-x64.exe',
    'Watchtower-mac-universal.dmg',
    'Watchtower-mac-universal.zip',
    'Watchtower-linux-x86_64.AppImage',
    'Watchtower-linux-amd64.deb',
  ]
  for (const artifact of artifacts) assert.ok(names.includes(artifact), `Missing release artifact: ${artifact}`)
  for (const name of names.filter(name => /\.(exe|dmg|zip|AppImage|deb)$/.test(name))) {
    assert.ok(artifacts.includes(name), `Unexpected release artifact: ${name}`)
  }
  for (const manifest of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    assert.ok(names.includes(manifest), `Missing update manifest: ${manifest}`)
    const body = fs.readFileSync(path.join(directory, manifest), 'utf8')
    assert.match(body, new RegExp(`^version: ['"]?${version.replaceAll('.', '\\.')}['"]?\\s*$`, 'm'))
    const urls = [...body.matchAll(/^\s*(?:-\s*)?url:\s*(.+)\s*$/gm)]
    assert.ok(urls.length > 0, `Empty update manifest: ${manifest}`)
    for (const [, value] of urls) {
      const name = decodeURIComponent(value.trim().replace(/^['"]|['"]$/g, ''))
      assert.equal(path.basename(name), name, `Unexpected artifact URL: ${name}`)
      assert.ok(artifacts.includes(name), `Unexpected update artifact: ${name}`)
      assert.ok(names.includes(name), `Missing update artifact: ${name}`)
    }
  }
  for (const artifact of ['Watchtower-win-x64.exe', 'Watchtower-mac-universal.dmg', 'Watchtower-mac-universal.zip']) {
    assert.ok(names.includes(`${artifact}.blockmap`), `Missing update blockmap: ${artifact}`)
  }
}

if (require.main === module) {
  const version = require('../package.json').version
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Release tag must match package.json')
  prepareReleaseArtifacts(path.resolve(process.argv[2] ?? 'artifacts'), version)
}

module.exports = { prepareReleaseArtifacts }
