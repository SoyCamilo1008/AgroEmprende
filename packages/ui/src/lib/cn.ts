import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Combina clases de Tailwind resolviendo conflictos correctamente. */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
