/**
 * Puente de tipos para los estilos de React Native 0.87.
 *
 * En RN 0.87 los tipos públicos de estilo (`TextStyle`, `ViewStyle`) se generan
 * como intersecciones de `Omit<...>`. TypeScript no logra resolver las claves de
 * esas intersecciones, así que el excess property check rechaza tanto los
 * literales anotados como el resultado de `StyleSheet.create`, aunque el código
 * sea correcto en tiempo de ejecución. Es una limitación de los tipos generados
 * por React Native, no un error de este proyecto.
 *
 * `textStyle` y `viewStyle` concentran el único `cast` necesario. Los estilos
 * siguen validándose por completo: se comprueban contra los tipos de estilo
 * "planos" de React Native (`Libraries/StyleSheet/StyleSheetTypes`), que sí
 * describen `fontSize`, `flex`, `padding`, etc. Un nombre de propiedad
 * equivocado sigue marcando error de compilación.
 */
import type { ComponentProps } from 'react';
import type { Text, View } from 'react-native';
import type {
  TextStyle as PlainTextStyle,
  ViewStyle as PlainViewStyle,
} from 'react-native/Libraries/StyleSheet/StyleSheetTypes';

/** Tipo exacto que React Native acepta en la prop `style` de `Text`. */
type TextStyleProp = ComponentProps<typeof Text>['style'];

/** Tipo exacto que React Native acepta en la prop `style` de `View`. */
type ViewStyleProp = ComponentProps<typeof View>['style'];

export const textStyle = (style: PlainTextStyle): TextStyleProp => style as TextStyleProp;

export const viewStyle = (style: PlainViewStyle): ViewStyleProp => style as ViewStyleProp;

export type { PlainTextStyle, PlainViewStyle };
