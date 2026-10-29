// Server address and demo token, plus the scenario controls used while recording: the supplier invoice
// arriving, and a reset between takes.
import { useFocusEffect } from '@react-navigation/native'
import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { api, ApiError } from '../../../api/client'
import type { DemoState } from '../../../api/types'
import { defaultSettings, loadSettings, saveSettings, type Settings } from '../../../config/settings'
import { useTheme } from '../../../theme/ThemeContext'

const INVOICE_ID = 'framewise-2026-12'

export function SettingsScreen() {
  const { colors } = useTheme()
  const [settings, setSettings] = useState<Settings>(defaultSettings())
  const [server, setServer] = useState<string>('Checking…')
  const [state, setState] = useState<DemoState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const health = await api.health()
      setServer(`Connected · model ${health.model}`)
      setState(await api.state())
    } catch (e) {
      setState(null)
      setServer(e instanceof ApiError && e.status === 401 ? 'Connected, but the demo token is wrong' : 'Not reachable')
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      loadSettings().then(setSettings)
      refresh()
    }, [refresh]),
  )

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label)
    setNote(null)
    try {
      setNote(await action())
      await refresh()
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not reach the server')
    } finally {
      setBusy(null)
    }
  }

  const input = [styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.text }]}>Server</Text>
        <Text style={{ color: colors.muted }}>{server}</Text>
        <Text style={[styles.label, { color: colors.muted }]}>API address</Text>
        <TextInput
          value={settings.apiUrl}
          onChangeText={(apiUrl) => setSettings({ ...settings, apiUrl })}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={input}
        />
        <Text style={[styles.label, { color: colors.muted }]}>Demo token</Text>
        <TextInput
          value={settings.token}
          onChangeText={(token) => setSettings({ ...settings, token })}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          style={input}
        />
        <Button label="Save and test" busy={busy === 'save'} onPress={() => run('save', async () => (await saveSettings(settings), 'Saved'))} />
      </View>

      <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.text }]}>Demo scenario</Text>
        {state ? (
          <>
            {state.offers.map((o) => (
              <Text key={o.offer_id} style={{ color: colors.text }}>
                {o.vendor} {o.product}: {o.monthly}/month or {o.annual}/year
              </Text>
            ))}
            <Text style={{ color: colors.muted }}>
              {Object.keys(state.cards).length ? `Card issued (${Object.values(state.cards)[0]?.plan})` : 'No card issued yet'}
              {state.invoices.length ? ' · December invoice received' : ''}
            </Text>
          </>
        ) : null}
        <Button
          label="December invoice arrives (price increase)"
          busy={busy === 'invoice'}
          onPress={() =>
            run('invoice', async () => {
              const result = await api.receiveInvoice(INVOICE_ID)
              return result.kind === 'updated'
                ? 'Invoice received: Framewise now costs $690/month. Ask the agent to process it.'
                : `Invoice: ${result.kind}`
            })
          }
        />
        <Button
          label="Reset demo"
          tone="danger"
          busy={busy === 'reset'}
          onPress={() => run('reset', async () => (await api.reset(), 'Demo reset: no proposals, no card, original prices.'))}
        />
        {note ? <Text style={{ color: colors.text }}>{note}</Text> : null}
      </View>
    </ScrollView>
  )

  function Button({ label, onPress, busy: loading, tone }: { label: string; onPress: () => void; busy: boolean; tone?: 'danger' }) {
    const color = tone === 'danger' ? colors.danger : colors.primary
    return (
      <Pressable
        accessibilityRole="button"
        disabled={busy !== null}
        onPress={onPress}
        style={[styles.button, { borderColor: color, opacity: busy !== null && !loading ? 0.5 : 1 }]}
      >
        {loading ? <ActivityIndicator color={color} /> : <Text style={{ color, fontWeight: '600' }}>{label}</Text>}
      </Pressable>
    )
  }
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  panel: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  title: { fontSize: 17, fontWeight: '700' },
  label: { fontSize: 12, fontWeight: '600', marginTop: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  button: { borderWidth: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 4 },
})
