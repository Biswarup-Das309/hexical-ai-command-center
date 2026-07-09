import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Zap, Copy, Check, ArrowLeftRight, UploadCloud, History as HistoryIcon,
  Hash as HashIcon, KeyRound, ShieldCheck, ShieldX, Trash2, X, Sparkles
} from 'lucide-react';

export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber';

const THEME_MAP: Record<AccentTheme, { border: string; text: string; bg: string }> = {
  cyan:    { border: 'border-cyan-500/20',    text: 'text-cyan-400',    bg: 'bg-cyan-500/10' },
  emerald: { border: 'border-emerald-500/20', text: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  rose:    { border: 'border-rose-500/20',    text: 'text-rose-400',    bg: 'bg-rose-500/10' },
  violet:  { border: 'border-violet-500/20',  text: 'text-violet-400',  bg: 'bg-violet-500/10' },
  amber:   { border: 'border-amber-500/20',   text: 'text-amber-400',  bg: 'bg-amber-500/10' },
};

type EncodingType = 'base64' | 'url' | 'hex' | 'rot13' | 'unicode' | 'base32' | 'html' | 'binary' | 'ascii85' | 'morse' | 'json';
type Mode = 'encode' | 'decode';
type Tool = 'text' | 'hash' | 'jwt';
type HashAlgo = 'MD5' | 'SHA-1' | 'SHA-256';
type HistoryTool = 'text' | 'hash';

interface HistoryEntry {
  id: string;
  tool: HistoryTool;
  summary: string;
  input: string;
  output: string;
  timestamp: number;
}

const ENCODING_TYPES: EncodingType[] = ['base64', 'url', 'hex', 'unicode', 'base32', 'ascii85', 'html', 'binary', 'morse', 'json', 'rot13'];
const BYTE_TYPES = new Set<EncodingType>(['base64', 'hex', 'base32', 'ascii85', 'binary']);

const ENCODING_LABELS: Record<EncodingType, string> = {
  base64: 'Base64', url: 'URL', hex: 'Hex', unicode: 'Unicode', base32: 'Base32',
  ascii85: 'Base85', html: 'HTML', binary: 'Binary', morse: 'Morse', json: 'JSON', rot13: 'ROT13',
};

const PRESETS: Record<EncodingType, string> = {
  base64: 'Hello, world!',
  url: 'https://example.com/search?q=hello world&lang=en',
  hex: 'Deadbeef in bytes',
  unicode: 'Café ☕ 你好',
  base32: 'Hello, world!',
  ascii85: 'Hello, world!',
  html: '<div class="greet">Tom & Jerry say "hi"</div>',
  binary: 'Hi!',
  morse: 'SOS HELLO WORLD',
  json: 'Line one\nLine two\t"quoted"',
  rot13: 'The quick brown fox',
};

/* ----------------------------- byte helpers ----------------------------- */

function textToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}
function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
function tryBytesToText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
function digestToHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* --------------------------------- base64 -------------------------------- */

function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
function base64DecodeBytes(str: string): Uint8Array {
  const binary = atob(str.trim());
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

/* ---------------------------------- hex ---------------------------------- */

function hexEncodeBytes(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
function hexDecodeBytes(str: string): Uint8Array {
  const clean = str.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error('Hex string must have an even number of digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Invalid hex character');
    out[i / 2] = byte;
  }
  return out;
}

/* --------------------------------- rot13 --------------------------------- */

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, c => {
    const code = c.charCodeAt(0);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

/* ------------------------------ unicode esc ------------------------------ */

function unicodeEncode(str: string): string {
  return Array.from(str)
    .map(c => {
      const cp = c.codePointAt(0)!;
      if (cp > 0xffff) {
        return Array.from(c).map(u => '\\u' + u.charCodeAt(0).toString(16).padStart(4, '0')).join('');
      }
      return '\\u' + cp.toString(16).padStart(4, '0');
    })
    .join('');
}
function unicodeDecode(str: string): string {
  if (!/^(\\u[0-9a-fA-F]{4})*$/.test(str)) throw new Error('Expected \\uXXXX sequences');
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/* -------------------------------- base32 --------------------------------- */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32EncodeBytes(bytes: Uint8Array): string {
  let bits = '';
  bytes.forEach(b => (bits += b.toString(2).padStart(8, '0')));
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  while (out.length % 8 !== 0) out += '=';
  return out;
}
function base32DecodeBytes(str: string): Uint8Array {
  const clean = str.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character: ' + ch);
    bits += idx.toString(2).padStart(5, '0');
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Uint8Array.from(out);
}

/* -------------------------------- ascii85 -------------------------------- */

function ascii85EncodeBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.slice(i, i + 4);
    const n = chunk.length;
    const padded = new Uint8Array(4);
    padded.set(chunk);
    let value = padded[0] * 256 ** 3 + padded[1] * 256 ** 2 + padded[2] * 256 + padded[3];
    if (value === 0 && n === 4) {
      out += 'z';
      continue;
    }
    const chars = new Array(5);
    for (let j = 4; j >= 0; j--) {
      chars[j] = value % 85;
      value = Math.floor(value / 85);
    }
    out += chars.map(c => String.fromCharCode(c + 33)).join('').slice(0, n + 1);
  }
  return out;
}
function ascii85DecodeBytes(str: string): Uint8Array {
  const clean = str.replace(/\s+/g, '');
  const out: number[] = [];
  let i = 0;
  while (i < clean.length) {
    if (clean[i] === 'z') {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    let group = clean.slice(i, i + 5);
    const n = group.length;
    if (n < 5) group += 'u'.repeat(5 - n);
    let value = 0;
    for (const ch of group) {
      const d = ch.charCodeAt(0) - 33;
      if (d < 0 || d > 84) throw new Error('Invalid Base85 character: ' + ch);
      value = value * 85 + d;
    }
    const b = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...b.slice(0, n - 1));
    i += n;
  }
  return Uint8Array.from(out);
}

/* --------------------------------- binary -------------------------------- */

function binaryEncodeBytes(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(2).padStart(8, '0')).join(' ');
}
function binaryDecodeBytes(str: string): Uint8Array {
  const parts = str.trim().split(/\s+/).filter(Boolean);
  const out = parts.map(p => {
    if (!/^[01]{1,8}$/.test(p)) throw new Error('Invalid binary byte: ' + p);
    return parseInt(p, 2);
  });
  return Uint8Array.from(out);
}

/* ------------------------------ html entities ----------------------------- */

function htmlEncode(str: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, c => map[c]);
}
function htmlDecode(str: string): string {
  const map: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
  return str.replace(/&(amp|lt|gt|quot|#39|apos);/g, m => map[m]);
}

/* ---------------------------------- morse --------------------------------- */

const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
  '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.',
  $: '...-..-', '@': '.--.-.',
};
const MORSE_REV: Record<string, string> = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

function morseEncode(str: string): string {
  return str
    .toUpperCase()
    .split('')
    .map(ch => {
      if (ch === ' ') return '/';
      if (MORSE[ch]) return MORSE[ch];
      throw new Error('No Morse mapping for character: ' + JSON.stringify(ch));
    })
    .join(' ');
}
function morseDecode(str: string): string {
  return str
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(code => {
      if (code === '/') return ' ';
      if (MORSE_REV[code]) return MORSE_REV[code];
      throw new Error('Invalid Morse token: ' + code);
    })
    .join('');
}

/* ------------------------------- JSON escape ------------------------------ */

function jsonEscape(str: string): string {
  return JSON.stringify(str).slice(1, -1);
}
function jsonUnescape(str: string): string {
  return JSON.parse('"' + str + '"');
}

/* ------------------------------- MD5 (RFC 1321) ---------------------------- */
/* Web Crypto has no MD5, so this is a small standalone implementation.       */
/* Verified against Node's crypto.createHash('md5') for ascii + UTF-8 input.  */

function md5(bytes: Uint8Array): string {
  function rotl(x: number, c: number) {
    return (x << c) | (x >>> (32 - c));
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

  const origLenBits = bytes.length * 8;
  let msgLen = bytes.length + 1;
  while (msgLen % 64 !== 56) msgLen++;
  const padded = new Uint8Array(msgLen + 8);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(msgLen, origLenBits >>> 0, true);
  dv.setUint32(msgLen + 4, Math.floor(origLenBits / 2 ** 32) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(chunkStart + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, s[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, a0 >>> 0, true);
  outDv.setUint32(4, b0 >>> 0, true);
  outDv.setUint32(8, c0 >>> 0, true);
  outDv.setUint32(12, d0 >>> 0, true);
  return Array.from(out).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return digestToHex(digest);
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return digestToHex(digest);
}

/* -------------------------- base64url + HMAC (JWT) ------------------------- */
/* Verified against the canonical jwt.io HS256 example token.                 */

function base64urlEncodeBytes(bytes: Uint8Array): string {
  return base64EncodeBytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecodeBytes(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return base64DecodeBytes(s);
}
async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', textToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, textToBytes(message));
  return new Uint8Array(sig);
}

/* ----------------------------- unified encode/decode ----------------------------- */

function encodeValue(source: string | Uint8Array, type: EncodingType): string {
  const bytes = source instanceof Uint8Array ? source : textToBytes(source);
  const text = source instanceof Uint8Array ? tryBytesToText(source) ?? '' : source;
  switch (type) {
    case 'base64': return base64EncodeBytes(bytes);
    case 'hex': return hexEncodeBytes(bytes);
    case 'base32': return base32EncodeBytes(bytes);
    case 'ascii85': return ascii85EncodeBytes(bytes);
    case 'binary': return binaryEncodeBytes(bytes);
    case 'url': return encodeURIComponent(text);
    case 'unicode': return unicodeEncode(text);
    case 'html': return htmlEncode(text);
    case 'rot13': return rot13(text);
    case 'morse': return morseEncode(text);
    case 'json': return jsonEscape(text);
  }
}
function decodeValue(input: string, type: EncodingType): string {
  switch (type) {
    case 'base64': return bytesToText(base64DecodeBytes(input));
    case 'hex': return bytesToText(hexDecodeBytes(input));
    case 'base32': return bytesToText(base32DecodeBytes(input));
    case 'ascii85': return bytesToText(ascii85DecodeBytes(input));
    case 'binary': return bytesToText(binaryDecodeBytes(input));
    case 'url': return decodeURIComponent(input);
    case 'unicode': return unicodeDecode(input);
    case 'html': return htmlDecode(input);
    case 'rot13': return rot13(input);
    case 'morse': return morseDecode(input);
    case 'json': return jsonUnescape(input);
  }
}

/* --------------------------------------------------------------------------- */
/*                                  Text tool                                  */
/* --------------------------------------------------------------------------- */

function TextTool({
  theme,
  initialInput,
  onResult,
}: {
  theme: AccentTheme;
  initialInput?: string;
  onResult: (e: Omit<HistoryEntry, 'id' | 'timestamp'>) => void;
}) {
  const [input, setInput] = useState(initialInput ?? 'Hello, world! 👋');
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [encType, setEncType] = useState<EncodingType>('base64');
  const [mode, setMode] = useState<Mode>('encode');
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const t = THEME_MAP[theme];

  let output = '';
  let error: string | null = null;
  try {
    output = mode === 'encode' ? encodeValue(fileBytes ?? input, encType) : decodeValue(input, encType);
  } catch (e: any) {
    error = e?.message || 'Could not process input';
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (error || !output) return;
    debounceRef.current = setTimeout(() => {
      onResult({
        tool: 'text',
        summary: `${ENCODING_LABELS[encType]} · ${mode}`,
        input: fileBytes ? `[file] ${fileName ?? 'upload'}` : input,
        output,
      });
    }, 900);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [output, error, encType, mode, input, fileBytes, fileName, onResult]);

  const handleFile = useCallback(async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    setFileBytes(buf);
    setFileName(file.name);
    setMode('encode');
    const preview = tryBytesToText(buf);
    setInput(preview ?? `[binary file: ${file.name}, ${buf.length} bytes]`);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }, [output]);

  const swap = () => {
    if (error) return;
    setFileBytes(null);
    setFileName(null);
    setInput(output);
    setMode(m => (m === 'encode' ? 'decode' : 'encode'));
  };

  const loadPreset = () => {
    setFileBytes(null);
    setFileName(null);
    setMode('encode');
    setInput(PRESETS[encType]);
  };

  return (
    <div className="flex flex-col gap-6 h-full">
      <div
        className={`flex flex-col flex-1 gap-2 rounded-xl transition-all ${dragOver ? `${t.bg} ring-2 ${t.border}` : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
      >
        <div className="flex items-center justify-between">
          <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Input</label>
          <div className="flex items-center gap-3">
            {fileName && (
              <span className={`text-xs flex items-center gap-1 ${t.text}`}>
                <UploadCloud size={12} /> {fileName}
                <button onClick={() => { setFileBytes(null); setFileName(null); }} className="text-zinc-500 hover:text-white" title="Detach file">
                  <X size={12} />
                </button>
              </span>
            )}
            <span className="text-xs text-zinc-600">{input.length} chars</span>
          </div>
        </div>
        <textarea
          value={input}
          onChange={e => { setInput(e.target.value); setFileBytes(null); setFileName(null); }}
          placeholder="Type, paste, or drop a file here…"
          className="flex-1 bg-[#111116] border border-white/10 rounded-xl p-4 text-zinc-300 font-mono text-sm resize-none outline-none focus:border-white/30"
          spellCheck={false}
          aria-label="Input text"
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center bg-white/5 rounded-lg p-1 text-xs font-bold uppercase tracking-wider">
            <button onClick={() => setMode('encode')} className={`px-3 py-1.5 rounded-md transition-all ${mode === 'encode' ? `${t.bg} ${t.text}` : 'text-zinc-500 hover:text-white'}`}>Encode</button>
            <button onClick={() => setMode('decode')} className={`px-3 py-1.5 rounded-md transition-all ${mode === 'decode' ? `${t.bg} ${t.text}` : 'text-zinc-500 hover:text-white'}`}>Decode</button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={loadPreset} className="text-xs text-zinc-400 hover:text-white flex items-center gap-1">
              <Sparkles size={12} /> Example
            </button>
            <button onClick={swap} disabled={!!error} title="Swap input/output and flip mode" className="p-2 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:hover:bg-transparent transition-all">
              <ArrowLeftRight size={16} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          {ENCODING_TYPES.map(type => (
            <button
              key={type}
              onClick={() => setEncType(type)}
              className={`px-4 py-2 rounded-lg text-xs shrink-0 font-bold uppercase tracking-wider transition-all ${
                encType === type ? `${t.bg} ${t.text} border ${t.border}` : 'bg-white/5 text-zinc-400 hover:text-white border border-transparent'
              }`}
            >
              {ENCODING_LABELS[type]}
            </button>
          ))}
        </div>
        {BYTE_TYPES.has(encType) && (
          <p className="text-[11px] text-zinc-600">Byte-safe: works on raw bytes, so dropped files encode correctly even when they aren't text.</p>
        )}
      </div>

      <div className="flex flex-col flex-1 gap-2">
        <div className="flex items-center justify-between">
          <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Output</label>
          <button onClick={handleCopy} disabled={!output || !!error} className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 disabled:opacity-30">
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className={`flex-1 bg-black border rounded-xl p-4 font-mono text-sm overflow-y-auto break-all shadow-inner ${error ? 'border-rose-500/30 text-rose-400' : `${t.border} ${t.text}`}`}>
          {error ? `⚠ ${error}` : output || <span className="text-zinc-700">—</span>}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/*                                  Hash tool                                  */
/* --------------------------------------------------------------------------- */

function HashTool({
  theme,
  initialInput,
  onResult,
}: {
  theme: AccentTheme;
  initialInput?: string;
  onResult: (e: Omit<HistoryEntry, 'id' | 'timestamp'>) => void;
}) {
  const [input, setInput] = useState(initialInput ?? 'The quick brown fox jumps over the lazy dog');
  const [hashes, setHashes] = useState<Record<HashAlgo, string>>({ MD5: '', 'SHA-1': '', 'SHA-256': '' });
  const [copiedAlgo, setCopiedAlgo] = useState<HashAlgo | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const t = THEME_MAP[theme];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bytes = textToBytes(input);
      const md5Hex = md5(bytes);
      const [sha1, sha256] = await Promise.all([sha1Hex(bytes), sha256Hex(bytes)]);
      if (!cancelled) setHashes({ MD5: md5Hex, 'SHA-1': sha1, 'SHA-256': sha256 });
    })();
    return () => { cancelled = true; };
  }, [input]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!hashes.MD5) return;
    debounceRef.current = setTimeout(() => {
      onResult({
        tool: 'hash',
        summary: 'MD5 / SHA-1 / SHA-256',
        input,
        output: `${hashes.MD5} · ${hashes['SHA-1']} · ${hashes['SHA-256']}`,
      });
    }, 900);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [hashes, input, onResult]);

  const copy = async (algo: HashAlgo) => {
    try {
      await navigator.clipboard.writeText(hashes[algo]);
      setCopiedAlgo(algo);
      setTimeout(() => setCopiedAlgo(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex flex-col flex-1 gap-2">
        <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Input</label>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          className="flex-1 bg-[#111116] border border-white/10 rounded-xl p-4 text-zinc-300 font-mono text-sm resize-none outline-none focus:border-white/30"
          spellCheck={false}
          aria-label="Input text"
        />
      </div>
      <div className="flex flex-col gap-3">
        {(['MD5', 'SHA-1', 'SHA-256'] as HashAlgo[]).map(algo => (
          <div key={algo} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-widest font-bold text-zinc-500 flex items-center gap-2">
                <HashIcon size={12} /> {algo}
              </span>
              <button onClick={() => copy(algo)} className="text-xs text-zinc-400 hover:text-white flex items-center gap-1">
                {copiedAlgo === algo ? <Check size={12} /> : <Copy size={12} />} {copiedAlgo === algo ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className={`bg-black border rounded-xl p-3 font-mono text-sm break-all ${t.border} ${t.text}`}>
              {hashes[algo] || <span className="text-zinc-700">—</span>}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-zinc-600 leading-relaxed">
        MD5 and SHA-1 are broken for collision resistance — fine for checksums or cache keys, not for passwords, signatures, or anything security-sensitive. Prefer SHA-256+ generally, and a dedicated password hash (bcrypt, scrypt, or Argon2) for credentials specifically.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/*                                  JWT tool                                   */
/* --------------------------------------------------------------------------- */

function JwtTool({ theme }: { theme: AccentTheme }) {
  const [mode, setMode] = useState<Mode>('decode');
  const [token, setToken] = useState(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  );
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [verifyState, setVerifyState] = useState<'idle' | 'valid' | 'invalid' | 'unsupported' | 'error'>('idle');

  const [payloadJson, setPayloadJson] = useState('{\n  "sub": "1234567890",\n  "name": "John Doe"\n}');
  const [encodeSecret, setEncodeSecret] = useState('');
  const [builtToken, setBuiltToken] = useState('');
  const [buildError, setBuildError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const t = THEME_MAP[theme];

  let header: any = null;
  let payload: any = null;
  let decodeError: string | null = null;
  const parts = token.trim().split('.');
  if (mode === 'decode') {
    try {
      if (parts.length !== 3) throw new Error('A JWT needs 3 dot-separated parts (header.payload.signature)');
      header = JSON.parse(bytesToText(base64urlDecodeBytes(parts[0])));
      payload = JSON.parse(bytesToText(base64urlDecodeBytes(parts[1])));
    } catch (e: any) {
      decodeError = e?.message || 'Could not parse token';
    }
  }

  useEffect(() => {
    if (mode !== 'decode' || decodeError) { setVerifyState('idle'); return; }
    if (!secret) { setVerifyState('idle'); return; }
    if (header?.alg !== 'HS256') { setVerifyState('unsupported'); return; }
    let cancelled = false;
    (async () => {
      try {
        const signingInput = parts[0] + '.' + parts[1];
        const expected = base64urlEncodeBytes(await hmacSha256(secret, signingInput));
        if (!cancelled) setVerifyState(expected === parts[2] ? 'valid' : 'invalid');
      } catch {
        if (!cancelled) setVerifyState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token, secret, mode, decodeError, header?.alg]);

  const buildToken = useCallback(async () => {
    setBuildError(null);
    setBuiltToken('');
    try {
      const payloadObj = JSON.parse(payloadJson);
      if (!encodeSecret) { setBuildError('Enter a secret to sign the token'); return; }
      const headerObj = { alg: 'HS256', typ: 'JWT' };
      const h = base64urlEncodeBytes(textToBytes(JSON.stringify(headerObj)));
      const p = base64urlEncodeBytes(textToBytes(JSON.stringify(payloadObj)));
      const signingInput = h + '.' + p;
      const sig = base64urlEncodeBytes(await hmacSha256(encodeSecret, signingInput));
      setBuiltToken(signingInput + '.' + sig);
    } catch (e: any) {
      setBuildError(e?.message || 'Invalid JSON payload');
    }
  }, [payloadJson, encodeSecret]);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center bg-white/5 rounded-lg p-1 text-xs font-bold uppercase tracking-wider">
          <button onClick={() => setMode('decode')} className={`px-3 py-1.5 rounded-md transition-all ${mode === 'decode' ? `${t.bg} ${t.text}` : 'text-zinc-500 hover:text-white'}`}>Decode</button>
          <button onClick={() => setMode('encode')} className={`px-3 py-1.5 rounded-md transition-all ${mode === 'encode' ? `${t.bg} ${t.text}` : 'text-zinc-500 hover:text-white'}`}>Build &amp; sign</button>
        </div>
        <span className="text-xs text-zinc-600 flex items-center gap-1">
          <KeyRound size={12} /> HS256 only
        </span>
      </div>

      {mode === 'decode' ? (
        <div className="flex flex-col gap-4 flex-1 min-h-0">
          <div className="flex flex-col gap-2">
            <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Token</label>
            <textarea
              value={token}
              onChange={e => setToken(e.target.value)}
              rows={3}
              className="bg-[#111116] border border-white/10 rounded-xl p-4 text-zinc-300 font-mono text-xs resize-none outline-none focus:border-white/30 break-all"
              spellCheck={false}
            />
          </div>

          {decodeError ? (
            <div className="border border-rose-500/30 text-rose-400 rounded-xl p-4 text-sm font-mono">⚠ {decodeError}</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2 min-h-0">
                <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Header</label>
                <pre className={`bg-black border rounded-xl p-3 font-mono text-xs overflow-auto ${t.border} ${t.text}`}>{JSON.stringify(header, null, 2)}</pre>
              </div>
              <div className="flex flex-col gap-2 min-h-0">
                <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Payload</label>
                <pre className={`bg-black border rounded-xl p-3 font-mono text-xs overflow-auto ${t.border} ${t.text}`}>{JSON.stringify(payload, null, 2)}</pre>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Verify signature (optional)</label>
            <div className="flex gap-2">
              <input
                type={showSecret ? 'text' : 'password'}
                value={secret}
                onChange={e => setSecret(e.target.value)}
                placeholder="Paste the signing secret to verify…"
                className="flex-1 bg-[#111116] border border-white/10 rounded-xl px-4 py-2.5 text-zinc-300 font-mono text-sm outline-none focus:border-white/30"
              />
              <button onClick={() => setShowSecret(s => !s)} className="px-3 rounded-xl border border-white/10 text-xs text-zinc-400 hover:text-white">
                {showSecret ? 'Hide' : 'Show'}
              </button>
            </div>
            {verifyState === 'valid' && <span className="text-xs text-emerald-400 flex items-center gap-1"><ShieldCheck size={14} /> Signature valid</span>}
            {verifyState === 'invalid' && <span className="text-xs text-rose-400 flex items-center gap-1"><ShieldX size={14} /> Signature does not match</span>}
            {verifyState === 'unsupported' && <span className="text-xs text-amber-400">Verification only supports HS256 (this token uses {header?.alg ?? 'unknown'}).</span>}
            {verifyState === 'error' && <span className="text-xs text-rose-400">Could not verify — check the secret.</span>}
          </div>
          <p className="text-xs text-zinc-600 leading-relaxed">
            Decoding just reads the header and payload — anyone can do that without the secret. A JWT is signed, not encrypted, so treat its contents as visible to anyone who has the token.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 flex-1 min-h-0">
          <div className="flex flex-col flex-1 gap-2 min-h-0">
            <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Payload (JSON)</label>
            <textarea
              value={payloadJson}
              onChange={e => setPayloadJson(e.target.value)}
              className="flex-1 bg-[#111116] border border-white/10 rounded-xl p-4 text-zinc-300 font-mono text-sm resize-none outline-none focus:border-white/30"
              spellCheck={false}
            />
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={encodeSecret}
              onChange={e => setEncodeSecret(e.target.value)}
              placeholder="Signing secret"
              className="flex-1 bg-[#111116] border border-white/10 rounded-xl px-4 py-2.5 text-zinc-300 font-mono text-sm outline-none focus:border-white/30"
            />
            <button onClick={buildToken} className={`px-4 rounded-xl text-xs font-bold uppercase tracking-wider ${t.bg} ${t.text} border ${t.border}`}>
              Sign
            </button>
          </div>
          {buildError && <div className="text-xs text-rose-400">⚠ {buildError}</div>}
          {builtToken && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="text-xs uppercase tracking-widest font-bold text-zinc-500">Signed token</label>
                <button onClick={() => handleCopy(builtToken)} className="text-xs text-zinc-400 hover:text-white flex items-center gap-1">
                  {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className={`bg-black border rounded-xl p-3 font-mono text-xs break-all ${t.border} ${t.text}`}>{builtToken}</div>
            </div>
          )}
          <p className="text-xs text-zinc-600 leading-relaxed">
            Runs entirely in your browser — the secret and token never leave this component, and this tab is intentionally excluded from history so secrets are never persisted, even in memory.
          </p>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/*                                History panel                                */
/* --------------------------------------------------------------------------- */

function HistoryPanel({
  theme,
  history,
  onRestore,
  onClear,
  onClose,
}: {
  theme: AccentTheme;
  history: HistoryEntry[];
  onRestore: (entry: HistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const t = THEME_MAP[theme];
  return (
    <div className="absolute inset-y-0 right-0 w-full sm:w-80 bg-[#0d0d10] border-l border-white/10 p-4 flex flex-col gap-3 z-10 shadow-2xl">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest font-bold text-zinc-500 flex items-center gap-2">
          <HistoryIcon size={14} /> History
        </span>
        <div className="flex items-center gap-3">
          <button onClick={onClear} className="text-zinc-500 hover:text-white" title="Clear history">
            <Trash2 size={14} />
          </button>
          <button onClick={onClose} className="text-zinc-500 hover:text-white" title="Close">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {history.length === 0 && <p className="text-xs text-zinc-600">Conversions from the Text and Hash tools will show up here as you go. JWT secrets are never recorded.</p>}
        {history.map(h => (
          <button key={h.id} onClick={() => onRestore(h)} className="text-left bg-white/5 hover:bg-white/10 rounded-lg p-3 transition-all">
            <div className={`text-[10px] uppercase tracking-wider font-bold ${t.text}`}>{h.summary}</div>
            <div className="text-xs text-zinc-400 truncate mt-1">{h.input}</div>
            <div className="text-xs text-zinc-600 truncate">{h.output}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/*                                 Main export                                 */
/* --------------------------------------------------------------------------- */

export const PayloadMutator = ({ theme }: { theme: AccentTheme }) => {
  const [tool, setTool] = useState<Tool>('text');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [restoreNonce, setRestoreNonce] = useState<Record<HistoryTool, number>>({ text: 0, hash: 0 });
  const [restoreSeed, setRestoreSeed] = useState<Record<HistoryTool, string | undefined>>({ text: undefined, hash: undefined });
  const t = THEME_MAP[theme];

  const pushHistory = useCallback((entry: Omit<HistoryEntry, 'id' | 'timestamp'>) => {
    setHistory(prev => {
      const last = prev[0];
      if (last && last.tool === entry.tool && last.summary === entry.summary && last.input === entry.input && last.output === entry.output) return prev;
      const next: HistoryEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now() };
      return [next, ...prev].slice(0, 25);
    });
  }, []);

  const restore = (h: HistoryEntry) => {
    setTool(h.tool);
    setRestoreSeed(prev => ({ ...prev, [h.tool]: h.input.startsWith('[file]') ? '' : h.input }));
    setRestoreNonce(prev => ({ ...prev, [h.tool]: prev[h.tool] + 1 }));
    setShowHistory(false);
  };

  return (
    <div className="flex-1 w-full h-full p-6 flex flex-col font-sans bg-[#0a0a0c]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Zap className={`size-6 ${t.text}`} />
          <h2 className="text-2xl font-medium text-white tracking-tight">Encoding Studio</h2>
        </div>
        <button
          onClick={() => setShowHistory(s => !s)}
          className={`flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider px-3 py-2 rounded-lg transition-all ${
            showHistory ? `${t.bg} ${t.text}` : 'text-zinc-400 hover:text-white hover:bg-white/5'
          }`}
        >
          <HistoryIcon size={14} /> History
          {history.length > 0 && <span className="ml-1 text-[10px] bg-white/10 rounded-full px-1.5 py-0.5">{history.length}</span>}
        </button>
      </div>

      <div className="flex items-center gap-2 mb-6 border-b border-white/10">
        <button
          onClick={() => setTool('text')}
          className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wider border-b-2 -mb-px transition-all ${
            tool === 'text' ? `${t.text} border-current` : 'text-zinc-500 border-transparent hover:text-white'
          }`}
        >
          Text
        </button>
        <button
          onClick={() => setTool('hash')}
          className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wider border-b-2 -mb-px transition-all flex items-center gap-1.5 ${
            tool === 'hash' ? `${t.text} border-current` : 'text-zinc-500 border-transparent hover:text-white'
          }`}
        >
          <HashIcon size={12} /> Hash
        </button>
        <button
          onClick={() => setTool('jwt')}
          className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wider border-b-2 -mb-px transition-all flex items-center gap-1.5 ${
            tool === 'jwt' ? `${t.text} border-current` : 'text-zinc-500 border-transparent hover:text-white'
          }`}
        >
          <KeyRound size={12} /> JWT
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className={tool === 'text' ? 'h-full' : 'hidden'}>
          <TextTool key={`text-${restoreNonce.text}`} theme={theme} initialInput={restoreSeed.text} onResult={pushHistory} />
        </div>
        <div className={tool === 'hash' ? 'h-full' : 'hidden'}>
          <HashTool key={`hash-${restoreNonce.hash}`} theme={theme} initialInput={restoreSeed.hash} onResult={pushHistory} />
        </div>
        <div className={tool === 'jwt' ? 'h-full' : 'hidden'}>
          <JwtTool theme={theme} />
        </div>

        {showHistory && (
          <HistoryPanel theme={theme} history={history} onClose={() => setShowHistory(false)} onClear={() => setHistory([])} onRestore={restore} />
        )}
      </div>
    </div>
  );
};