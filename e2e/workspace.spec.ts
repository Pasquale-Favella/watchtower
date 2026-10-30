import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test } from '@playwright/test'
import * as Schema from 'effect/Schema'

import { workspaceProjectRegistrationSchema } from '../src/shared/schemas/workspace-projects'
import { dismissOnboarding, launchApp } from './app'
import { invokeRpc, invokeRpcStreamFirst } from './rpc-probe'

test('workspace stays lazy, persists project and task across reload, and closes cleanly', async () => {
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-workspace-'))
  const repository = join(directory, 'repository')
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    execFileSync('git', ['init', repository], { stdio: 'pipe' })
    writeFileSync(join(repository, 'README.md'), 'Workspace integration fixture\n')
    execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'pipe' })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Workspace Test',
        '-c',
        'user.email=workspace@example.invalid',
        'commit',
        '-m',
        'Initial fixture',
      ],
      {
        cwd: repository,
        stdio: 'pipe',
      },
    )
    launched = await launchApp(directory)
    const { app, window, pageErrors } = launched
    await dismissOnboarding(window)
    const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const shutdownLog = join(directory, 'shutdown.jsonl')
    await app.evaluate(({ app: electronApp }, destination) => {
      const fs = process.getBuiltinModule('fs')
      const path = process.getBuiltinModule('path')
      const logDirectory = path.join(electronApp.getPath('userData'), 'logs')
      electronApp.once('will-quit', () => {
        const records = fs
          .readdirSync(logDirectory)
          .filter(name => name.startsWith('operational'))
          .map(name => fs.readFileSync(path.join(logDirectory, name), 'utf8'))
        fs.writeFileSync(destination, records.join('\n'))
      })
    }, shutdownLog)
    expect(existsSync(join(profile, 'ledger.db'))).toBe(true)
    expect(existsSync(join(profile, 'workspace.db'))).toBe(false)
    expect(await invokeRpc(window, 'workspace:status')).toEqual({
      ok: true,
      value: { protocolVersion: 1, state: 'not-started', ownerEpoch: null, highWatermark: 0 },
    })
    expect(existsSync(join(profile, 'workspace.db'))).toBe(false)

    const registration = { commandId: randomUUID(), path: repository, name: 'Workspace fixture' }
    const registered = await invokeRpc(window, 'workspace:registerProject', registration)
    expect(registered).toMatchObject({ ok: true, value: { commandId: registration.commandId, replayed: false } })
    if (!registered.ok) throw new Error('Project registration failed')
    const { project } = Schema.decodeUnknownSync(workspaceProjectRegistrationSchema)(registered.value)
    expect(existsSync(join(profile, 'workspace.db'))).toBe(true)
    const task = {
      commandId: randomUUID(),
      projectId: project.id,
      title: 'Verify workspace composition',
      description: 'No inference required.',
    }
    const created = await invokeRpc(window, 'workspace:createTask', task)
    expect(created).toMatchObject({ ok: true, value: { commandId: task.commandId, replayed: false } })
    const projects = await invokeRpc(window, 'workspace:listProjects', {})
    expect(projects).toMatchObject({
      ok: true,
      value: { total: 1, items: [{ id: project.id, name: registration.name }] },
    })
    const tasks = await invokeRpc(window, 'workspace:listTasks', { projectId: project.id })
    expect(tasks).toMatchObject({ ok: true, value: { total: 1, items: [{ title: task.title }] } })
    expect(await invokeRpcStreamFirst(window, 'workspace:events', { afterSequence: 0 })).toMatchObject({
      ok: true,
      value: {
        protocolVersion: 1,
        _tag: 'Snapshot',
        throughSequence: 0,
        page: { events: [], highWatermark: 0, hasMore: false },
      },
    })

    await window.reload()
    await expect(window.getByRole('button', { name: 'Overview', exact: true })).toBeVisible()
    expect(await invokeRpc(window, 'workspace:listProjects', {})).toEqual(projects)
    expect(await invokeRpc(window, 'workspace:listTasks', { projectId: project.id })).toEqual(tasks)
    expect(await invokeRpc(window, 'workspace:registerProject', registration)).toMatchObject({
      ok: true,
      value: { commandId: registration.commandId, replayed: true, project: { id: project.id } },
    })
    expect(pageErrors).toEqual([])
    const closeStarted = performance.now()
    await launched.close()
    launched = undefined
    const closeMs = performance.now() - closeStarted
    expect(closeMs).toBeLessThan(15_000)
    const shutdownRecords = readFileSync(shutdownLog, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(shutdownRecords.filter(record => record.event === 'workspace.close')).toEqual([
      expect.objectContaining({ level: 'info', outcome: 'success', code: 'cleanup-confirmed' }),
    ])
    test.info().annotations.push({ type: 'workspace-close-ms', description: closeMs.toFixed(0) })
  } finally {
    await launched?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
