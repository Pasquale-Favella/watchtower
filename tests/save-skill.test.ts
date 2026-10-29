import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import { afterEach, describe, expect, it } from 'vitest'

import { saveSkill, SaveSkillError } from '../src/core/application/commands/save-skill.js'

let tempDir = ''

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('saveSkill', () => {
  it('creates nested parent directories before writing the skill file', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'watchtower-save-skill-'))
    const target = join(tempDir, '.agents', 'skills', 'nested-skill', 'SKILL.md')
    const content = '# Nested skill\n\nSaved from the draft board.\n'

    await expect(
      Effect.runPromise(saveSkill(target, content).pipe(Effect.provide(NodeFileSystem.layer))),
    ).resolves.toBe(target)
    await expect(readFile(target, 'utf8')).resolves.toBe(content)
  })

  it('keeps filesystem failures typed and preserves the original message', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'watchtower-save-skill-'))
    const parentFile = join(tempDir, 'not-a-directory')
    writeFileSync(parentFile, 'file blocks the requested directory')
    const target = join(parentFile, 'SKILL.md')
    let expectedMessage = ''
    try {
      await mkdir(dirname(target), { recursive: true })
    } catch (error) {
      expectedMessage = error instanceof Error ? error.message : String(error)
    }

    const exit = await Effect.runPromiseExit(saveSkill(target, '# Skill').pipe(Effect.provide(NodeFileSystem.layer)))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      expect(error).toBeInstanceOf(SaveSkillError)
      expect(error.message).toBe(expectedMessage)
    }
  })
})
