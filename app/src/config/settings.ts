// Where the API lives and the demo token. Defaults come from EXPO_PUBLIC_* at build time and can be changed
// on the Settings screen (saved on the device), so a TestFlight build can point at a new address without a rebuild.
import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import { Platform } from 'react-native'

export interface Settings {
  apiUrl: string
  token: string
}

const KEY = 'halcyon-contabil:settings'

// In development the phone reaches the API on the same machine as Metro (port 3000)
function devApiUrl(): string {
  if (Platform.OS === 'web') return 'http://localhost:3000'
  const host = Constants.expoConfig?.hostUri?.split(':')[0]
  return host ? `http://${host}:3000` : 'http://localhost:3000'
}

export const defaultSettings = (): Settings => ({
  apiUrl: process.env.EXPO_PUBLIC_API_URL || devApiUrl(),
  token: process.env.EXPO_PUBLIC_DEMO_TOKEN || '',
})

export async function loadSettings(): Promise<Settings> {
  try {
    const saved = await AsyncStorage.getItem(KEY)
    if (saved) return { ...defaultSettings(), ...(JSON.parse(saved) as Partial<Settings>) }
  } catch {}
  return defaultSettings()
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify({ ...settings, apiUrl: settings.apiUrl.replace(/\/+$/, '') }))
}
