// Talk to the agent from the terminal: npm run chat -- "Should we buy Framewise annual or monthly?"
// Add --after-invoice to play the moment the December price-increase invoice arrives (saved in data/).
// Proposals are printed with their fingerprint; nothing is approved or executed here.
import { converse } from '../src/agent/chat.js'
import type { Proposal } from '../src/approvals/proposals.js'
import { JsonFileStore } from '../src/approvals/store.js'
import { FileStateStore } from '../src/app/state.js'
import { openSession } from '../src/app/session.js'
import { FileRailStore, SimulatedRail } from '../src/rail/simulated.js'
import { PRICE_INCREASE } from '../src/demo/invoices.js'

const args = process.argv.slice(2)
const afterInvoice = args.includes('--after-invoice')
const text = args.filter((a) => a !== '--after-invoice').join(' ').trim()
if (!text) {
  console.error('Usage: npm run chat -- [--after-invoice] "your message"')
  process.exit(1)
}

const session = await openSession({
  api: new SimulatedRail({ store: new FileRailStore('data/rail.json') }),
  store: new JsonFileStore('data/proposals.json'),
  stateStore: new FileStateStore('data/state.json'),
})
if (afterInvoice) console.log(`(invoice arrived: ${(await session.receiveInvoice(PRICE_INCREASE.id)).kind})\n`)

const queue: Proposal[] = []
const tools = session.tools((p) => queue.push(p))
for await (const event of converse([{ role: 'user', text }], tools, queue, { context: session.context() })) {
  if (event.type === 'text') process.stdout.write(event.text)
  else if (event.type === 'tool') process.stdout.write(`\n[${event.name}]\n`)
  else if (event.type === 'proposal') {
    const { id, action, fingerprint } = event.proposal
    console.log(`\n[proposal ${id}] ${JSON.stringify(action)}\n  fingerprint ${fingerprint}`)
  } else if (event.type === 'error') console.error(`\n[error] ${event.message}`)
  else console.log()
}
