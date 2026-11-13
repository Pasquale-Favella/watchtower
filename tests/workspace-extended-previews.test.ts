import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import {
  openPreviewArchive,
  zipPreviewEntries,
} from '@/renderer/features/workspace/right-panel/file-previews/preview-archive.js'
import {
  documentMarkup,
  parsePreviewNotebook,
  readPreviewXml,
  rtfPreviewText,
} from '@/renderer/features/workspace/right-panel/file-previews/preview-document.js'
import { createPreviewHandlers } from '@/renderer/features/workspace/right-panel/file-previews/preview-handlers.js'
import { extendedFilePreviewKind } from '@/renderer/features/workspace/right-panel/file-previews/preview-types.js'

function encoded(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer
}

describe('document preview formats', () => {
  it.each(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub', 'ipynb', 'pdf'])(
    'recognizes %s case insensitively',
    extension => {
      expect(extendedFilePreviewKind(`folder/Example.${extension.toUpperCase()}`)).toBe(extension)
    },
  )
  it('uses source viewers for ordinary text and identifies passive binary viewers', () => {
    expect(extendedFilePreviewKind('source.ts')).toBeNull()
    expect(extendedFilePreviewKind('archive.tar.gz')).toBe('archive')
    expect(extendedFilePreviewKind('font.woff2')).toBe('font')
    expect(extendedFilePreviewKind('data.sqlite3')).toBe('sqlite')
  })
})

describe('bounded archive parser', () => {
  it('reads individual entries without eagerly expanding the whole archive', async () => {
    const zip = new JSZip().file('src/example.txt', 'hello').file('other.txt', 'another entry')
    const bytes = await zip.generateAsync({ type: 'arraybuffer' })
    expect(zipPreviewEntries(bytes)).toContainEqual({ name: 'src/example.txt', size: 5, directory: false })
    const archive = await openPreviewArchive(bytes, 'archive.zip')
    expect(new TextDecoder().decode(await archive.read('src/example.txt'))).toBe('hello')
    await expect(archive.read('../outside')).rejects.toThrow('invalid entry path')
  })
  it('rejects damaged archives and inflated sizes before decompression', async () => {
    expect(() => zipPreviewEntries(encoded('damaged'))).toThrow('ZIP')
    const zip = await new JSZip().file('small.txt', 'small').generateAsync({ type: 'arraybuffer' })
    const view = new DataView(zip)
    for (let offset = 0; offset < zip.byteLength - 46; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        view.setUint32(offset + 24, 100 * 1024 * 1024, true)
        break
      }
    }
    expect(() => zipPreviewEntries(zip)).toThrow('preview limits')
  })
})

describe('passive document conversion', () => {
  it('preserves paragraphs and tables while escaping authored markup', () => {
    const tree = readPreviewXml(
      '<w:document xmlns:w="word"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>&lt;script&gt;</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    )
    const html = documentMarkup(tree)
    expect(html).toContain('<strong>&lt;script&gt;</strong>')
    expect(html).toContain('<table><tr><td><p>Cell</p></td></tr></table>')
    expect(html).not.toContain('<script>')
  })
  it('refuses external document declarations and excessive nesting', () => {
    expect(() => readPreviewXml('<!DOCTYPE data SYSTEM "file:///secret"><data/>')).toThrow('declarations')
    expect(() => readPreviewXml('<a>'.repeat(110) + '</a>'.repeat(110))).toThrow('structure')
  })
  it('reads stored notebook cells and outputs without executing them', () => {
    const result = parsePreviewNotebook(
      JSON.stringify({
        cells: [
          { cell_type: 'markdown', source: ['# Heading', '\nText'] },
          {
            cell_type: 'code',
            source: 'print(2)',
            outputs: [{ output_type: 'stream', text: ['2\n'] }, { data: { 'text/html': '<b>saved</b>' } }],
          },
        ],
      }),
    )
    expect(result).toMatchObject({
      kind: 'notebook',
      cells: [
        { kind: 'markdown', source: '# Heading\nText' },
        {
          kind: 'code',
          outputs: [
            { kind: 'text', value: '2\n' },
            { kind: 'html', value: '<b>saved</b>' },
          ],
        },
      ],
    })
    expect(() => parsePreviewNotebook('{"unexpected":true}')).toThrow()
  })
  it('decodes RTF text groups, paragraph breaks and Unicode without metadata', () => {
    expect(rtfPreviewText('{\\rtf1{\\fonttbl Arial;}Hello\\par world \\u945?}')).toBe(
      'Hello\nworld alpha'.replace('alpha', String.fromCharCode(945)),
    )
    expect(() => rtfPreviewText('plain text')).toThrow('RTF')
  })
})

describe('document worker sessions', () => {
  it('reads workbook sheet names, shared strings and inline strings, with paginated selection', async () => {
    const archive = new JSZip()
      .file(
        'xl/workbook.xml',
        '<workbook xmlns:r="relationships"><sheets><sheet name="First" r:id="one"/><sheet name="Second" r:id="two"/></sheets></workbook>',
      )
      .file(
        'xl/_rels/workbook.xml.rels',
        '<Relationships><Relationship Id="one" Target="worksheets/first.xml"/><Relationship Id="two" Target="worksheets/second.xml"/></Relationships>',
      )
      .file('xl/sharedStrings.xml', '<sst><si><t>Saved label</t></si></sst>')
      .file(
        'xl/worksheets/first.xml',
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>',
      )
      .file(
        'xl/worksheets/second.xml',
        '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Other sheet</t></is></c></row></sheetData></worksheet>',
      )
    const worker = createPreviewHandlers()
    expect(
      await worker.open({ path: 'saved.xlsx', bytes: await archive.generateAsync({ type: 'arraybuffer' }) }),
    ).toMatchObject({
      kind: 'table',
      names: ['First', 'Second'],
      columns: ['A', 'B', 'C'],
      rows: [['Saved label', '', '42']],
    })
    expect(await worker.select({ name: 'Second' })).toMatchObject({ selected: 'Second', rows: [['Other sheet']] })
    await expect(worker.select({ name: 'Not a sheet' })).rejects.toThrow('not found')
  })

  it('respects presentation slide order and renders embedded images as passive data', async () => {
    const archive = new JSZip()
      .file('ppt/slides/slide10.xml', '<slide><p><r><t>Tenth slide</t></r></p></slide>')
      .file(
        'ppt/slides/slide2.xml',
        '<slide xmlns:r="relationships"><p><r><t>Second slide</t></r></p><blip r:embed="image"/></slide>',
      )
      .file(
        'ppt/slides/_rels/slide2.xml.rels',
        '<Relationships><Relationship Id="image" Type="document/image" Target="../media/saved.png"/></Relationships>',
      )
      .file('ppt/media/saved.png', new Uint8Array([137, 80, 78, 71]))
    const worker = createPreviewHandlers()
    const output = await worker.open({
      path: 'saved.pptx',
      bytes: await archive.generateAsync({ type: 'arraybuffer' }),
    })
    expect(output).toMatchObject({
      kind: 'document',
      pages: [expect.stringContaining('Second slide'), expect.stringContaining('Tenth slide')],
    })
    if (output.kind === 'document') expect(output.pages[0]).toContain('src="data:image/png;base64,')
  })

  it('opens OpenDocument text and spreadsheet cells without publisher scripts', async () => {
    const archive = new JSZip().file(
      'content.xml',
      '<office:document xmlns:office="office" xmlns:text="text" xmlns:table="table"><office:body><table:table table:name="Budget"><table:table-row><table:table-cell table:number-columns-repeated="2"><text:p>Value</text:p></table:table-cell></table:table-row></table:table></office:body></office:document>',
    )
    const bytes = await archive.generateAsync({ type: 'arraybuffer' })
    const worker = createPreviewHandlers()
    expect(await worker.open({ path: 'saved.ods', bytes })).toMatchObject({
      kind: 'table',
      names: ['Budget'],
      rows: [['Value', 'Value']],
    })
    expect(await worker.open({ path: 'saved.odt', bytes })).toMatchObject({
      kind: 'document',
      pages: [expect.stringContaining('<table>')],
    })
  })

  it('uses the EPUB spine rather than archive filename order', async () => {
    const archive = new JSZip()
      .file(
        'META-INF/container.xml',
        '<container><rootfiles><rootfile full-path="book/package.opf"/></rootfiles></container>',
      )
      .file(
        'book/package.opf',
        '<package><manifest><item id="chapter" href="z.html"/><item id="intro" href="a.html"/></manifest><spine><itemref idref="chapter"/><itemref idref="intro"/></spine></package>',
      )
      .file('book/z.html', '<html><body><p>Chapter</p></body></html>')
      .file('book/a.html', '<html><body><p>Introduction</p></body></html>')
    const output = await createPreviewHandlers().open({
      path: 'saved.epub',
      bytes: await archive.generateAsync({ type: 'arraybuffer' }),
    })
    expect(output).toMatchObject({
      kind: 'document',
      pages: [expect.stringContaining('Chapter'), expect.stringContaining('Introduction')],
    })
  })

  it('preserves binary archive entries as binary rather than interpreting them as text', async () => {
    const archive = new JSZip().file('binary.dat', new Uint8Array([0, 1, 2]))
    const worker = createPreviewHandlers()
    await worker.open({ path: 'saved.zip', bytes: await archive.generateAsync({ type: 'arraybuffer' }) })
    expect(await worker.select({ name: 'binary.dat' })).toMatchObject({ kind: 'archive', selected: 'binary.dat' })
    expect(await worker.select({ name: 'binary.dat' })).not.toHaveProperty('text', expect.any(String))
  })

  it('opens a Word document and an archive, then releases its entry selection', async () => {
    const worker = createPreviewHandlers()
    const doc = new JSZip().file(
      'word/document.xml',
      '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Document text</w:t></w:r></w:p></w:body></w:document>',
    )
    expect(
      await worker.open({ path: 'example.docx', bytes: await doc.generateAsync({ type: 'arraybuffer' }) }),
    ).toMatchObject({ kind: 'document', pages: [expect.stringContaining('Document text')] })
    const zip = new JSZip().file('saved.txt', 'Saved contents')
    expect(
      await worker.open({ path: 'example.zip', bytes: await zip.generateAsync({ type: 'arraybuffer' }) }),
    ).toMatchObject({ kind: 'archive' })
    expect(await worker.select({ name: 'saved.txt' })).toMatchObject({ selected: 'saved.txt', text: 'Saved contents' })
    worker.close()
    await expect(worker.select({ name: 'saved.txt' })).rejects.toThrow('closed')
  })
})
