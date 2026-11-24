import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { defaultRehypePlugins, type StreamdownProps } from 'streamdown'

export const markdownRehypePlugins: NonNullable<StreamdownProps['rehypePlugins']> = [
  defaultRehypePlugins.raw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      clobberPrefix: 'markdown-',
      protocols: {
        ...defaultSchema.protocols,
        src: [...(defaultSchema.protocols?.src ?? []), 'data', 'file', ...'abcdefghijklmnopqrstuvwxyz'],
        href: [...(defaultSchema.protocols?.href ?? []), 'file', ...'abcdefghijklmnopqrstuvwxyz'],
      },
      attributes: { ...defaultSchema.attributes, code: [...(defaultSchema.attributes?.code ?? []), 'metastring'] },
    },
  ],
]
