import { describe, expect, it } from 'vitest'

import {
  isEmbeddedMarkdownImage,
  isExternalMarkdownUrl,
  markdownFilePath,
  markdownImagePath,
  markdownUrlTransform,
} from '@/renderer/components/markdown/markdown-url'

describe('Markdown navigation and image URLs', () => {
  it('normalizes checkout references and only admits absolute paths inside the current checkout', () => {
    expect(markdownFilePath('./src/app.ts:12:4')).toBe('src/app.ts')
    expect(markdownFilePath('src/app.ts#L12-L18')).toBe('src/app.ts')
    expect(markdownFilePath('src/a%20b.ts:5')).toBe('src/a b.ts')
    expect(markdownFilePath('C:\\work\\repo\\src\\app.ts:12', 'c:\\work\\repo')).toBe('src/app.ts')
    expect(markdownFilePath('file:///C:/work/repo/src/app.ts#L12', 'C:\\work\\repo')).toBe('src/app.ts')
    expect(markdownFilePath('/work/repo/src/app.ts', '/work/repo')).toBe('src/app.ts')
    for (const path of [
      '../secret',
      '%2e%2e/secret',
      'file:///etc/passwd',
      '/work/repository/secret',
      'C:/other/secret',
      'javascript:alert(1)',
      '//server/file',
      'src/file?exec=1',
      'src/%00file',
    ])
      expect(markdownFilePath(path, '/work/repo')).toBeUndefined()
  })
  it('allows web URLs and internal references without accepting executable or local protocols', () => {
    for (const url of ['https://example.com/docs?q=1#section', 'http://localhost:8080', 'HTTPS://example.com']) {
      expect(isExternalMarkdownUrl(url)).toBe(true)
    }
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      '//example.com',
      'https://example.com\n',
      'https://',
    ]) {
      expect(isExternalMarkdownUrl(url)).toBe(false)
    }
    expect(
      markdownUrlTransform('#section-one', 'href', { type: 'element', tagName: 'a', properties: {}, children: [] }),
    ).toBe('#section-one')
  })

  it('allows embedded raster images and rejects SVG, HTML and malformed data', () => {
    expect(isEmbeddedMarkdownImage('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    for (const value of [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png,hello',
      'data:image/png;base64,<script>',
    ]) {
      expect(isEmbeddedMarkdownImage(value)).toBe(false)
    }
    const image = { type: 'element' as const, tagName: 'img', properties: {}, children: [] }
    expect(markdownUrlTransform('data:image/png;base64,iVBORw0KGgo=', 'src', image)).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    )
    expect(markdownUrlTransform('data:image/png;base64,iVBORw0KGgo=', 'href', image)).toBeUndefined()
    expect(markdownUrlTransform('file:///private.png', 'src', image)).toBe('file:///private.png')
  })

  it('retains local raster candidates while resolving only contained image paths', () => {
    const image = { type: 'element' as const, tagName: 'img', properties: {}, children: [] }
    for (const path of [
      'assets/chart.png',
      './assets/large%20chart.webp',
      'C:/work/repo/chart.jpg',
      'file:///C:/work/repo/chart.gif',
    ]) {
      expect(markdownUrlTransform(path, 'src', image)).toBe(path)
    }
    expect(markdownImagePath('assets/chart.png')).toBe('assets/chart.png')
    expect(markdownImagePath('file:///C:/work/repo/chart.gif', 'C:/work/repo')).toBe('chart.gif')
    expect(markdownImagePath('C:\\work\\repo\\chart.bmp', 'C:/work/repo')).toBe('chart.bmp')
    for (const path of [
      '../private.png',
      '/outside/chart.png',
      'file:///C:/other/chart.png',
      'images/chart.svg',
      'data:text/html;base64,YWJj',
      'https://example.com/chart.png',
    ]) {
      expect(markdownImagePath(path, 'C:/work/repo')).toBeUndefined()
    }
    for (const path of [
      '../private.png',
      'images/chart.svg',
      'images/chart.html',
      'javascript:chart.png',
      'images/chart.png?run=1',
    ]) {
      expect(markdownUrlTransform(path, 'src', image)).toBeUndefined()
    }
    expect(isEmbeddedMarkdownImage('data:image/bmp;base64,Qk0=')).toBe(true)
  })
})
