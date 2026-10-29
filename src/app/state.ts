// Scenario state (cardholder, cards issued, invoices received): a JSON file on the server's disk.
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from '../approvals/store.js'
import type { Plan } from '../policy/cash.js'

export interface IssuedCard {
  cardId: string
  plan: Plan
  proposalId: string
}

export interface DemoState {
  cardholderId?: string
  // By offer id
  cards: Record<string, IssuedCard>
  // Invoice ids in the order they arrived
  invoices: string[]
}

export const emptyState = (cardholderId?: string): DemoState => ({
  ...(cardholderId ? { cardholderId } : {}),
  cards: {},
  invoices: [],
})

export interface StateStore {
  load(): Promise<DemoState>
  save(state: DemoState): Promise<void>
}

export class FileStateStore implements StateStore {
  constructor(readonly path = 'data/state.json') {}

  async load(): Promise<DemoState> {
    try {
      return { ...emptyState(), ...(JSON.parse(await readFile(this.path, 'utf8')) as DemoState) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
      throw error
    }
  }

  save(state: DemoState) {
    return writeJsonAtomic(this.path, state)
  }
}

export class MemoryStateStore implements StateStore {
  private state = emptyState()

  async load() {
    return structuredClone(this.state)
  }

  async save(state: DemoState) {
    this.state = structuredClone(state)
  }
}
