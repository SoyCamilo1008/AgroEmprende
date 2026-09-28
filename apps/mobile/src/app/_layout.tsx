import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * Layout raíz de la app móvil.
 *
 * La aplicación móvil comparte el MISMO backend, el mismo motor de cálculos y
 * los mismos esquemas de validación que la web. Nunca es una aplicación
 * independiente con su propia lógica ni su propia base de datos.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerTitleAlign: 'center' }}>
        <Stack.Screen name="index" options={{ title: 'AgroEmprende' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
