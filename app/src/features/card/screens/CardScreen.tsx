// The issued card as the payment rail reports it, plus test charges sent through the rail.
// Results are shown exactly as the rail answers.
import { useFocusEffect } from '@react-navigation/native'
import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { api, ApiError } from '../../../api/client'
import type { CardView, ChargeKind } from '../../../api/types'
import { useTheme } from '../../../theme/ThemeContext'
import { describeCategory, formatMajor } from '../../../utils/format'

const OFFER = 'framewise'

const CHARGES: { kind: ChargeKind; label: string }[] = [
  { kind: 'monthly', label: 'Monthly charge' },
  { kind: 'annual', label: 'Annual charge' },
  { kind: 'other_currency', label: 'Same price in EUR' },
  { kind: 'other_category', label: 'Restaurant (other category)' },
]

interface Attempt {
  id: number
  label: string
  amount?: string
  outcome: string
  approved: boolean
}

export function CardScreen() {
  const { colors } = useTheme()
  const [card, setCard] = useState<CardView | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [charging, setCharging] = useState<ChargeKind | null>(null)
  const [attempts, setAttempts] = useState<Attempt[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setMessage(null)
    try {
      setCard(await api.card(OFFER))
    } catch (e) {
      setCard(null)
      setMessage(e instanceof ApiError && e.code === 'no_card' ? 'No card yet. Ask the agent and approve a proposal.' : 'Could not load the card.')
    } finally {
      setLoading(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  async function charge(kind: ChargeKind, label: string) {
    setCharging(kind)
    try {
      const { charge, result } = await api.charge(OFFER, kind)
      const approved = result.process_result === 'APPROVED'
      const outcome = approved ? 'Approved' : `Declined · ${result.failure_reason ?? 'DECLINED'}`
      setAttempts((a) => [{ id: Date.now(), label, amount: charge.display, outcome, approved }, ...a])
      // Remaining limits and the rail activity changed
      setCard(await api.card(OFFER))
    } catch (e) {
      const outcome = e instanceof ApiError ? `Rail error · ${e.message}` : 'Could not reach the server'
      setAttempts((a) => [{ id: Date.now(), label, outcome, approved: false }, ...a])
    } finally {
      setCharging(null)
    }
  }

  const controls = card?.card.authorization_controls
  const currency = controls?.transaction_limits.currency ?? 'USD'

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
    >
      {loading && !card ? <ActivityIndicator color={colors.primary} /> : null}
      {message ? <Text style={{ color: colors.muted, textAlign: 'center' }}>{message}</Text> : null}

      {card ? (
        <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.text }]}>Framewise card</Text>
            <Text style={[styles.status, { color: card.card.card_status === 'ACTIVE' ? colors.success : colors.warning }]}>
              {card.card.card_status}
            </Text>
          </View>
          <Text style={{ color: colors.muted, fontSize: 12 }}>{card.cardId}</Text>
          <Text style={[styles.section, { color: colors.muted }]}>Controls enforced by the rail</Text>
          {card.limits.limits.map((l) =>
            l.interval === 'PER_TRANSACTION' ? (
              <Row key={l.interval} label="Per charge" value={formatMajor(l.amount, currency)} />
            ) : (
              <Row
                key={l.interval}
                label={l.interval === 'MONTHLY' ? 'Per month' : 'In total'}
                value={`${formatMajor(l.amount, currency)} · ${formatMajor(l.remaining, currency)} left`}
              />
            ),
          )}
          <Row label="Currencies" value={(controls?.allowed_currencies ?? []).join(', ') || 'any'} />
          <Row label="Merchant categories" value={(controls?.allowed_merchant_categories ?? []).map(describeCategory).join(', ') || 'any'} />
          <Row label="Plan" value={card.plan} />
          {card.card.metadata?.revisit_on ? <Row label="Revisit annual on" value={card.card.metadata.revisit_on} /> : null}
        </View>
      ) : null}

      {card ? (
        <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.text }]}>Test charges</Text>
          <Text style={{ color: colors.muted, fontSize: 13 }}>Sent to the rail as a card network would. Prices come from the offer.</Text>
          <View style={styles.chargeGrid}>
            {CHARGES.map((c) => (
              <Pressable
                key={c.kind}
                disabled={charging !== null}
                onPress={() => charge(c.kind, c.label)}
                style={[styles.chargeButton, { borderColor: colors.primary }]}
              >
                {charging === c.kind ? <ActivityIndicator color={colors.primary} /> : <Text style={{ color: colors.primary }}>{c.label}</Text>}
              </Pressable>
            ))}
          </View>
          {attempts.length === 0 && card.transactions.length === 0 ? (
            <Text style={{ color: colors.muted, fontSize: 13 }}>No charges yet.</Text>
          ) : null}
          {attempts.map((a) => (
            <View key={a.id} style={[styles.attempt, { borderColor: colors.border }]}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>
                {a.label}
                {a.amount ? ` · ${a.amount}` : ''}
              </Text>
              <Text style={{ color: a.approved ? colors.success : colors.danger }}>{a.outcome}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {card && card.transactions.length > 0 ? (
        <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.text }]}>Activity on the rail</Text>
          {card.transactions.map((t) => {
            const declined = t.status === 'FAILED'
            return (
              <View key={t.transaction_id} style={[styles.attempt, { borderColor: colors.border }]}>
                <View style={styles.row}>
                  <Text style={{ color: colors.text, fontWeight: '600' }}>
                    {formatMajor(Math.abs(t.transaction_amount), t.transaction_currency)}
                  </Text>
                  <Text style={{ color: declined ? colors.danger : colors.success, fontWeight: '600' }}>
                    {declined ? `Declined · ${t.failure_reason ?? 'FAILED'}` : t.status === 'PENDING' ? 'Approved · pending' : 'Approved'}
                  </Text>
                </View>
                <Text style={{ color: colors.muted, fontSize: 12 }}>{t.transaction_date.replace('T', ' ').slice(0, 16)} UTC</Text>
              </View>
            )
          })}
        </View>
      ) : null}
    </ScrollView>
  )

  function Row({ label, value }: { label: string; value: string }) {
    return (
      <View style={styles.row}>
        <Text style={{ color: colors.muted }}>{label}</Text>
        <Text style={{ color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>{value}</Text>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  panel: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '700' },
  status: { fontWeight: '700' },
  section: { fontSize: 12, fontWeight: '700', marginTop: 6, textTransform: 'uppercase' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  chargeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chargeButton: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, minWidth: '47%', alignItems: 'center' },
  attempt: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, gap: 2 },
})
