// The confirmation card: exactly the terms the founder approves. Approve sends back this proposal's
// fingerprint, so the server only runs what was shown here.
import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { api, ApiError } from '../../../api/client'
import type { Proposal } from '../../../api/types'
import { useTheme } from '../../../theme/ThemeContext'
import { describeCategory, formatCents } from '../../../utils/format'

const TITLES = {
  issue_card: 'Issue a virtual card',
  update_card: 'Update card limits',
  freeze_card: 'Freeze card',
} as const

const OUTCOMES: Record<string, string> = {
  executed: 'Done. The card now enforces these terms.',
  rejected: 'Rejected. Nothing was changed.',
  stale: 'The terms changed after this proposal (new price or cash). Ask the agent for a new one.',
  expired: 'This proposal expired. Ask the agent for a new one.',
  failed: 'The payment rail did not accept it.',
}

export function ProposalCard({ proposal: initial }: { proposal: Proposal }) {
  const { colors } = useTheme()
  const [proposal, setProposal] = useState(initial)
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { action } = proposal

  async function decide(kind: 'approve' | 'reject') {
    setBusy(kind)
    setError(null)
    try {
      setProposal(kind === 'approve' ? await api.approve(proposal) : await api.reject(proposal))
    } catch (e) {
      // A 409 means the proposal moved on (stale, expired, already decided)
      setError(e instanceof ApiError ? e.message : 'Could not reach the server')
    } finally {
      setBusy(null)
    }
  }

  const rows: [string, string][] =
    action.kind === 'freeze_card'
      ? [
          ['Card', action.cardId],
          ['Reason', action.reason],
        ]
      : [
          ['Merchant', `${action.terms.vendor} · ${action.terms.product}`],
          ['Plan', action.terms.plan],
          ['Limit per charge', formatCents(action.terms.amount, action.terms.currency)],
          [action.terms.plan === 'annual' ? 'Total limit' : 'Monthly limit', formatCents(action.terms.amount, action.terms.currency)],
          ['Currency', `${action.terms.currency} only`],
          ['Merchant category', describeCategory(action.terms.merchantCategoryCode)],
          ...(action.terms.revisitOn ? ([['Revisit annual on', action.terms.revisitOn]] as [string, string][]) : []),
        ]

  const pending = proposal.status === 'pending'
  const outcome = OUTCOMES[proposal.status]
  const outcomeColor = proposal.status === 'executed' ? colors.success : proposal.status === 'rejected' ? colors.muted : colors.warning

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
      <Text style={[styles.label, { color: colors.primary }]}>NEEDS YOUR APPROVAL</Text>
      <Text style={[styles.title, { color: colors.text }]}>{TITLES[action.kind]}</Text>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.row}>
          <Text style={[styles.key, { color: colors.muted }]}>{k}</Text>
          <Text style={[styles.value, { color: colors.text }]}>{v}</Text>
        </View>
      ))}
      <Text style={[styles.note, { color: colors.muted }]}>
        The card declines any other amount, currency or merchant category.
      </Text>

      {pending ? (
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            disabled={busy !== null}
            onPress={() => decide('reject')}
            style={[styles.button, { borderColor: colors.border }]}
          >
            {busy === 'reject' ? <ActivityIndicator color={colors.text} /> : <Text style={{ color: colors.text }}>Reject</Text>}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy !== null}
            onPress={() => decide('approve')}
            style={[styles.button, { backgroundColor: colors.primary, borderColor: colors.primary }]}
          >
            {busy === 'approve' ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={{ color: colors.onPrimary, fontWeight: '600' }}>Approve</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <Text style={[styles.outcome, { color: outcomeColor }]}>
          {outcome ?? proposal.status}
          {proposal.status === 'failed' && proposal.error ? ` ${proposal.error.message}` : ''}
        </Text>
      )}
      {error ? <Text style={[styles.outcome, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: 14, padding: 14, gap: 6, marginVertical: 6 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  key: { fontSize: 14 },
  value: { fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  note: { fontSize: 12, marginTop: 4 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 8 },
  button: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  outcome: { fontSize: 14, marginTop: 6, fontWeight: '600' },
})
