import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { textStyle, viewStyle } from '../styles';

/**
 * Pantalla inicial de la app móvil.
 *
 * En la Fase 1 no hay operaciones de campo todavía: la app se construye en la
 * Fase 9 con la cola offline. Esta pantalla existe para validar que el
 * arranque de Expo, el router y la integración con el monorepo funcionan.
 */
const PLANNED_OPERATIONS = [
  'Registrar producción de huevos',
  'Registrar consumo de alimento',
  'Registrar peso de cerdos',
  'Registrar venta',
  'Registrar pago o abono',
  'Registrar gasto',
  'Registrar mortalidad',
  'Registrar inventario',
] as const;

export default function IndexScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.brand}>AgroEmprende</Text>
        <Text style={styles.title}>Registro rápido en campo</Text>
        <Text style={styles.subtitle}>
          La app móvil usará el mismo backend, el mismo motor de cálculos y las mismas reglas que la
          web. Funcionará con conexión intermitente: las operaciones se guardan en una cola local y
          se sincronizan sin duplicar registros.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Operaciones de campo previstas</Text>
          {PLANNED_OPERATIONS.map((operation) => (
            <Text key={operation} style={styles.item}>
              · {operation}
            </Text>
          ))}
        </View>

        <Text style={styles.footer}>
          Fase 1 de 10: arquitectura y cimientos. Autenticación y conexión con la base de datos
          llegan en la Fase 2; la cola offline se implementa en la Fase 9.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Los estilos se definen con `textStyle` / `viewStyle` (ver `../styles.ts`)
 * porque los tipos públicos de estilo de React Native 0.87 no admiten literales
 * ni `StyleSheet.create`. Los nombres de propiedad sí se validan.
 */
const styles = {
  safe: viewStyle({ flex: 1, backgroundColor: '#ffffff' }),
  content: viewStyle({ padding: 20, gap: 12 }),
  card: viewStyle({
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 16,
    gap: 6,
  }),
  brand: textStyle({ fontSize: 13, fontWeight: '600', color: '#0f5132' }),
  title: textStyle({ fontSize: 24, fontWeight: '700', color: '#1a1a1a' }),
  subtitle: textStyle({ fontSize: 15, lineHeight: 22, color: '#4b5563' }),
  cardTitle: textStyle({ fontSize: 15, fontWeight: '600', marginBottom: 4 }),
  item: textStyle({ fontSize: 14, color: '#374151' }),
  footer: textStyle({ marginTop: 12, fontSize: 13, lineHeight: 19, color: '#6b7280' }),
};
