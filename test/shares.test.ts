import { once } from 'node:events'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ShareIndex } from '../src/shares.js'

describe('ShareIndex', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'slsk-shares-'))
    await mkdir(path.join(root, 'Album'))
    await writeFile(path.join(root, 'Album', 'One.FLAC'), 'one')
    await writeFile(path.join(root, 'Album', 'Two.mp3'), 'two!')
    await mkdir(path.join(root, 'Other'))
    await writeFile(path.join(root, 'Other', 'Three.ogg'), 'three')
    await writeFile(path.join(root, '.hidden'), 'secret')
    await symlink(path.join(root, 'Album', 'One.FLAC'), path.join(root, 'link'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('indexes, browses, searches, opens, removes, and clears files', async () => {
    const shares = new ShareIndex()
    expect(shares.fileCount).toBe(0)
    expect(shares.directoryCount).toBe(0)
    expect(shares.size).toBe(0n)
    expect(await shares.addDirectory(root, { alias: 'Library' })).toBe(3)
    expect(shares.fileCount).toBe(3)
    expect(shares.directoryCount).toBe(2)
    expect(shares.size).toBe(12n)
    expect(shares.get('library/album/one.flac')).toMatchObject({
      filename: 'Library\\Album\\One.FLAC',
      size: 3n,
    })
    expect(shares.get('missing')).toBeUndefined()
    expect(shares.browse()[0]).toMatchObject({
      directory: 'Library\\Album',
      files: [{ filename: 'Library\\Album\\One.FLAC' }, { filename: 'Library\\Album\\Two.mp3' }],
    })
    expect(shares.folder('Library')).toHaveLength(2)
    expect(shares.folder('Library\\Album')).toHaveLength(1)
    expect(shares.folder('Elsewhere')).toEqual([])
    expect(shares.search('one flac')).toHaveLength(1)
    expect(shares.search('album -two')).toHaveLength(1)
    expect(shares.search('album', { excludedPhrases: ['one'], limit: 1 })[0]?.filename).toContain('Two')
    expect(shares.search('', { limit: 1 })).toHaveLength(1)
    expect(() => shares.search('x', { limit: 0 })).toThrow(RangeError)
    const stream = shares.open('Library\\Album\\One.FLAC', 1)
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    await once(stream, 'end')
    expect(Buffer.concat(chunks).toString()).toBe('ne')
    expect(() => shares.open('missing')).toThrow('File is not shared')
    expect(shares.remove('library\\album\\one.flac')).toBe(true)
    expect(shares.remove('library\\album\\one.flac')).toBe(false)
    shares.clear()
    expect(shares.fileCount).toBe(0)
  })

  it('includes hidden files on request and supports explicit files and default aliases', async () => {
    const shares = new ShareIndex()
    expect(await shares.addDirectory(root, { includeHidden: true })).toBe(4)
    expect(shares.search('hidden')).toHaveLength(1)
    const added = await shares.addFile(path.join(root, 'Album', 'One.FLAC'), 'Custom/Track.flac')
    expect(added.filename).toBe('Custom\\Track.flac')
  })

  it('validates source paths, aliases, and virtual filenames', async () => {
    const shares = new ShareIndex()
    await expect(shares.addDirectory(path.join(root, 'Album', 'One.FLAC'))).rejects.toThrow('not a directory')
    await expect(shares.addDirectory(root, { alias: '///' })).rejects.toThrow('alias cannot be empty')
    await expect(shares.addFile(root, 'Folder\\x')).rejects.toThrow('not a regular file')
    await expect(shares.addFile(path.join(root, 'Album', 'One.FLAC'), '')).rejects.toThrow(
      'shared filename cannot be empty',
    )
  })
})
