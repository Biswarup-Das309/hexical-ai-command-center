import { existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const extensions = ['', '.ts', '.tsx', '.js', '.mjs']

export function resolve(specifier, context, nextResolve) {
  const isAlias = specifier.startsWith('@/')
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')

  if (!isAlias && !isRelative) {
    return nextResolve(specifier, context)
  }

  const basePath = isAlias
    ? resolvePath(process.cwd(), specifier.slice(2))
    : resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)
  const targetPath = extensions.map(extension => `${basePath}${extension}`).find(existsSync)

  if (!targetPath) {
    return nextResolve(specifier, context)
  }

  return nextResolve(pathToFileURL(targetPath).href, context)
}
