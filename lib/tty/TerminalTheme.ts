import type { ITheme } from 'xterm'

export const TERMINAL_THEME: ITheme = Object.freeze({
  background: '#050505',
  foreground: '#d4d4d8',
  cursor: '#22d3ee',
  cursorAccent: '#050505',
  selectionBackground: '#164e63',
  selectionForeground: '#ecfeff',
  black: '#09090b',
  red: '#fb7185',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fda4af',
  brightGreen: '#6ee7b7',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa'
})

export const TERMINAL_FONT_FAMILY = 'var(--font-jetbrains-mono), var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace'
export const TERMINAL_FONT_SIZE = 13
export const TERMINAL_SCROLLBACK = 10_000

