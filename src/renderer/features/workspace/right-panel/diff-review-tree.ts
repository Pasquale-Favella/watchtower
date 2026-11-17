/** A removed file can share its path with a directory in the new tree. Pierre needs distinct model paths. */
export function diffTreePresentation(paths: readonly string[]) {
  const directories = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index++) directories.add(`${segments.slice(0, index).join('/')}/`)
  }
  const occupied = new Set(paths.flatMap(path => path.toLowerCase().split('/')))
  const toReal = new Map<string, string>()
  const toModel = new Map<string, string>()
  const modelPaths = paths.map(path => {
    if (!directories.has(`${path}/`)) return path
    let alias = path
    do {
      alias += '\u200b'
    } while (occupied.has((alias.split('/').at(-1) ?? alias).toLowerCase()))
    occupied.add((alias.split('/').at(-1) ?? alias).toLowerCase())
    toReal.set(alias, path)
    toModel.set(path, alias)
    return alias
  })
  return {
    paths: modelPaths,
    directories: [...directories],
    selectionPath: (path: string): string => toReal.get(path) ?? path,
    modelPath: (path: string): string => toModel.get(path) ?? path,
  }
}
