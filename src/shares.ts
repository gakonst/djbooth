import { createReadStream, type ReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import type { BrowseFolder, SharedFile } from './protocol/index.js'

export interface LocalShare extends SharedFile {
  readonly realPath: string
}

export interface AddDirectoryOptions {
  readonly alias?: string
  readonly includeHidden?: boolean
}

export interface ShareSearchOptions {
  readonly excludedPhrases?: readonly string[]
  readonly limit?: number
}

function virtualPath(...parts: string[]): string {
  return parts.join('\\').replaceAll('/', '\\').replaceAll(/\\+/g, '\\')
}

function safeAlias(value: string): string {
  const alias = value.replaceAll(/[\\/]/g, ' ').trim()
  if (!alias) throw new TypeError('share alias cannot be empty')
  return alias
}

/** An immutable-at-read share index used for browse, search, and upload responses. */
export class ShareIndex {
  #files = new Map<string, LocalShare>()

  get fileCount(): number {
    return this.#files.size
  }

  get directoryCount(): number {
    return new Set([...this.#files.keys()].map((filename) => path.win32.dirname(filename))).size
  }

  get size(): bigint {
    let total = 0n
    for (const file of this.#files.values()) total += file.size
    return total
  }

  async addFile(realFilename: string, sharedFilename: string): Promise<LocalShare> {
    const resolved = await realpath(realFilename)
    const metadata = await stat(resolved)
    if (!metadata.isFile()) throw new TypeError(`${realFilename} is not a regular file`)
    const filename = virtualPath(sharedFilename)
    if (!filename || filename === '.') throw new TypeError('shared filename cannot be empty')
    const share: LocalShare = {
      code: 1,
      filename,
      size: BigInt(metadata.size),
      attributes: {},
      realPath: resolved,
    }
    this.#files.set(filename.toLocaleLowerCase(), share)
    return share
  }

  async addDirectory(root: string, options: AddDirectoryOptions = {}): Promise<number> {
    const resolvedRoot = await realpath(root)
    const metadata = await stat(resolvedRoot)
    if (!metadata.isDirectory()) throw new TypeError(`${root} is not a directory`)
    const alias = safeAlias(options.alias ?? path.basename(resolvedRoot))
    const before = this.fileCount

    const walk = async (directory: string, relative: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (!options.includeHidden && entry.name.startsWith('.')) continue
        const real = path.join(directory, entry.name)
        const nextRelative = path.join(relative, entry.name)
        if (entry.isDirectory()) await walk(real, nextRelative)
        else if (entry.isFile()) await this.addFile(real, virtualPath(alias, nextRelative))
      }
    }

    await walk(resolvedRoot, '')
    return this.fileCount - before
  }

  get(sharedFilename: string): LocalShare | undefined {
    return this.#files.get(virtualPath(sharedFilename).toLocaleLowerCase())
  }

  remove(sharedFilename: string): boolean {
    return this.#files.delete(virtualPath(sharedFilename).toLocaleLowerCase())
  }

  clear(): void {
    this.#files.clear()
  }

  open(sharedFilename: string, start = 0): ReadStream {
    const share = this.get(sharedFilename)
    if (!share) throw new Error(`File is not shared: ${sharedFilename}`)
    return createReadStream(share.realPath, { start })
  }

  search(query: string, options: ShareSearchOptions = {}): SharedFile[] {
    const words = query
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter(Boolean)
    const include = words.filter((word) => !word.startsWith('-'))
    const exclude = words.filter((word) => word.startsWith('-')).map((word) => word.slice(1))
    const prohibited = (options.excludedPhrases ?? []).map((phrase) => phrase.toLocaleLowerCase())
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('search limit must be positive')
    const results: SharedFile[] = []
    for (const file of this.#files.values()) {
      const candidate = file.filename.toLocaleLowerCase()
      if (
        include.every((word) => candidate.includes(word)) &&
        exclude.every((word) => !candidate.includes(word)) &&
        prohibited.every((phrase) => !candidate.includes(phrase))
      ) {
        results.push(file)
        if (results.length === limit) break
      }
    }
    return results
  }

  browse(): BrowseFolder[] {
    const folders = new Map<string, SharedFile[]>()
    for (const file of this.#files.values()) {
      const directory = path.win32.dirname(file.filename)
      const values = folders.get(directory) ?? []
      values.push(file)
      folders.set(directory, values)
    }
    return [...folders]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, files]) => ({ directory, files }))
  }

  folder(directory: string): BrowseFolder[] {
    const prefix = `${virtualPath(directory).toLocaleLowerCase()}\\`
    return this.browse().filter(
      (folder) => folder.directory.toLocaleLowerCase() === prefix.slice(0, -1) || folder.directory.toLocaleLowerCase().startsWith(prefix),
    )
  }
}
