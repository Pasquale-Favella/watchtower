import initSqlJs, { type Database } from 'sql.js'
import sqliteWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

import { openPreviewArchive, type PreviewArchive } from './preview-archive.js'
import {
  documentMarkup,
  escapePreviewText,
  parsePreviewNotebook,
  readPreviewXml,
  rtfPreviewText,
  xmlChildren,
  xmlText,
} from './preview-document.js'
import {
  extendedFilePreviewKind,
  PAGE_ROWS,
  PREVIEW_LIMIT,
  type PreviewDocument,
  type PreviewMethods,
} from './preview-types.js'

function stringValue(value: unknown): string {
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`
  return value === null ? 'NULL' : String(value)
}

function columnName(column: number): string {
  let result = ''
  for (let current = column + 1; current > 0; current = Math.floor((current - 1) / 26))
    result = String.fromCharCode(65 + ((current - 1) % 26)) + result
  return result
}

function boundedRows(rows: readonly (readonly string[])[]): {
  readonly rows: readonly (readonly string[])[]
  readonly truncated: boolean
} {
  let remaining = 2 * 1024 * 1024
  let truncated = false
  const output = rows.map(row =>
    row.slice(0, 200).map(value => {
      const length = Math.min(remaining, 4096)
      const visible = value.slice(0, length)
      remaining -= visible.length
      if (visible.length !== value.length) truncated = true
      return visible
    }),
  )
  return { rows: output, truncated: truncated || rows.some(row => row.length > 200) }
}

async function archiveXml(archive: PreviewArchive, path: string) {
  return readPreviewXml(new TextDecoder('utf-8', { fatal: true }).decode(await archive.read(path)))
}

function resolveArchivePath(directory: string, target: string): string {
  const parts: string[] = []
  for (const part of `${directory}${target}`.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) throw new Error('Document image is outside the archive.')
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

function dataImage(bytes: Uint8Array, mime: string): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return `data:image/${mime};base64,${btoa(binary)}`
}

async function archivedMarkup(archive: PreviewArchive, path: string): Promise<string> {
  const root = await archiveXml(archive, path)
  const directory = path.slice(0, path.lastIndexOf('/') + 1)
  const relationshipPath = `${directory}_rels/${path.slice(directory.length)}.rels`
  const images = new Map<string, string>()
  if (archive.entries.some(entry => entry.name === relationshipPath)) {
    const relationships = await archiveXml(archive, relationshipPath)
    let imageBytes = 0
    for (const relationship of xmlChildren(relationships, 'Relationship')) {
      if (relationship.attributes.TargetMode === 'External' || !/\/image$/.test(relationship.attributes.Type ?? ''))
        continue
      const target = resolveArchivePath(directory, relationship.attributes.Target ?? '')
      const extension = target.split('.').at(-1)?.toLowerCase() ?? ''
      if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension)) continue
      const image = await archive.read(target)
      imageBytes += image.byteLength
      if (imageBytes > 4 * 1024 * 1024) break
      let mime = extension
      if (extension === 'jpg') mime = 'jpeg'
      if (extension === 'svg') mime = 'svg+xml'
      images.set(relationship.attributes.Id, dataImage(image, mime))
    }
  }
  return documentMarkup(root, node => {
    if (node.name !== 'blip' && node.name !== 'imagedata') return null
    const image = images.get(node.attributes['r:embed'] ?? node.attributes['r:id'])
    return image ? `<img src="${image}" alt="Document image">` : ''
  })
}

function documentPages(pages: readonly string[], omitted = false): PreviewDocument {
  const bounded: string[] = []
  let length = 0
  for (const page of pages) {
    if (bounded.length >= 500 || length + page.length > 8 * 1024 * 1024) break
    bounded.push(page)
    length += page.length
  }
  return { kind: 'document', pages: bounded, truncated: omitted || bounded.length !== pages.length }
}

async function openXmlDocument(archive: PreviewArchive, kind: string): Promise<PreviewDocument> {
  if (kind === 'docx') {
    const html = await archivedMarkup(archive, 'word/document.xml')
    return documentPages(html.split('<hr data-page-break>'))
  }
  if (kind === 'pptx') {
    const slideNames = archive.entries
      .filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => Number(left.match(/slide(\d+)/)?.[1]) - Number(right.match(/slide(\d+)/)?.[1]))
    const pages: string[] = []
    for (const name of slideNames.slice(0, 500)) pages.push(await archivedMarkup(archive, name))
    return documentPages(pages, slideNames.length > pages.length)
  }
  const root = await archiveXml(archive, 'content.xml')
  const pages = xmlChildren(root, 'page')
  return documentPages(
    pages.length ? pages.slice(0, 500).map(page => documentMarkup(page)) : [documentMarkup(root)],
    pages.length > 500,
  )
}

interface Sheet {
  readonly name: string
  readonly rows: readonly (readonly string[])[]
}

async function workbookSheets(archive: PreviewArchive, kind: string): Promise<readonly Sheet[]> {
  if (kind === 'ods') {
    const root = await archiveXml(archive, 'content.xml')
    return xmlChildren(root, 'table')
      .slice(0, 100)
      .map((table, index) => ({
        name: table.attributes['table:name'] ?? `Sheet ${index + 1}`,
        rows: xmlChildren(table, 'table-row')
          .slice(0, 100_000)
          .map(row =>
            row.children
              .filter(cell => cell.name === 'table-cell' || cell.name === 'covered-table-cell')
              .flatMap(cell => {
                const value = xmlChildren(cell, 'p').map(xmlText).join('\n') || cell.attributes['office:value'] || ''
                return Array.from(
                  { length: Math.min(200, Number(cell.attributes['table:number-columns-repeated']) || 1) },
                  () => value,
                )
              })
              .slice(0, 200),
          ),
      }))
  }
  const workbook = await archiveXml(archive, 'xl/workbook.xml')
  const relation = await archiveXml(archive, 'xl/_rels/workbook.xml.rels')
  const targets = new Map(
    xmlChildren(relation, 'Relationship').map(item => [item.attributes.Id, item.attributes.Target]),
  )
  const stringsFile = archive.entries.some(entry => entry.name === 'xl/sharedStrings.xml')
  const strings = stringsFile ? xmlChildren(await archiveXml(archive, 'xl/sharedStrings.xml'), 'si').map(xmlText) : []
  const sheets: Sheet[] = []
  for (const sheet of xmlChildren(workbook, 'sheet').slice(0, 100)) {
    const target = targets.get(sheet.attributes['r:id'])
    if (!target) continue
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
    const root = await archiveXml(archive, path)
    const rows = xmlChildren(root, 'row')
      .slice(0, 100_000)
      .map(row => {
        const values: string[] = []
        for (const cell of row.children.filter(item => item.name === 'c')) {
          const letters = cell.attributes.r?.match(/^[A-Z]+/)?.[0] ?? ''
          let column = 0
          for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64
          if (column > 200) continue
          const text = xmlChildren(cell, 'v').map(xmlText).join('')
          let value = text
          if (cell.attributes.t === 's') value = strings[Number(text)] ?? ''
          if (cell.attributes.t === 'inlineStr') value = xmlChildren(cell, 'is').map(xmlText).join('')
          values[Math.max(0, column - 1)] = value
        }
        return Array.from({ length: values.length }, (_, index) => values[index] ?? '')
      })
    sheets.push({ name: sheet.attributes.name ?? `Sheet ${sheets.length + 1}`, rows })
  }
  return sheets
}

async function epubPages(archive: PreviewArchive): Promise<PreviewDocument> {
  const container = await archiveXml(archive, 'META-INF/container.xml')
  const packagePath = xmlChildren(container, 'rootfile')[0]?.attributes['full-path']
  if (!packagePath) throw new Error('EPUB package is missing.')
  const packageRoot = await archiveXml(archive, packagePath)
  const directory = packagePath.slice(0, packagePath.lastIndexOf('/') + 1)
  const items = new Map(xmlChildren(packageRoot, 'item').map(item => [item.attributes.id, item.attributes.href]))
  const pages: string[] = []
  for (const item of xmlChildren(packageRoot, 'itemref').slice(0, 500)) {
    const href = items.get(item.attributes.idref)
    if (!href) continue
    const html = await archiveXml(archive, `${directory}${href.split('#')[0]}`)
    // Render only passive text, paragraph and table nodes; publisher scripts and links are never copied.
    pages.push(documentMarkup(html))
  }
  return { kind: 'document', pages, truncated: xmlChildren(packageRoot, 'itemref').length > pages.length }
}

export function createPreviewHandlers(): {
  readonly open: (input: PreviewMethods['open']['input']) => Promise<PreviewDocument>
  readonly select: (input: PreviewMethods['select']['input']) => Promise<PreviewDocument>
  readonly close: () => undefined
} {
  let archive: PreviewArchive | null = null
  let database: Database | null = null
  let sheets: readonly Sheet[] = []
  let tableNames: string[] = []

  function table(name: string, page = 0): PreviewDocument {
    const offset = Math.max(0, Math.trunc(page)) * PAGE_ROWS
    if (database) {
      if (!tableNames.includes(name)) throw new Error('Table was not found.')
      const identifier = `"${name.replaceAll('"', '""')}"`
      const totalRows = Number(database.exec(`SELECT COUNT(*) FROM ${identifier}`)[0]?.values[0]?.[0] ?? 0)
      const result = database.exec(`SELECT * FROM ${identifier} LIMIT ${PAGE_ROWS} OFFSET ${offset}`)[0]
      const bounded = boundedRows(result?.values.map(row => row.map(stringValue)) ?? [])
      return {
        kind: 'table',
        names: tableNames,
        selected: name,
        columns: result?.columns.slice(0, 200) ?? [],
        rows: bounded.rows,
        offset,
        totalRows,
        truncated: bounded.truncated || (result?.columns.length ?? 0) > 200,
      }
    }
    const sheet = sheets.find(item => item.name === name)
    if (!sheet) throw new Error('Sheet was not found.')
    const width = sheet.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
    const bounded = boundedRows(sheet.rows.slice(offset, offset + PAGE_ROWS))
    return {
      kind: 'table',
      names: sheets.map(item => item.name),
      selected: name,
      columns: Array.from({ length: width }, (_, index) => columnName(index)),
      rows: bounded.rows,
      offset,
      totalRows: sheet.rows.length,
      truncated: bounded.truncated || sheet.rows.length === 100_000,
    }
  }

  function close(): undefined {
    database?.close()
    database = null
    archive = null
    sheets = []
    tableNames = []
    return undefined
  }

  async function select(input: PreviewMethods['select']['input']): Promise<PreviewDocument> {
    if (database || sheets.length > 0) return table(input.name, input.page)
    if (!archive) throw new Error('The archive is closed.')
    const bytes = await archive.read(input.name)
    let text: string | undefined
    let image: string | undefined
    if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(input.name) && bytes.byteLength <= 8 * 1024 * 1024) {
      const extension = input.name.split('.').at(-1)?.toLowerCase()
      const mime = extension === 'jpg' ? 'jpeg' : extension
      let binary = ''
      for (let offset = 0; offset < bytes.byteLength; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      image = `data:image/${mime};base64,${btoa(binary)}`
    } else {
      const bounded = bytes.subarray(0, 1024 * 1024)
      if (!bounded.includes(0)) text = new TextDecoder().decode(bounded)
    }
    return {
      kind: 'archive',
      entries: archive.entries,
      selected: input.name,
      text,
      image,
      truncated: bytes.byteLength > 1024 * 1024,
    }
  }

  async function open({ path, bytes }: PreviewMethods['open']['input']): Promise<PreviewDocument> {
    close()
    if (bytes.byteLength > PREVIEW_LIMIT) throw new Error('File exceeds the preview limit.')
    const kind = extendedFilePreviewKind(path)
    if (kind === 'ipynb') return parsePreviewNotebook(new TextDecoder().decode(bytes))
    if (kind === 'rtf')
      return {
        kind: 'document',
        pages: [`<pre>${escapePreviewText(rtfPreviewText(new TextDecoder().decode(bytes)))}</pre>`],
        truncated: false,
      }
    if (kind === 'sqlite') {
      const sql = await initSqlJs({ locateFile: () => sqliteWasmUrl })
      database = new sql.Database(new Uint8Array(bytes))
      database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
      tableNames =
        database
          .exec(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1000",
          )[0]
          ?.values.map(row => String(row[0])) ?? []
      if (tableNames.length === 0) throw new Error('Database has no tables to preview.')
      return table(tableNames[0])
    }
    archive = await openPreviewArchive(bytes, path)
    if (kind === 'archive') return { kind: 'archive', entries: archive.entries, truncated: false }
    if (kind === 'epub') return epubPages(archive)
    if (kind === 'xlsx' || kind === 'ods') {
      sheets = await workbookSheets(archive, kind)
      if (sheets.length === 0) throw new Error('Workbook has no sheets to preview.')
      return table(sheets[0].name)
    }
    return openXmlDocument(archive, kind ?? '')
  }

  return { open, select, close }
}
