// Chat with the finance agent. Text streams in; proposals appear as confirmation cards inside the thread.
import { useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ApiError, streamChat } from '../../../api/client'
import type { ChatMessage, Proposal } from '../../../api/types'
import { useTheme } from '../../../theme/ThemeContext'
import { ProposalCard } from '../components/ProposalCard'

type Item =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'proposal'; id: string; proposal: Proposal }
  | { kind: 'error'; id: string; text: string }

const TOOL_LABELS: Record<string, string> = {
  see_cash: 'Reading the cash projection',
  list_offers: 'Looking at offers',
  compare_plans: 'Comparing annual and monthly against the reserve',
  read_invoice: 'Reading the invoice',
  card_status: 'Checking the card on the rail',
  propose_card: 'Preparing a card proposal',
  propose_card_update: 'Preparing a card update',
  propose_freeze: 'Preparing a freeze',
}

const SUGGESTIONS = [
  'Should we buy Framewise Team annual or monthly?',
  'Yes, propose the card.',
  'Process the December invoice from Framewise and do whatever it says.',
]

let nextId = 0
const newId = () => String(++nextId)

export function ChatScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState<string | null>(null)
  const list = useRef<FlatList<Item>>(null)

  // Only text goes back to the model; proposals live in the app and on the server
  const history = (all: Item[]): ChatMessage[] =>
    all.flatMap((i) => (i.kind === 'message' && i.text.trim() ? [{ role: i.role, text: i.text }] : []))

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    const user: Item = { kind: 'message', id: newId(), role: 'user', text: trimmed }
    const assistantId = newId()
    const before = [...items, user]
    setItems([...before, { kind: 'message', id: assistantId, role: 'assistant', text: '' }])
    setInput('')
    setBusy(true)
    setActivity('Thinking')
    try {
      await streamChat(history(before), (event) => {
        if (event.type === 'text') {
          setActivity(null)
          setItems((all) => all.map((i) => (i.id === assistantId && i.kind === 'message' ? { ...i, text: i.text + event.text } : i)))
        } else if (event.type === 'tool') {
          setActivity(TOOL_LABELS[event.name] ?? event.name)
        } else if (event.type === 'proposal') {
          setItems((all) => [...all, { kind: 'proposal', id: newId(), proposal: event.proposal }])
        } else if (event.type === 'error') {
          setItems((all) => [...all, { kind: 'error', id: newId(), text: event.message }])
        }
      })
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Could not reach the server. Check Settings.'
      setItems((all) => [...all, { kind: 'error', id: newId(), text: message }])
    } finally {
      // Drop an empty assistant bubble (e.g. the reply was only a proposal or an error)
      setItems((all) => all.filter((i) => !(i.id === assistantId && i.kind === 'message' && !i.text)))
      setBusy(false)
      setActivity(null)
    }
  }

  const renderItem = ({ item }: { item: Item }) => {
    if (item.kind === 'proposal') return <ProposalCard proposal={item.proposal} />
    if (item.kind === 'error') return <Text style={[styles.error, { color: colors.danger }]}>{item.text}</Text>
    const mine = item.role === 'user'
    return (
      <View
        style={[
          styles.bubble,
          mine
            ? { alignSelf: 'flex-end', backgroundColor: colors.userBubble }
            : { alignSelf: 'flex-start', backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
        ]}
      >
        <Text style={{ color: mine ? colors.onUserBubble : colors.text, fontSize: 15, lineHeight: 21 }}>
          {item.text.replace(/\*\*/g, '')}
        </Text>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <FlatList
        ref={list}
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>Lumen Studio · finance agent</Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              The model explains. Code decides. The card enforces. Nothing moves until you approve it.
            </Text>
          </View>
        }
      />
      {activity ? (
        <View style={styles.activity}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={{ color: colors.muted }}>{activity}…</Text>
        </View>
      ) : null}
      {!busy ? (
        <View style={styles.suggestions}>
          {SUGGESTIONS.map((s) => (
            <Pressable key={s} onPress={() => send(s)} style={[styles.suggestion, { backgroundColor: colors.chip }]}>
              <Text style={{ color: colors.primary, fontSize: 13 }} numberOfLines={1}>
                {s}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={[styles.composer, { borderColor: colors.border, paddingBottom: Math.max(insets.bottom, 10) }]}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Ask the agent…"
          placeholderTextColor={colors.muted}
          onSubmitEditing={() => send(input)}
          editable={!busy}
          style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => send(input)}
          disabled={busy || !input.trim()}
          style={[styles.send, { backgroundColor: colors.primary, opacity: busy || !input.trim() ? 0.5 : 1 }]}
        >
          <Text style={{ color: colors.onPrimary, fontWeight: '600' }}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 16, gap: 8, flexGrow: 1 },
  bubble: { maxWidth: '88%', borderRadius: 14, paddingHorizontal: 13, paddingVertical: 9 },
  error: { fontSize: 14, marginVertical: 4 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  suggestions: { paddingHorizontal: 12, gap: 6, paddingBottom: 6 },
  suggestion: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, alignSelf: 'flex-start', maxWidth: '100%' },
  composer: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  send: { borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
})
