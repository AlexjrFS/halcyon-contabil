// Where proposals live between "proposed", "approved" and "executed": a JSON file on the server's disk (a Docker
// volume on the VM), or memory in tests.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Proposal, ProposalStore } from './proposals.js'

// Both stores hand out copies, so a caller only changes state through save()
export class MemoryStore implements ProposalStore {
  private readonly items = new Map<string, Proposal>()

  async get(id: string) {
    const item = this.items.get(id)
    return item && structuredClone(item)
  }

  async save(proposal: Proposal) {
    this.items.set(proposal.id, structuredClone(proposal))
  }

  async list() {
    return [...this.items.values()].map((p) => structuredClone(p))
  }

  async clear() {
    this.items.clear()
  }
}

export class JsonFileStore implements ProposalStore {
  // Writes run one at a time so concurrent saves never drop each other
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly path = 'data/proposals.json') {}

  private async read(): Promise<Record<string, Proposal>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, Proposal>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  async get(id: string) {
    await this.queue
    return (await this.read())[id]
  }

  async list() {
    await this.queue
    return Object.values(await this.read())
  }

  save(proposal: Proposal): Promise<void> {
    return this.update((all) => {
      all[proposal.id] = proposal
    })
  }

  clear(): Promise<void> {
    return this.update((all) => {
      for (const id of Object.keys(all)) delete all[id]
    })
  }

  private update(change: (all: Record<string, Proposal>) => void): Promise<void> {
    const write = this.queue.then(async () => {
      const all = await this.read()
      change(all)
      await writeJsonAtomic(this.path, all)
    })
    this.queue = write.catch(() => {})
    return write
  }
}

// Write then rename: a crash mid-write never leaves a half-written file
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rename(tmp, path)
}
