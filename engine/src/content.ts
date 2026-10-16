// Minimal PDF content-stream tokenizer + operator grouper.
// Every token/op carries byte ranges into the decoded content bytes so the
// replacer can do precise byte surgery instead of re-serializing the stream
// (re-serialization would risk corrupting operators we do not model).

export type Token = {
  kind: 'number' | 'name' | 'string' | 'arrayStart' | 'arrayEnd' |
        'dictStart' | 'dictEnd' | 'bool' | 'null' | 'op';
  start: number;
  end: number;
  num?: number;
  name?: string;
  bytes?: Uint8Array; // decoded bytes for string tokens (literal or hex)
  op?: string;
};

export interface Op {
  operator: string;
  operands: Token[];
  start: number; // first operand start (or operator start when no operands)
  end: number;   // operator end
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isDelimOrWs(b: number) { return WS.has(b) || DELIM.has(b); }

export function tokenize(data: Uint8Array): Token[] {
  const tokens: Token[] = [];
  const n = data.length;
  let i = 0;
  const text = (a: number, b: number) => {
    let s = '';
    for (let k = a; k < b; k++) s += String.fromCharCode(data[k]);
    return s;
  };
  while (i < n) {
    const b = data[i];
    if (WS.has(b)) { i++; continue; }
    if (b === 0x25) { // comment
      while (i < n && data[i] !== 10 && data[i] !== 13) i++;
      continue;
    }
    if (b === 0x28) { // literal string
      const start = i; i++;
      const out: number[] = [];
      let depth = 1;
      while (i < n && depth > 0) {
        const c = data[i];
        if (c === 0x5c) { // backslash
          const d = data[i + 1];
          if (d === 0x6e) { out.push(10); i += 2; }
          else if (d === 0x72) { out.push(13); i += 2; }
          else if (d === 0x74) { out.push(9); i += 2; }
          else if (d === 0x62) { out.push(8); i += 2; }
          else if (d === 0x66) { out.push(12); i += 2; }
          else if (d === 0x28 || d === 0x29 || d === 0x5c) { out.push(d); i += 2; }
          else if (d >= 0x30 && d <= 0x37) {
            let v = 0, cnt = 0, j = i + 1;
            while (cnt < 3 && data[j] >= 0x30 && data[j] <= 0x37) { v = v * 8 + (data[j] - 0x30); j++; cnt++; }
            out.push(v & 0xff); i = j;
          }
          else if (d === 10) { i += 2; }
          else if (d === 13) { i += 2; if (data[i] === 10) i++; }
          else { out.push(d); i += 2; }
          continue;
        }
        if (c === 0x28) { depth++; out.push(c); i++; continue; }
        if (c === 0x29) { depth--; if (depth > 0) out.push(c); i++; continue; }
        out.push(c); i++;
      }
      tokens.push({ kind: 'string', start, end: i, bytes: new Uint8Array(out) });
      continue;
    }
    if (b === 0x3c && data[i + 1] === 0x3c) { tokens.push({ kind: 'dictStart', start: i, end: i + 2 }); i += 2; continue; }
    if (b === 0x3e && data[i + 1] === 0x3e) { tokens.push({ kind: 'dictEnd', start: i, end: i + 2 }); i += 2; continue; }
    if (b === 0x3c) { // hex string
      const start = i; i++;
      let hex = '';
      while (i < n && data[i] !== 0x3e) { if (!WS.has(data[i])) hex += String.fromCharCode(data[i]); i++; }
      i++; // consume >
      if (hex.length % 2 === 1) hex += '0';
      const bytes = new Uint8Array(hex.length / 2);
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
      tokens.push({ kind: 'string', start, end: i, bytes });
      continue;
    }
    if (b === 0x5b) { tokens.push({ kind: 'arrayStart', start: i, end: i + 1 }); i++; continue; }
    if (b === 0x5d) { tokens.push({ kind: 'arrayEnd', start: i, end: i + 1 }); i++; continue; }
    if (b === 0x2f) { // name
      const start = i; i++;
      while (i < n && !isDelimOrWs(data[i])) i++;
      tokens.push({ kind: 'name', start, end: i, name: text(start + 1, i) });
      continue;
    }
    // regular token: number / keyword / operator
    const start = i;
    while (i < n && !isDelimOrWs(data[i])) i++;
    const word = text(start, i);
    if (word === 'true' || word === 'false') tokens.push({ kind: 'bool', start, end: i });
    else if (word === 'null') tokens.push({ kind: 'null', start, end: i });
    else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ kind: 'number', start, end: i, num: parseFloat(word) });
    else tokens.push({ kind: 'op', start, end: i, op: word });
  }
  return tokens;
}

export function groupOps(tokens: Token[]): Op[] {
  const ops: Op[] = [];
  let operands: Token[] = [];
  for (const t of tokens) {
    if (t.kind === 'op') {
      ops.push({
        operator: t.op!,
        operands,
        start: operands.length ? operands[0].start : t.start,
        end: t.end,
      });
      operands = [];
    } else {
      operands.push(t);
    }
  }
  return ops;
}
