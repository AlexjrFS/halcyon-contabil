// Light and dark colors, following the system setting
import { createContext, useContext, type ReactNode } from 'react'
import { useColorScheme } from 'react-native'

const light = {
  background: '#F6F7F9',
  surface: '#FFFFFF',
  border: '#E3E6EA',
  text: '#14171A',
  muted: '#5E6670',
  primary: '#0F766E',
  onPrimary: '#FFFFFF',
  userBubble: '#0F766E',
  onUserBubble: '#FFFFFF',
  success: '#15803D',
  danger: '#B42318',
  warning: '#B45309',
  chip: '#E8F3F2',
}

export type Colors = typeof light

const dark: Colors = {
  background: '#0E1114',
  surface: '#171B20',
  border: '#2A3038',
  text: '#ECEFF2',
  muted: '#9AA3AD',
  primary: '#2DB3A6',
  onPrimary: '#06201D',
  userBubble: '#1D6F68',
  onUserBubble: '#FFFFFF',
  success: '#4ADE80',
  danger: '#F87171',
  warning: '#FBBF24',
  chip: '#1C2A29',
}

const ThemeContext = createContext<{ colors: Colors; dark: boolean }>({ colors: light, dark: false })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const isDark = useColorScheme() === 'dark'
  return <ThemeContext.Provider value={{ colors: isDark ? dark : light, dark: isDark }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
