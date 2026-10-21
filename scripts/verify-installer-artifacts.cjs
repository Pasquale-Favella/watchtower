const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..')
const packageInfo = require(path.join(repositoryRoot, 'package.json'))
const builderConfig = fs.readFileSync(path.join(repositoryRoot, 'electron-builder.yml'), 'utf8')
const productNameMatch = builderConfig.match(/^productName:\s*(.+)\s*$/m)
assert.ok(productNameMatch, 'electron-builder.yml must define productName')
const productName = productNameMatch[1].replace(/^['"]|['"]$/g, '')

function artifactPattern(platform, arch, extension) {
  const escapedProductName = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const version = packageInfo.version.replaceAll('.', '\\.')
  return new RegExp(`^${escapedProductName}-${version}-${platform}-${arch}\\.${extension}$`, 'i')
}

function parseOptions(args) {
  let platform
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--platform') {
      platform = args[++index]
      if (!platform) throw new Error('--platform requires win, mac, or linux')
    } else if (arg.startsWith('--platform=')) {
      platform = arg.slice('--platform='.length)
      if (!platform) throw new Error('--platform requires win, mac, or linux')
    } else if (arg === '--help' || arg === '-h') {
      return { help: true }
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  if (!['win', 'mac', 'linux'].includes(platform)) throw new Error('--platform must be win, mac, or linux')
  return { platform }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: options.timeout ?? 15 * 60 * 1000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const error = new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
    error.exitCode = result.status ?? 1
    throw error
  }
  return result
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  return result
}

function findArtifact(pattern, description) {
  const dist = path.join(repositoryRoot, 'dist')
  const matches = fs
    .readdirSync(dist)
    .filter(name => pattern.test(name))
    .map(name => path.join(dist, name))
  assert.equal(matches.length, 1, `Expected one ${description}; found ${matches.length}`)
  return matches[0]
}

function runnerTempRoot() {
  const configured = process.env.RUNNER_TEMP
  assert.ok(configured, 'RUNNER_TEMP must be provided by a disposable hosted runner')
  const root = fs.realpathSync(configured)
  assert.notEqual(root, path.parse(root).root, `Refusing to use filesystem root as RUNNER_TEMP: ${root}`)
  return root
}

function createOwnedTemp(parent, prefix) {
  const root = fs.realpathSync(parent)
  const created = fs.mkdtempSync(path.join(root, prefix))
  assertOwnedPath(created, root)
  return created
}

function assertOwnedPath(candidate, parent) {
  const absolute = path.resolve(candidate)
  const root = fs.realpathSync(parent)
  const relative = path.relative(root, absolute)
  assert.ok(
    relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Refusing path outside owned temp root: ${absolute}`,
  )
  return absolute
}

function removeOwnedTree(candidate, parent) {
  const absolute = assertOwnedPath(candidate, parent)
  if (!fs.existsSync(absolute)) return
  assert.ok(!fs.lstatSync(absolute).isSymbolicLink(), `Refusing to recursively remove symlink: ${absolute}`)
  fs.rmSync(absolute, { recursive: true, force: true })
}

function verifyPackagedExecutable(executablePath) {
  const verifier = path.join(repositoryRoot, 'scripts', 'verify-packaged.cjs')
  const args = [verifier, '--executable', executablePath]
  if (process.platform === 'linux') run('xvfb-run', ['-a', process.execPath, ...args])
  else run(process.execPath, args)
}

function findAppBundle(root) {
  const matches = []
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory() && entry.name.endsWith('.app')) matches.push(fullPath)
      else if (entry.isDirectory() && !entry.isSymbolicLink()) visit(fullPath)
    }
  }
  visit(root)
  assert.equal(matches.length, 1, `Expected one Watchtower app bundle; found ${matches.length}`)
  return matches[0]
}

function verifyMacArtifacts(root) {
  assert.equal(process.platform, 'darwin', 'macOS installer verification must run on macOS')
  const dmg = findArtifact(artifactPattern('mac', 'universal', 'dmg'), 'universal macOS DMG')
  const zip = findArtifact(artifactPattern('mac', 'universal', 'zip'), 'universal macOS zip')
  const mountPoint = path.join(root, 'dmg-mount')
  fs.mkdirSync(mountPoint)
  let attachAttempted = false
  let failure
  try {
    attachAttempted = true
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg])
    const mountedApp = findAppBundle(mountPoint)
    const dmgCopy = path.join(root, 'dmg-copy.app')
    run('ditto', [mountedApp, dmgCopy])
    verifyPackagedExecutable(path.join(dmgCopy, 'Contents', 'MacOS', productName))
  } catch (error) {
    failure = error
  } finally {
    if (attachAttempted) {
      try {
        run('hdiutil', ['detach', mountPoint])
      } catch {
        try {
          run('hdiutil', ['detach', '-force', mountPoint])
        } catch (forceError) {
          forceError.preserveTempRoot = true
          failure ??= forceError
          failure.preserveTempRoot = true
        }
      }
    }
  }
  if (failure) throw failure

  const zipRoot = path.join(root, 'zip-extract')
  fs.mkdirSync(zipRoot)
  run('ditto', ['-x', '-k', zip, zipRoot])
  const zipApp = findAppBundle(zipRoot)
  verifyPackagedExecutable(path.join(zipApp, 'Contents', 'MacOS', productName))
}

function matchingWindowsShortcuts() {
  const candidates = [
    path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.USERPROFILE ?? '', 'Desktop'),
  ]
  const matches = []
  const visit = directory => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(fullPath)
      else if (
        entry.isFile() &&
        entry.name.toLowerCase().includes(productName.toLowerCase()) &&
        entry.name.endsWith('.lnk')
      )
        matches.push(path.resolve(fullPath))
    }
  }
  for (const directory of candidates) visit(directory)
  return matches.sort()
}

function queryWindowsUninstallEntries() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  const result = runCapture('reg', ['query', key, '/s', '/f', productName, '/d'])
  if (result.status === 0) return result.stdout
  if (result.status === 1) return ''
  throw new Error(`Unable to inspect the current user's uninstall entries: ${result.stderr || result.stdout}`)
}

function verifyWindowsInstaller(root) {
  assert.equal(process.platform, 'win32', 'Windows installer verification must run on Windows')
  const installer = findArtifact(artifactPattern('win', 'x64', 'exe'), 'Windows NSIS installer')
  const installPath = path.join(root, 'watchtower-install')
  assertOwnedPath(installPath, root)
  assert.ok(!fs.existsSync(installPath), `Install destination already exists: ${installPath}`)
  assert.equal(queryWindowsUninstallEntries(), '', 'A Watchtower uninstall registry entry already exists')
  const shortcutsBefore = matchingWindowsShortcuts()
  const defaultInstall = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', productName)
  assert.ok(!fs.existsSync(defaultInstall), `Default Watchtower install already exists: ${defaultInstall}`)

  let installed = false
  let failure
  try {
    run(installer, ['/S', '/currentuser', `/D=${installPath}`])
    installed = true
    const executable = path.join(installPath, `${productName}.exe`)
    assert.ok(fs.existsSync(executable), `Installed executable is missing: ${executable}`)
    assert.match(
      queryWindowsUninstallEntries(),
      new RegExp(productName, 'i'),
      'NSIS did not register Watchtower for uninstall',
    )
    verifyPackagedExecutable(executable)
  } catch (error) {
    failure = error
  } finally {
    const uninstaller = path.join(installPath, `Uninstall ${productName}.exe`)
    if (fs.existsSync(uninstaller)) {
      try {
        // Keep the running uninstaller outside the tree it removes; _?= disables NSIS self-copying.
        const uninstallerCopy = path.join(root, 'uninstall-watchtower.exe')
        fs.copyFileSync(uninstaller, uninstallerCopy)
        run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$ErrorActionPreference = "Stop"; $process = Start-Process -FilePath $env:WATCHTOWER_UNINSTALLER -ArgumentList "/S /currentuser _?=$env:WATCHTOWER_INSTALL_PATH" -Wait -PassThru -WindowStyle Hidden; exit $process.ExitCode',
          ],
          {
            env: {
              ...process.env,
              WATCHTOWER_UNINSTALLER: uninstallerCopy,
              WATCHTOWER_INSTALL_PATH: installPath,
            },
          },
        )
        assert.equal(queryWindowsUninstallEntries(), '', 'NSIS uninstall left a Watchtower registry entry')
        assert.deepEqual(matchingWindowsShortcuts(), shortcutsBefore, 'NSIS uninstall left a Watchtower shortcut')
        assert.ok(!fs.existsSync(installPath), 'NSIS uninstall left files in the isolated install directory')
      } catch (error) {
        failure ??= error
      }
    } else if (installed) {
      failure ??= new Error('NSIS installer did not create its expected uninstaller')
    }
    if (fs.existsSync(installPath)) {
      try {
        removeOwnedTree(installPath, root)
      } catch (error) {
        failure ??= error
      }
    }
  }
  if (failure) throw failure
  if (!installed) throw new Error('Windows installer did not complete')
}

function isDebInstalled(packageName) {
  const result = runCapture('dpkg-query', ['-W', '-f=${db:Status-Status}', packageName])
  if (result.status === 1) return false
  if (result.status !== 0) {
    throw new Error(`Unable to inspect deb installation status: ${result.stderr || result.stdout}`)
  }
  if (result.stdout.trim() === 'installed') return true
  throw new Error(`Unexpected deb installation status for ${packageName}: ${result.stdout.trim()}`)
}

function installedDebExecutable(packageName) {
  const result = runCapture('dpkg-query', ['-L', packageName])
  if (result.status !== 0) throw new Error(`Unable to list installed deb files: ${result.stderr || result.stdout}`)
  const candidates = result.stdout.split(/\r?\n/).filter(file => {
    if (path.posix.basename(file) !== packageName || !fs.existsSync(file)) return false
    const metadata = fs.lstatSync(file)
    return metadata.isFile() && !metadata.isSymbolicLink()
  })
  assert.equal(
    candidates.length,
    1,
    `Expected one installed ${packageInfo.name} executable; found ${candidates.length}`,
  )
  return candidates[0]
}

function verifyLinuxArtifacts(root) {
  assert.equal(process.platform, 'linux', 'Linux installer verification must run on Linux')
  const appImage = findArtifact(artifactPattern('linux', 'x86_64', 'AppImage'), 'Linux AppImage')
  const deb = findArtifact(artifactPattern('linux', 'amd64', 'deb'), 'Linux deb package')
  const appImageRoot = path.join(root, 'appimage')
  fs.mkdirSync(appImageRoot)
  run(appImage, ['--appimage-extract'], { cwd: appImageRoot })
  const appRun = path.join(appImageRoot, 'squashfs-root', 'AppRun')
  assert.ok(fs.existsSync(appRun), `AppImage payload is missing: ${appRun}`)
  verifyPackagedExecutable(appRun)

  let failure
  let installAttempted = false
  let executable
  try {
    assert.ok(!isDebInstalled(packageInfo.name), `Deb package is already installed: ${packageInfo.name}`)
    installAttempted = true
    run('sudo', ['apt-get', 'install', '--yes', '--no-install-recommends', deb])
    executable = installedDebExecutable(packageInfo.name)
    verifyPackagedExecutable(executable)
  } catch (error) {
    failure = error
  } finally {
    if (installAttempted) {
      try {
        run('sudo', ['apt-get', 'purge', '--yes', packageInfo.name])
        assert.ok(!isDebInstalled(packageInfo.name), 'Deb package remained installed after removal')
        if (executable) assert.ok(!fs.existsSync(executable), `Deb uninstall left its executable: ${executable}`)
      } catch (error) {
        failure ??= error
      }
    }
  }
  if (failure) throw failure
}

function cleanupRoot(root, tempRoot) {
  if (fs.existsSync(root)) removeOwnedTree(root, tempRoot)
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/verify-installer-artifacts.cjs --platform <win|mac|linux>')
    return
  }
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installer verification must run in GitHub Actions')
  assert.equal(
    process.env.RUNNER_ENVIRONMENT,
    'github-hosted',
    'Installer verification requires a disposable hosted runner',
  )
  const tempRoot = runnerTempRoot()
  const workRoot = createOwnedTemp(tempRoot, 'watchtower-installer-acceptance-')
  let failure
  try {
    if (options.platform === 'win') verifyWindowsInstaller(workRoot)
    else if (options.platform === 'mac') verifyMacArtifacts(workRoot)
    else verifyLinuxArtifacts(workRoot)
    console.log(
      `Watchtower ${options.platform} installer artifacts passed install/extract and packaged-app verification.`,
    )
  } catch (error) {
    failure = error
  } finally {
    if (failure?.preserveTempRoot) {
      console.error(`Retaining installer verification files because a DMG mount may remain: ${workRoot}`)
    } else {
      try {
        cleanupRoot(workRoot, tempRoot)
      } catch (error) {
        failure ??= error
      }
    }
  }
  if (failure) {
    console.error(failure)
    process.exitCode = failure.exitCode ?? 1
  }
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = error.exitCode ?? 1
}
