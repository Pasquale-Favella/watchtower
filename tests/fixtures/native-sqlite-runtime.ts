import * as Sqlite from '@effect/sql-sqlite-node'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export type NativeSqliteRuntime = ManagedRuntime.ManagedRuntime<
  Sqlite.SqliteClient.SqliteClient | SqlClient.SqlClient,
  never
>

export function openNativeSqliteRuntime(filename: string): NativeSqliteRuntime {
  return ManagedRuntime.make(Sqlite.SqliteClient.layer({ filename }))
}

export async function withNativeSqliteRuntime<A>(
  filename: string,
  use: (runtime: NativeSqliteRuntime) => A | Promise<A>,
): Promise<A> {
  const runtime = openNativeSqliteRuntime(filename)
  try {
    return await use(runtime)
  } finally {
    await runtime.dispose()
  }
}
