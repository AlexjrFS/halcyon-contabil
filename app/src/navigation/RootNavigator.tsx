import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { CardScreen } from '../features/card/screens/CardScreen'
import { ChatScreen } from '../features/chat/screens/ChatScreen'
import { SettingsScreen } from '../features/settings/screens/SettingsScreen'
import { useTheme } from '../theme/ThemeContext'

export type RootStackParamList = {
  Chat: undefined
  Card: undefined
  Settings: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

function HeaderLinks({ navigation }: Pick<NativeStackScreenProps<RootStackParamList, 'Chat'>, 'navigation'>) {
  const { colors } = useTheme()
  return (
    <View style={styles.links}>
      <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Card')} hitSlop={8}>
        <Text style={[styles.link, { color: colors.primary }]}>Card</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Settings')} hitSlop={8}>
        <Text style={[styles.link, { color: colors.primary }]}>Settings</Text>
      </Pressable>
    </View>
  )
}

export function RootNavigator() {
  const { colors, dark } = useTheme()
  const base = dark ? DarkTheme : DefaultTheme
  return (
    <NavigationContainer
      theme={{ ...base, colors: { ...base.colors, background: colors.background, card: colors.surface, text: colors.text, primary: colors.primary, border: colors.border } }}
    >
      <Stack.Navigator>
        <Stack.Screen
          name="Chat"
          component={ChatScreen}
          options={({ navigation }) => ({ title: 'Halcyon-contabil', headerRight: () => <HeaderLinks navigation={navigation} /> })}
        />
        <Stack.Screen name="Card" component={CardScreen} options={{ title: 'Virtual card' }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}

const styles = StyleSheet.create({
  links: { flexDirection: 'row', gap: 18 },
  link: { fontSize: 16, fontWeight: '600' },
})
