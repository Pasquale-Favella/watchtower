import * as Schema from 'effect/Schema'
import { SaxesParser } from 'saxes'

import type { NotebookCell, PreviewDocument } from './preview-types.js'

export interface PreviewXmlNode {
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: PreviewXmlNode[]
  text: string
}

export function readPreviewXml(source: string): PreviewXmlNode {
  if (source.length > 12 * 1024 * 1024) throw new Error('Document XML exceeds the preview limit.')
  const root: PreviewXmlNode = { name: '', attributes: {}, children: [], text: '' }
  const stack = [root]
  let count = 0
  const parser = new SaxesParser({ xmlns: false })
  parser.on('doctype', () => {
    throw new Error('Document type declarations cannot be previewed.')
  })
  parser.on('opentag', tag => {
    if (++count > 200_000 || stack.length > 100) throw new Error('Document structure exceeds the preview limit.')
    const node: PreviewXmlNode = {
      name: tag.name.split(':').at(-1) ?? tag.name,
      attributes: tag.attributes,
      children: [],
      text: '',
    }
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  })
  parser.on('text', text => {
    stack[stack.length - 1].text += text
  })
  parser.on('cdata', text => {
    stack[stack.length - 1].text += text
  })
  parser.on('closetag', () => {
    stack.pop()
  })
  parser.write(source).close()
  return root
}

export function xmlChildren(node: PreviewXmlNode, name: string): PreviewXmlNode[] {
  return node.children.flatMap(child => (child.name === name ? [child] : xmlChildren(child, name)))
}

export function xmlText(node: PreviewXmlNode): string {
  if (node.name === 'tab') return '\t'
  if (node.name === 'br' || node.name === 'line-break') return '\n'
  if (node.name === 's') return ' '.repeat(Math.min(100, Number(node.attributes['text:c']) || 1))
  return node.text + node.children.map(xmlText).join('')
}

export function escapePreviewText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function attr(node: PreviewXmlNode, name: string): string | undefined {
  return Object.entries(node.attributes).find(([key]) => key.split(':').at(-1) === name)?.[1]
}

function safeColor(value: string | undefined): string | null {
  return value && /^[\da-f]{6}$/i.test(value) ? `#${value}` : null
}

/** Converts passive document nodes into a bounded, script-free document fragment. */
export function documentMarkup(node: PreviewXmlNode, media?: (node: PreviewXmlNode) => string | null): string {
  if (['script', 'style', 'head', 'title'].includes(node.name)) return ''
  const replacement = media?.(node)
  if (replacement !== undefined && replacement !== null) return replacement
  const children = node.children.map(child => documentMarkup(child, media)).join('')
  if (node.name === 'p' || node.name === 'h') {
    const style = node.children.find(child => child.name === 'pPr')
    const heading = style
      ? xmlChildren(style, 'pStyle')
          .map(item => attr(item, 'val'))
          .find(value => /heading/i.test(value ?? ''))
      : null
    const tag = node.name === 'h' || heading ? 'h2' : 'p'
    return `<${tag}>${escapePreviewText(node.text) + children || '<br>'}</${tag}>`
  }
  if (node.name === 'r') {
    const properties = node.children.find(child => child.name === 'rPr')
    let text = children
    if (properties?.attributes.b === '1' || properties?.children.some(child => child.name === 'b'))
      text = `<strong>${text}</strong>`
    if (properties?.attributes.i === '1' || properties?.children.some(child => child.name === 'i'))
      text = `<em>${text}</em>`
    if (properties?.children.some(child => child.name === 'u')) text = `<u>${text}</u>`
    const color = safeColor(properties?.children.find(child => child.name === 'color')?.attributes['w:val'])
    if (color) text = `<span style="color:${color}">${text}</span>`
    return text
  }
  if (node.name === 't' || node.name === 'span') return escapePreviewText(xmlText(node))
  if (node.name === 'tbl' || node.name === 'table') return `<table>${children}</table>`
  if (node.name === 'tr' || node.name === 'table-row') return `<tr>${children}</tr>`
  if (node.name === 'tc' || node.name === 'table-cell' || node.name === 'covered-table-cell')
    return `<td>${children}</td>`
  if (node.name === 'br' && node.attributes['w:type'] === 'page') return '<hr data-page-break>'
  if (node.name === 'br' || node.name === 'line-break') return '<br>'
  if (node.name === 'tab') return '&#9;'
  if (node.name.endsWith('Pr') || node.name === 'annotation') return ''
  return escapePreviewText(node.text) + children
}

export function parsePreviewNotebook(source: string): PreviewDocument {
  if (source.length > 8 * 1024 * 1024) throw new Error('Notebook exceeds the preview limit.')
  const notebook = Schema.decodeUnknownSync(Schema.Struct({ cells: Schema.Array(Schema.Unknown) }))(JSON.parse(source))
  const record = Schema.Record(Schema.String, Schema.Unknown)
  const strings = Schema.Array(Schema.String)
  function text(value: unknown): string {
    if (Schema.is(Schema.String)(value)) return value.slice(0, 1024 * 1024)
    return Schema.is(strings)(value) ? value.join('').slice(0, 1024 * 1024) : ''
  }
  const cells: NotebookCell[] = []
  for (const value of notebook.cells.slice(0, 1000)) {
    if (!Schema.is(record)(value)) continue
    const cell = value
    let kind: NotebookCell['kind'] = 'raw'
    if (cell.cell_type === 'markdown') kind = 'markdown'
    else if (cell.cell_type === 'code') kind = 'code'
    const outputs: { kind: 'text' | 'html' | 'image'; value: string }[] = []
    for (const output of (Schema.is(Schema.Array(Schema.Unknown))(cell.outputs) ? cell.outputs : []).slice(0, 50)) {
      if (!Schema.is(record)(output)) continue
      if ('text' in output) outputs.push({ kind: 'text', value: text(output.text) })
      if ('ename' in output) outputs.push({ kind: 'text', value: `${text(output.ename)}: ${text(output.evalue)}` })
      const data = output.data
      if (!Schema.is(record)(data)) continue
      if ('image/png' in data)
        outputs.push({ kind: 'image', value: `data:image/png;base64,${text(data['image/png'])}` })
      else if ('text/html' in data) outputs.push({ kind: 'html', value: text(data['text/html']) })
      else if ('text/plain' in data) outputs.push({ kind: 'text', value: text(data['text/plain']) })
    }
    cells.push({ kind, source: text(cell.source), outputs })
  }
  return { kind: 'notebook', cells, truncated: notebook.cells.length > cells.length }
}

export function rtfPreviewText(source: string): string {
  if (!source.startsWith('{\\rtf')) throw new Error('Invalid RTF document.')
  const stack: boolean[] = []
  let skipped = false
  let output = ''
  for (let offset = 0; offset < source.length && output.length < 1024 * 1024; offset++) {
    const char = source[offset]
    if (char === '{') {
      stack.push(skipped)
      continue
    }
    if (char === '}') {
      skipped = stack.pop() ?? false
      continue
    }
    if (char !== '\\') {
      if (!skipped && char !== '\r' && char !== '\n') output += char
      continue
    }
    const rest = source.slice(offset + 1)
    const word = /^([a-z]+)(-?\d+)? ?/i.exec(rest)
    if (word) {
      offset += word[0].length
      const control = word[1]
      if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer'].includes(control))
        skipped = true
      if (!skipped && ['par', 'line'].includes(control)) output += '\n'
      else if (!skipped && control === 'tab') output += '\t'
      else if (!skipped && control === 'u' && word[2]) {
        output += String.fromCharCode((Number(word[2]) + 65536) % 65536)
        if (source[offset + 1] === '?') offset++
      }
    } else if (rest[0] === '*') {
      skipped = true
      offset++
    } else if (rest[0] === "'" && /^[\da-f]{2}/i.test(rest.slice(1))) {
      if (!skipped) output += String.fromCharCode(parseInt(rest.slice(1, 3), 16))
      offset += 3
    } else {
      if (!skipped && ['{', '}', '\\'].includes(rest[0])) output += rest[0]
      offset++
    }
  }
  return output.trim()
}
