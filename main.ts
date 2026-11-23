// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

// ---- file line model (SPEC §3) ----

interface Parts {
  br: string;
  lines: string[];
  final: boolean;
}

function fileParts(text: string): Parts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function fileText(p: Parts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

// ---- SPEC §5 matching tiers ----

const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

const trail = (s: string): string => s.replace(/[ \t]+$/, '');

function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trail(s);
  return trail(s).replace(/^[ \t]+/, '');
}

function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (norm(lines[i + k], tier) !== norm(old[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, then 1, then 2; strict allows only 0) with an occurrence
// at or after `from`; -1 when there is none.
function findTier(lines: string[], old: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrences(lines, old, t, from).length > 0) return t;
  }
  return -1;
}

interface MLine {
  text: string;
  ctx: boolean;
}

// Build the replacement lines for an occurrence at `pos`.
// Context lines are taken from the file itself; at tier 2 the non-context
// new lines are re-indented from O's first line to the file's first matched line.
function buildReplacement(fileLines: string[], pos: number, O: MLine[], N: MLine[], tier: number): string[] {
  const oCtx: number[] = [];
  const nCtx: number[] = [];
  O.forEach((l, i) => {
    if (l.ctx) oCtx.push(i);
  });
  N.forEach((l, i) => {
    if (l.ctx) nCtx.push(i);
  });
  const F = lead(fileLines[pos]);
  const P = lead(O[0].text);
  const out: string[] = [];
  for (let j = 0; j < N.length; j++) {
    const nl = N[j];
    if (nl.ctx) {
      out.push(fileLines[pos + oCtx[nCtx.indexOf(j)]]);
    } else if (tier === 2) {
      const t = nl.text;
      if (t === '' || /^[ \t]+$/.test(t) || !t.startsWith(P)) out.push(t);
      else out.push(F + t.slice(P.length));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// ---- SPEC §6 unified diff ----

interface Hunk {
  A: number;
  O: MLine[];
  N: MLine[];
  noEol: boolean; // backslash after the hunk's last context-or-+ line
  noEolPlus: boolean; // backslash after the hunk's last + line
}

function applyHunk(parts: Parts, hunk: Hunk, d: number, strict: boolean, path: string): Parts {
  if (hunk.O.length === 0) {
    const idx = Math.max(0, Math.min(hunk.A + d, parts.lines.length));
    const ins = hunk.N.map((l) => l.text);
    const lines = [...parts.lines.slice(0, idx), ...ins, ...parts.lines.slice(idx)];
    let fin = parts.final;
    if (idx === parts.lines.length && ins.length > 0) fin = !hunk.noEol;
    return { br: parts.br, lines, final: fin };
  }
  const oTexts = hunk.O.map((l) => l.text);
  const tier = findTier(parts.lines, oTexts, 0, strict);
  if (tier < 0) throw new Fail('no-match', path);
  const occ = occurrences(parts.lines, oTexts, tier, 0);
  const target = hunk.A - 1 + d;
  let pos = occ[0];
  let best = Math.abs(pos - target);
  for (const q of occ) {
    const dd = Math.abs(q - target);
    if (dd < best) {
      best = dd;
      pos = q;
    }
  }
  const rep = buildReplacement(parts.lines, pos, hunk.O, hunk.N, tier);
  const lines = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + hunk.O.length)];
  let fin = parts.final;
  if (pos + hunk.O.length === parts.lines.length) {
    if (hunk.N.length === 0) fin = pos > 0;
    else fin = !hunk.noEol;
  }
  return { br: parts.br, lines, final: fin };
}

const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const diffGitRe = /^diff --git a\/(.+?) b\/(.+?)\s*$/;

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  return line.slice(4).split('\t')[0].trim();
}

interface RawSection {
  diffA: string | undefined;
  diffB: string | undefined;
  dashOld: string | null | undefined; // null = /dev/null
  dashNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function unifiedEdits(lines: string[], moves: Array<[string, string]>, strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = diffGitRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffA: m[1], diffB: m[2], dashOld: undefined, dashNew: undefined, renameFrom: undefined, renameTo: undefined, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const o = headerPath(l);
      const n = headerPath(lines[i + 1]);
      if (cur !== null && inHeader) {
        cur.dashOld = o === '/dev/null' ? null : stripPrefix(o);
        cur.dashNew = n === '/dev/null' ? null : stripPrefix(n);
      } else {
        cur = { diffA: undefined, diffB: undefined, dashOld: o === '/dev/null' ? null : stripPrefix(o), dashNew: n === '/dev/null' ? null : stripPrefix(n), renameFrom: undefined, renameTo: undefined, create: false, del: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur !== null && inHeader && l.startsWith('+++ ')) {
      const n = headerPath(l);
      cur.dashNew = n === '/dev/null' ? null : stripPrefix(n);
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('rename from ')) {
      cur.renameFrom = l.slice(12).trim();
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('rename to ')) {
      cur.renameTo = l.slice(10).trim();
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('new file mode')) {
      cur.create = true;
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('deleted file mode')) {
      cur.del = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(b);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const O: MLine[] = [];
      const N: MLine[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k];
        if (bl.startsWith('\\')) continue;
        if (bl === '' || bl.startsWith(' ')) {
          const t = bl === '' ? '' : bl.slice(1);
          O.push({ text: t, ctx: true });
          N.push({ text: t, ctx: true });
        } else if (bl.startsWith('-')) {
          O.push({ text: bl.slice(1), ctx: false });
        } else if (bl.startsWith('+')) {
          N.push({ text: bl.slice(1), ctx: false });
        }
      }
      let lastCP = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        if (body[k] === '' || body[k].startsWith(' ') || body[k].startsWith('+')) lastCP = k;
        if (body[k].startsWith('+')) lastPlus = k;
      }
      const noEol = lastCP >= 0 && body[lastCP + 1] !== undefined && body[lastCP + 1].startsWith('\\');
      const noEolPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1].startsWith('\\');
      cur.hunks.push({ A: parseInt(m[1], 10), O, N, noEol, noEolPlus });
      i = j;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldRaw = s.dashOld !== undefined ? s.dashOld : s.renameFrom !== undefined ? s.renameFrom : s.diffA;
    const newRaw = s.dashNew !== undefined ? s.dashNew : s.renameTo !== undefined ? s.renameTo : s.diffB;
    const isCreate = oldRaw === null || s.create;
    const isDelete = newRaw === null || s.del;
    if (isCreate) {
      const target = newRaw === null || newRaw === undefined ? '/dev/null' : newRaw;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const plus: string[] = [];
        for (const h of s.hunks) for (const l of h.N) if (!l.ctx) plus.push(l.text);
        let noEol = false;
        for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          if (s.hunks[hi].N.some((l) => !l.ctx)) {
            noEol = s.hunks[hi].noEolPlus;
            break;
          }
        }
        tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      });
      continue;
    }
    if (isDelete) {
      const target = oldRaw === null || oldRaw === undefined ? '/dev/null' : oldRaw;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
      continue;
    }
    const oldP = oldRaw === null || oldRaw === undefined ? '' : oldRaw;
    const newP = newRaw === null || newRaw === undefined ? '' : newRaw;
    if (oldP !== newP) {
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const text = tree.get(oldP);
        if (text === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        let parts = fileParts(text);
        let d = 0;
        for (const h of s.hunks) {
          parts = applyHunk(parts, h, d, strict, oldP);
          d += h.N.length - h.O.length;
        }
        tree.now.set(newP, fileText(parts));
        tree.now.set(oldP, null);
        moves.push([oldP, newP]);
      });
      continue;
    }
    edits.push((tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      let parts = fileParts(text);
      let d = 0;
      for (const h of s.hunks) {
        parts = applyHunk(parts, h, d, strict, oldP);
        d += h.N.length - h.O.length;
      }
      tree.now.set(oldP, fileText(parts));
    });
  }
  return edits;
}

// ---- SPEC §7 SEARCH/REPLACE ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let curPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let k = i - 1; k > prevEnd; k--) {
        const t = lines[k].trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = curPath;
      if (path === null) throw new Exit2(`error: parse ${i + 1}`);
      let sep = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trimEnd() === '=======') {
          sep = k;
          break;
        }
      }
      if (sep === -1) throw new Exit2(`error: parse ${i + 1}`);
      let end = -1;
      for (let k = sep + 1; k < lines.length; k++) {
        if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
      if (end === -1) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
      curPath = path;
      prevEnd = end;
      i = end + 1;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const b of blocks) {
    edits.push((tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(b.path);
      if (text === null) throw new Fail('missing', b.path);
      const parts = fileParts(text);
      const tier = findTier(parts.lines, b.oldLines, 0, strict);
      if (tier < 0) throw new Fail('no-match', b.path);
      const occ = occurrences(parts.lines, b.oldLines, tier, 0);
      if (occ.length !== 1) throw new Fail('ambiguous', b.path);
      const pos = occ[0];
      const O: MLine[] = b.oldLines.map((t) => ({ text: t, ctx: false }));
      const N: MLine[] = b.newLines.map((t) => ({ text: t, ctx: false }));
      const rep = buildReplacement(parts.lines, pos, O, N, tier);
      const out = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + b.oldLines.length)];
      tree.now.set(b.path, fileText({ br: parts.br, lines: out, final: parts.final }));
    });
  }
  return edits;
}

// ---- SPEC §8 V4A ----

function findSingleLine(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i], t) === norm(anchor, t)) return i;
    }
  }
  return -1;
}

const v4aSectionStart = (t: string): boolean =>
  t.startsWith('*** Add File:') || t.startsWith('*** Delete File:') || t.startsWith('*** Update File:') || t === '*** End Patch';

function v4aEdits(lines: string[], moves: Array<[string, string]>, strict: boolean): Edit[] {
  let first = -1;
  let last = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!blank(lines[k])) {
      if (first === -1) first = k;
      last = k;
    }
  }
  if (first === -1) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Chunk {
    anchor: string | null;
    O: MLine[];
    N: MLine[];
    eof: boolean;
  }
  interface Section {
    kind: 'add' | 'delete' | 'update';
    path: string;
    moveTo: string | null;
    content: string[];
    chunks: Chunk[];
    lineNo: number;
  }
  const sections: Section[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    const t = l.trim();
    if (t === '') {
      i++;
      continue;
    }
    if (t.startsWith('*** Add File:')) {
      const path = t.slice('*** Add File:'.length).trim();
      const raw: string[] = [];
      const rawStart = i + 1;
      let j = i + 1;
      while (j < last) {
        if (v4aSectionStart(lines[j].trim())) break;
        raw.push(lines[j]);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1])) raw.pop();
      const content: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const b = raw[k];
        if (b === '') content.push('');
        else if (b.startsWith('+')) content.push(b.slice(1));
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      sections.push({ kind: 'add', path, moveTo: null, content, chunks: [], lineNo: i + 1 });
      i = j;
      continue;
    }
    if (t.startsWith('*** Delete File:')) {
      const path = t.slice('*** Delete File:'.length).trim();
      sections.push({ kind: 'delete', path, moveTo: null, content: [], chunks: [], lineNo: i + 1 });
      i++;
      continue;
    }
    if (t.startsWith('*** Update File:')) {
      const path = t.slice('*** Update File:'.length).trim();
      const sec: Section = { kind: 'update', path, moveTo: null, content: [], chunks: [], lineNo: i + 1 };
      let j = i + 1;
      if (j < last && lines[j].trim().startsWith('*** Move to:')) {
        sec.moveTo = lines[j].trim().slice('*** Move to:'.length).trim();
        j++;
      }
      const raw: string[] = [];
      const rawStart = j;
      while (j < last) {
        if (v4aSectionStart(lines[j].trim())) break;
        raw.push(lines[j]);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1])) raw.pop();
      let cur: Chunk | null = null;
      for (let k = 0; k < raw.length; k++) {
        const b = raw[k];
        const bt = b.trim();
        const lineNo = rawStart + k + 1;
        if (bt.startsWith('@@')) {
          cur = { anchor: bt.slice(2).trim(), O: [], N: [], eof: false };
          sec.chunks.push(cur);
          continue;
        }
        if (bt === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
            cur = { anchor: null, O: [], N: [], eof: false };
            sec.chunks.push(cur);
          }
          if (b === '' || b.startsWith(' ')) {
            const txt = b === '' ? '' : b.slice(1);
            cur.O.push({ text: txt, ctx: true });
            cur.N.push({ text: txt, ctx: true });
          } else if (b.startsWith('-')) {
            cur.O.push({ text: b.slice(1), ctx: false });
          } else {
            cur.N.push({ text: b.slice(1), ctx: false });
          }
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
      sections.push(sec);
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      edits.push((tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.content.length === 0 ? '' : s.content.join('\n') + '\n');
      });
      continue;
    }
    if (s.kind === 'delete') {
      edits.push((tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      });
      continue;
    }
    edits.push((tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      const text = tree.get(s.path);
      if (text === null) throw new Fail('missing', s.path);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      let parts = fileParts(text);
      let cursor = 0;
      for (const c of s.chunks) {
        if (c.anchor !== null && c.anchor !== '') {
          const ai = findSingleLine(parts.lines, c.anchor, cursor, strict);
          if (ai === -1) throw new Fail('no-match', s.path);
          cursor = ai + 1;
        }
        if (c.O.length === 0) {
          const idx = c.eof ? parts.lines.length : cursor;
          const ins = c.N.map((l) => l.text);
          const lines2 = [...parts.lines.slice(0, idx), ...ins, ...parts.lines.slice(idx)];
          parts = { br: parts.br, lines: lines2, final: parts.final };
          cursor = idx + ins.length;
          continue;
        }
        const oTexts = c.O.map((l) => l.text);
        const tier = findTier(parts.lines, oTexts, cursor, strict);
        if (tier < 0) throw new Fail('no-match', s.path);
        let occ = occurrences(parts.lines, oTexts, tier, cursor);
        if (c.eof) occ = occ.filter((p) => p + oTexts.length === parts.lines.length);
        if (occ.length === 0) throw new Fail('no-match', s.path);
        const pos = occ[0];
        const rep = buildReplacement(parts.lines, pos, c.O, c.N, tier);
        const lines2 = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + c.O.length)];
        parts = { br: parts.br, lines: lines2, final: parts.final };
        cursor = pos + rep.length;
      }
      const out = fileText(parts);
      if (s.moveTo !== null) {
        tree.now.set(s.moveTo, out);
        tree.now.set(s.path, null);
        moves.push([s.path, s.moveTo]);
      } else {
        tree.now.set(s.path, out);
      }
    });
  }
  return edits;
}

// ---- SPEC §9 JSON ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---- SPEC §4 detecting the format ----

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

// ---- SPEC §1, §2, §10 command line, output, ordering, atomicity ----

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
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, moves, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, moves, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const handled = new Set<string>();
  for (const [old, nw] of moves) {
    const wasOld = tree.original(old);
    const nowOld = tree.now.get(old);
    const wasNew = tree.original(nw);
    const nowNew = tree.now.get(nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: nw, text: `R ${old} -> ${nw}` });
      handled.add(old);
      handled.add(nw);
    }
  }
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
