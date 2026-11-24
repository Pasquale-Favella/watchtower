import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'

import type { PullRequestCommand, PullRequestInput } from './lib.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)
export const pullRequestListAtom = () =>
  runtime.fn<PullRequestInput<'pull-requests:list'>>()(
    request => Effect.flatMap(ApplicationClient, client => client('pull-requests:list', request)),
    { concurrent: true },
  )
export const pullRequestDetailAtom = () =>
  runtime.fn<PullRequestInput<'pull-requests:detail'>>()(
    request => Effect.flatMap(ApplicationClient, client => client('pull-requests:detail', request)),
    { concurrent: true },
  )
export const pullRequestChecksAtom = () =>
  runtime.fn<PullRequestInput<'pull-requests:checks'>>()(
    request => Effect.flatMap(ApplicationClient, client => client('pull-requests:checks', request)),
    { concurrent: true },
  )
export const pullRequestDiffAtom = () =>
  runtime.fn<PullRequestInput<'pull-requests:diff'>>()(
    request => Effect.flatMap(ApplicationClient, client => client('pull-requests:diff', request)),
    { concurrent: true },
  )
export const pullRequestThreadsAtom = () =>
  runtime.fn<PullRequestInput<'pull-requests:threads'>>()(
    request => Effect.flatMap(ApplicationClient, client => client('pull-requests:threads', request)),
    { concurrent: true },
  )
export const pullRequestCreateAtom = () =>
  runtime.fn<PullRequestInput<'pull-requests:create'>>()(
    request => Effect.flatMap(ApplicationClient, client => client('pull-requests:create', request)),
    { concurrent: true },
  )
export const pullRequestCommandAtom = () =>
  runtime.fn<PullRequestCommand>()(
    command =>
      Effect.flatMap(ApplicationClient, client => {
        switch (command.tag) {
          case 'pull-requests:comment':
            return client(command.tag, command.request)
          case 'pull-requests:review':
            return client(command.tag, command.request)
          case 'pull-requests:reply':
            return client(command.tag, command.request)
          case 'pull-requests:resolveThread':
            return client(command.tag, command.request)
          case 'pull-requests:action':
            return client(command.tag, command.request)
          case 'pull-requests:update':
            return client(command.tag, command.request)
        }
      }),
    { concurrent: true },
  )
