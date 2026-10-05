import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { writeCsvExportFiles, writeJsonExportFile } from '../src/main/export-files-live.js'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-export-files-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('export file ownership and overwrite checks', () => {
  it('writes the marker, README and all nine CSV files into the resolved folder', async () => {
    const root = tempDirectory()
    const target = join(root, 'usage.csv')
    const files = [
      { name: 'README.txt', contents: 'generated once' },
      ...Array.from({ length: 9 }, (_, index) => ({ name: `table-${index}.csv`, contents: `row-${index}` })),
    ]

    await expect(writeCsvExportFiles(target, files)).resolves.toBe(resolve(root, 'usage'))
    expect(readdirSync(join(root, 'usage')).sort()).toEqual(
      ['.watchtower-export', ...files.map(file => file.name)].sort(),
    )
    expect(readFileSync(join(root, 'usage', 'table-8.csv'), 'utf-8')).toBe('row-8')
  })

  it('refuses an unmarked directory without changing its contents', async () => {
    const root = tempDirectory()
    const folder = join(root, 'occupied')
    mkdirSync(folder)
    writeFileSync(join(folder, 'keep.txt'), 'user data')

    await expect(writeCsvExportFiles(folder, [])).rejects.toMatchObject({
      _tag: 'ExportFileError',
      reason: 'csv-unmarked-directory',
    })
    expect(readFileSync(join(folder, 'keep.txt'), 'utf-8')).toBe('user data')
  })

  it('clears only a marked export folder before writing its replacement', async () => {
    const root = tempDirectory()
    const folder = join(root, 'previous')
    mkdirSync(join(folder, 'old'), { recursive: true })
    writeFileSync(join(folder, '.watchtower-export'), '')
    writeFileSync(join(folder, 'old', 'table.csv'), 'old')
    writeFileSync(join(folder, 'README.txt'), 'old readme')

    await writeCsvExportFiles(folder, [{ name: 'README.txt', contents: 'new readme' }])
    expect(readdirSync(folder).sort()).toEqual(['.watchtower-export', 'README.txt'])
    expect(readFileSync(join(folder, 'README.txt'), 'utf-8')).toBe('new readme')
  })

  it('refuses a plain CSV target file without overwriting it', async () => {
    const root = tempDirectory()
    const target = join(root, 'report')
    writeFileSync(target, 'keep')

    await expect(writeCsvExportFiles(target, [])).rejects.toMatchObject({ reason: 'csv-file-target' })
    expect(readFileSync(target, 'utf-8')).toBe('keep')
  })

  it('maps filesystem failures to a typed error without exposing the target path', async () => {
    const root = tempDirectory()
    const blocker = join(root, 'file')
    writeFileSync(blocker, 'not a directory')

    await expect(writeCsvExportFiles(join(blocker, 'child'), [])).rejects.toMatchObject({
      _tag: 'ExportFileError',
      reason: 'io-failure',
    })
  })

  it('refuses an unmarked JSON file and directory without changing either', async () => {
    const root = tempDirectory()
    const target = join(root, 'report.json')
    writeFileSync(target, '{"user":"data"}')
    const folder = join(root, 'folder.json')
    mkdirSync(folder)

    await expect(writeJsonExportFile(target, '{}')).rejects.toMatchObject({ reason: 'json-unmarked-file' })
    await expect(writeJsonExportFile(folder, '{}')).rejects.toMatchObject({ reason: 'json-directory-target' })
    expect(readFileSync(target, 'utf-8')).toBe('{"user":"data"}')
    expect(readdirSync(folder)).toEqual([])
  })

  it('overwrites a prior Watchtower JSON export and adds the extension once', async () => {
    const root = tempDirectory()
    const target = join(root, 'report')
    writeFileSync(`${target}.json`, '{"schema": "watchtower.export.v1", "old": true}')

    await expect(writeJsonExportFile(target, '{"schema":"watchtower.export.v1"}')).resolves.toBe(`${target}.json`)
    expect(readFileSync(`${target}.json`, 'utf-8')).toBe('{"schema":"watchtower.export.v1"}')
  })
})
