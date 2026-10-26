import * as Layer from 'effect/Layer'

import { runtime } from '@/app/renderer-runtime'

import { openExternal } from './native-shell.js'

/** Native shell commands keep their guarded main-process owners. */
export const openExternalAtom = runtime(Layer.empty).fn((url: string) => openExternal(url))
