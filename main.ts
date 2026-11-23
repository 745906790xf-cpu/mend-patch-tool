// mend: one patch tool for every AI edit format, per SPEC.md (version 1).
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 3: file lines ----

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- Section 5: matching lines ----

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** All positions where O occurs in fileLines at the given tier (occurrences may overlap). */
function occurrences(fileLines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > fileLines.length) return out;
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(fileLines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions; null when it occurs at no tier. */
function findTier(fileLines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(fileLines, O, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of N: a context line (index into O) or a new line of text. */
type NLine = { ctx: number } | { text: string };

/** Write N in place of the O lines matched at pos, per section 5's context and re-indent rules. */
function writeN(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = leadWS(fileLines[pos]!);
  const P = leadWS(O[0]!);
  return N.map((n) => {
    if ('ctx' in n) return fileLines[pos + n.ctx]!;
    let t = n.text;
    if (tier === 2 && t !== '' && trimBoth(t) !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    return t;
  });
}

/** Replace O (found by the caller at pos/tier) with N in a copy of fileLines. */
function replaceAt(fileLines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const written = writeN(fileLines, pos, O, N, tier);
  return [...fileLines.slice(0, pos), ...written, ...fileLines.slice(pos + O.length)];
}

// ---- Section 9: JSON edits ----

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----

interface UHunk {
  a: number; // the -A start
  O: string[];
  N: NLine[];
  plus: string[]; // the + lines alone (for creations)
  backslashAfterLastCtxPlus: boolean;
  backslashAfterLastPlus: boolean;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined; // undefined: no ---/+++ pair; null: /dev/null
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  const isPair = (k: number): boolean => (lines[k] ?? '').startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, pairOld: undefined, pairNew: undefined, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (isPair(i)) {
        if (cur === null || cur.hunks.length > 0 || cur.pairOld !== undefined) {
          cur = { gitOld: null, gitNew: null, pairOld: undefined, pairNew: undefined, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
          sections.push(cur);
        }
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || isPair(j)) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const O: string[] = [];
      const N: NLine[] = [];
      const plus: string[] = [];
      let lastCtxPlus = -1;
      let lastPlus = -1;
      body.forEach((b, k) => {
        if (b === '' || b[0] === ' ') {
          const text = b === '' ? '' : b.slice(1);
          N.push({ ctx: O.length });
          O.push(text);
          lastCtxPlus = k;
        } else if (b[0] === '-') {
          O.push(b.slice(1));
        } else if (b[0] === '+') {
          const text = b.slice(1);
          N.push({ text });
          plus.push(text);
          lastCtxPlus = k;
          lastPlus = k;
        }
      });
      cur.hunks.push({
        a: Number(m[1]),
        O,
        N,
        plus,
        backslashAfterLastCtxPlus: lastCtxPlus >= 0 && (body[lastCtxPlus + 1] ?? '').startsWith('\\'),
        backslashAfterLastPlus: lastPlus >= 0 && (body[lastPlus + 1] ?? '').startsWith('\\'),
      });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : (s.renameFrom ?? s.gitOld);
  const newPath = s.pairNew !== undefined ? s.pairNew : (s.renameTo ?? s.gitNew);
  const creation = oldPath === null || s.newFile;
  const deletion = newPath === null || s.deletedFile;
  return (tree) => {
    if (creation && newPath !== null) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const created: string[] = [];
      let noBreak = false;
      for (const h of s.hunks) {
        created.push(...h.plus);
        if (h.plus.length > 0) noBreak = h.backslashAfterLastPlus;
      }
      tree.now.set(newPath, created.length === 0 ? '' : created.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (deletion && oldPath !== null) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) return; // degenerate: /dev/null on both sides
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (!safe(newPath)) throw new Fail('unsafe', newPath);
    const move = oldPath !== newPath;
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      if (h.O.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const written = h.N.map((n) => ('text' in n ? n.text : ''));
        f.lines.splice(at, 0, ...written);
        if (at + written.length === f.lines.length) f.final = !h.backslashAfterLastCtxPlus;
      } else {
        const found = findTier(f.lines, h.O, strict);
        if (found === null) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        }
        const atEnd = pos + h.O.length === f.lines.length;
        f.lines = replaceAt(f.lines, pos, h.O, h.N, found.tier);
        if (atEnd) f.final = !h.backslashAfterLastCtxPlus;
      }
      d += h.N.length - h.O.length;
    }
    const out = joinFile(f);
    if (move) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  const marker = (k: number, text: string): boolean => (lines[k] ?? '').trimEnd() === text;
  while (i < lines.length) {
    if (!marker(i, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= scanFrom; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (marker(k, '=======')) {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k++) {
        if (marker(k, '>>>>>>> REPLACE')) {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      f.lines = replaceAt(f.lines, found.positions[0]!, oldLines, newLines.map((t) => ({ text: t })), found.tier);
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    scanFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  O: string[];
  N: NLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const raw: Array<{ text: string; no: number }> = [];
    i += 1;
    while (i < last && sectionStart(lines[i]!) === null) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text === '') content.push('');
        else if (r.text[0] === '+') content.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        at = 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      for (; at < raw.length; at++) {
        const r = raw[at]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, O: [], N: [], eof: false };
          chunks.push(chunk);
        } else if (t.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.no}`);
          chunk.eof = true;
          chunk = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            chunk = { anchor: null, O: [], N: [], eof: false };
            chunks.push(chunk);
          }
          if (t === '' || t[0] === ' ') {
            const text = t === '' ? '' : t.slice(1);
            chunk.N.push({ ctx: chunk.O.length });
            chunk.O.push(text);
          } else if (t[0] === '-') {
            chunk.O.push(t.slice(1));
          } else {
            chunk.N.push({ text: t.slice(1) });
          }
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(before);
        let cursor = 0;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let foundAt = -1;
            for (const t of tiers) {
              for (let k = cursor; k < f.lines.length; k++) {
                if (lineEq(f.lines[k]!, ch.anchor, t)) {
                  foundAt = k;
                  break;
                }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', path);
            cursor = foundAt + 1;
          }
          if (ch.O.length === 0) {
            const atPos = ch.eof ? f.lines.length : cursor;
            const written = ch.N.map((n) => ('text' in n ? n.text : ''));
            f.lines.splice(atPos, 0, ...written);
            cursor = atPos + written.length;
          } else {
            let pos = -1;
            let tier = 0;
            for (const t of tiers) {
              const positions = occurrences(f.lines, ch.O, t).filter((p) => p >= cursor && (!ch.eof || p + ch.O.length === f.lines.length));
              if (positions.length > 0) {
                pos = positions[0]!;
                tier = t;
                break;
              }
            }
            if (pos < 0) throw new Fail('no-match', path);
            f.lines = replaceAt(f.lines, pos, ch.O, ch.N, tier);
            cursor = pos + ch.N.length;
          }
        }
        const out = joinFile(f);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
    }
  }
  return edits;
}

// ---- Sections 1, 2, 10: invocation, output, atomicity ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const changed = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const rows: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null && tree.now.get(newP) !== undefined) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const [p, line] of changed) {
    if (!consumed.has(p)) rows.push({ key: p, line });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
