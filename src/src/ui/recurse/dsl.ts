/**
 * Recursive generative text DSL — parser & evaluator.
 *
 * Syntax:
 *   -- ...               lines starting with -- pass through as literal output
 *   (plain text)         lines without -- or @/$ are comments (hidden)
 *   $self                entire source text
 *   $line(n)             line n of source (1-indexed)
 *   $output              output generated so far
 *   @repeat(text, n)     repeat text n times
 *   @reverse(text)       reverse string
 *   @mirror(text)        text + reversed text
 *   @shuffle(text)       shuffle lines randomly
 *   @slice(text, s, e)   substring
 *   @concat(a, b)        join a and b
 *   @upper(text)         uppercase
 *   @lower(text)         lowercase
 *   @len(text)           string length (number)
 *   @lines(text)         count of lines (number)
 *   @join(text, sep)     join lines of text with separator
 *   @if(cond, then, else)  conditional; cond supports >, <, = on numbers
 *   @time                current HH:MM:SS
 *
 * CUBE VGA code generation:
 *   @vga_color(r, g, b)              9-bit DAC value from RGB (0-7 each)
 *   @cube_comment(text)              -- text
 *   @cube_node(n)                    node N header
 *   @cube_fill(value, count)         /\ fill{value=V, count=N}
 *   @cube_loop(n)                    loop{n=N}
 *   @cube_again()                    /\ again{}
 *   @cube_hsync()                    /\ send{port=0x15D, value=0x20000}
 *   @cube_vsync()                    send{port=0x15D, value=0x10000}
 *   @cube_rect(node, x, y, w, h, fg_r, fg_g, fg_b, bg_r, bg_g, bg_b)
 *                                    full VGA rectangle renderer
 *   @cube_gradient(node, screen_w, screen_h)
 *                                    full-screen RGB gradient
 *   @nl                              newline (for multi-line output in one expression)
 *   @indent(text, n)                 indent each line by n spaces
 *   @math(expr)                      evaluate arithmetic (+, -, *, /)
 *   @range(start, end)               numbers from start to end-1, newline-separated
 *   @pad(text, width, char)          right-pad text to width
 *
 * Anything that doesn't parse passes through as literal text.
 * Max recursion depth: 16.
 */

const MAX_DEPTH = 16;
const MAX_OUTPUT = 100_000; // prevent memory blowup

export interface EvalResult {
  output: string;
  errors: number;
}

/** Evaluate source, returning rendered output and error count. */
export function evaluate(source: string): EvalResult {
  const lines = source.split('\n');
  let errors = 0;
  const outputLines: string[] = [];

  for (const line of lines) {
    // Lines starting with -- pass through as literal output (CUBE comments).
    // Lines containing @ or $ are evaluated.
    // Everything else is a comment (hidden from output).
    const trimmed = line.trimStart();
    const isDash = trimmed.startsWith('--');
    const hasMeta = line.includes('@') || line.includes('$');
    if (!isDash && !hasMeta) continue;

    try {
      const result = isDash && !hasMeta ? line : evalExpr(line, source, outputLines.join('\n'), 0);
      outputLines.push(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outputLines.push(`[Error: ${msg}]`);
      errors++;
    }

    // Safety valve
    if (outputLines.join('\n').length > MAX_OUTPUT) {
      outputLines.push('[Error: output too large, truncated]');
      errors++;
      break;
    }
  }

  return { output: outputLines.join('\n'), errors };
}

/** Evaluate an expression string, resolving all @func() and $var references. */
function evalExpr(expr: string, source: string, outputSoFar: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new Error('max recursion depth exceeded');

  let result = '';
  let i = 0;

  while (i < expr.length) {
    // @time (no parens)
    if (expr.startsWith('@time', i) && !isAlphaNum(expr[i + 5])) {
      const now = new Date();
      result += [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, '0'))
        .join(':');
      i += 5;
      continue;
    }

    // @nl (no parens — inserts newline)
    if (expr.startsWith('@nl', i) && !isAlphaNum(expr[i + 3])) {
      result += '\n';
      i += 3;
      continue;
    }

    // @func(...)
    if (expr[i] === '@' && i + 1 < expr.length && isAlpha(expr[i + 1])) {
      const nameStart = i + 1;
      let j = nameStart;
      while (j < expr.length && isAlphaNum(expr[j])) j++;

      if (j < expr.length && expr[j] === '(') {
        const name = expr.slice(nameStart, j);
        const { args, end } = parseArgs(expr, j);
        i = end;

        // Evaluate each argument
        const evalArgs = args.map(a => evalExpr(a.trim(), source, outputSoFar, depth + 1));
        result += callFunc(name, evalArgs, source, outputSoFar, depth);
        continue;
      }

      // Not followed by ( — pass through as literal
      result += expr[i];
      i++;
      continue;
    }

    // $self
    if (expr.startsWith('$self', i) && !isAlpha(expr[i + 5])) {
      result += source;
      i += 5;
      continue;
    }

    // $output
    if (expr.startsWith('$output', i) && !isAlpha(expr[i + 7])) {
      result += outputSoFar;
      i += 7;
      continue;
    }

    // $line(n)
    if (expr.startsWith('$line(', i)) {
      const closeIdx = expr.indexOf(')', i + 6);
      if (closeIdx !== -1) {
        const inner = evalExpr(expr.slice(i + 6, closeIdx), source, outputSoFar, depth + 1);
        const n = parseInt(inner, 10);
        const lines = source.split('\n');
        if (!isNaN(n) && n >= 1 && n <= lines.length) {
          result += lines[n - 1];
        } else {
          result += `[Error: $line(${inner}) out of range]`;
        }
        i = closeIdx + 1;
        continue;
      }
    }

    // Literal character
    result += expr[i];
    i++;
  }

  return result;
}

/** Parse comma-separated arguments inside balanced parens. */
function parseArgs(expr: string, openIdx: number): { args: string[]; end: number } {
  // openIdx points to '('
  let depth = 1;
  let i = openIdx + 1;
  const args: string[] = [];
  let current = '';

  while (i < expr.length && depth > 0) {
    if (expr[i] === '(') {
      depth++;
      current += expr[i];
    } else if (expr[i] === ')') {
      depth--;
      if (depth === 0) break;
      current += expr[i];
    } else if (expr[i] === ',' && depth === 1) {
      args.push(current);
      current = '';
    } else {
      current += expr[i];
    }
    i++;
  }

  if (current.length > 0 || args.length > 0) {
    args.push(current);
  }

  return { args, end: i + 1 }; // skip closing )
}

/** Dispatch a function call by name. */
function callFunc(
  name: string,
  args: string[],
  source: string,
  outputSoFar: string,
  depth: number,
): string {
  switch (name) {
    case 'repeat': {
      const text = args[0] ?? '';
      const n = parseInt(args[1] ?? '1', 10);
      if (isNaN(n) || n < 0) return `[Error: @repeat invalid count]`;
      const capped = Math.min(n, MAX_OUTPUT);
      return text.repeat(capped);
    }

    case 'reverse': {
      const text = args[0] ?? '';
      return [...text].reverse().join('');
    }

    case 'mirror': {
      const text = args[0] ?? '';
      return text + [...text].reverse().join('');
    }

    case 'shuffle': {
      const text = args[0] ?? '';
      const lines = text.split('\n');
      // Fisher-Yates
      for (let i = lines.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }
      return lines.join('\n');
    }

    case 'slice': {
      const text = args[0] ?? '';
      const start = parseInt(args[1] ?? '0', 10);
      const end = args[2] !== undefined ? parseInt(args[2], 10) : undefined;
      return text.slice(start, end);
    }

    case 'concat': {
      return args.join('');
    }

    case 'upper': {
      return (args[0] ?? '').toUpperCase();
    }

    case 'lower': {
      return (args[0] ?? '').toLowerCase();
    }

    case 'len': {
      return String((args[0] ?? '').length);
    }

    case 'lines': {
      return String((args[0] ?? '').split('\n').length);
    }

    case 'join': {
      const text = args[0] ?? '';
      const sep = args[1] ?? ' ';
      return text.split('\n').join(sep);
    }

    case 'if': {
      const cond = args[0] ?? '';
      const thenVal = args[1] ?? '';
      const elseVal = args[2] ?? '';
      return evalCondition(cond) ? thenVal : elseVal;
    }

    // -- Utility primitives --

    case 'indent': {
      const text = args[0] ?? '';
      const n = parseInt(args[1] ?? '2', 10);
      const pad = ' '.repeat(Math.max(0, n));
      return text.split('\n').map(l => pad + l).join('\n');
    }

    case 'math': {
      return String(evalMath(args[0] ?? '0'));
    }

    case 'range': {
      const start = parseInt(args[0] ?? '0', 10);
      const end = parseInt(args[1] ?? '0', 10);
      const step = parseInt(args[2] ?? '1', 10) || 1;
      const nums: number[] = [];
      if (step > 0) {
        for (let i = start; i < end && nums.length < 10000; i += step) nums.push(i);
      } else {
        for (let i = start; i > end && nums.length < 10000; i += step) nums.push(i);
      }
      return nums.join('\n');
    }

    case 'pad': {
      const text = args[0] ?? '';
      const width = parseInt(args[1] ?? '0', 10);
      const ch = args[2] ?? ' ';
      return text.padEnd(width, ch);
    }

    // -- CUBE VGA code generation primitives --

    case 'vga_color': {
      const r = parseInt(args[0] ?? '0', 10) & 7;
      const g = parseInt(args[1] ?? '0', 10) & 7;
      const b = parseInt(args[2] ?? '0', 10) & 7;
      return String((r << 6) | (g << 3) | b);
    }

    case 'cube_comment': {
      return `-- ${args[0] ?? ''}`;
    }

    case 'cube_node': {
      return `node ${args[0] ?? '117'}`;
    }

    case 'cube_fill': {
      const value = args[0] ?? '0';
      const count = args[1] ?? '1';
      return `/\\ fill{value=${value}, count=${count}}`;
    }

    case 'cube_loop': {
      return `loop{n=${args[0] ?? '1'}}`;
    }

    case 'cube_again': {
      return '/\\ again{}';
    }

    case 'cube_hsync': {
      return '/\\ send{port=0x15D, value=0x20000}';
    }

    case 'cube_vsync': {
      return 'send{port=0x15D, value=0x10000}';
    }

    case 'cube_send': {
      const port = args[0] ?? '0x15D';
      const value = args[1] ?? '0';
      return `/\\ send{port=${port}, value=${value}}`;
    }

    case 'cube_rect': {
      // Generate a complete VGA rectangle renderer
      // Args: node, x, y, w, h, fg_r, fg_g, fg_b, bg_r, bg_g, bg_b
      // Defaults: node 117, centered 200x200 blue rect on green bg at 640x480
      const node = parseInt(args[0] ?? '117', 10);
      const x = parseInt(args[1] ?? '220', 10);
      const y = parseInt(args[2] ?? '140', 10);
      const w = parseInt(args[3] ?? '200', 10);
      const h = parseInt(args[4] ?? '200', 10);
      const fgR = parseInt(args[5] ?? '0', 10) & 7;
      const fgG = parseInt(args[6] ?? '0', 10) & 7;
      const fgB = parseInt(args[7] ?? '7', 10) & 7;
      const bgR = parseInt(args[8] ?? '0', 10) & 7;
      const bgG = parseInt(args[9] ?? '7', 10) & 7;
      const bgB = parseInt(args[10] ?? '0', 10) & 7;

      const screenW = 640;
      const screenH = 480;
      const fg = (fgR << 6) | (fgG << 3) | fgB;
      const bg = (bgR << 6) | (bgG << 3) | bgB;
      const rightMargin = screenW - x - w;

      const lines: string[] = [];
      lines.push(`-- VGA ${screenW}x${screenH} Rectangle: ${w}x${h} at (${x},${y})`);
      lines.push(`-- FG color: R=${fgR} G=${fgG} B=${fgB} (${fg}), BG: R=${bgR} G=${bgG} B=${bgB} (${bg})`);
      lines.push('');
      lines.push(`node ${node}`);
      lines.push('');
      lines.push('/\\');
      lines.push('');

      // Top margin
      if (y > 0) {
        lines.push(`-- Top margin: ${y} rows`);
        lines.push(`loop{n=${y}}`);
        lines.push(`/\\ fill{value=${bg}, count=${screenW}}`);
        lines.push('/\\ send{port=0x15D, value=0x20000}');
        lines.push('/\\ again{}');
        lines.push('');
        lines.push('/\\');
        lines.push('');
      }

      // Rectangle rows
      lines.push(`-- Rectangle rows: ${h} rows`);
      lines.push(`loop{n=${h}}`);
      if (x > 0) lines.push(`/\\ fill{value=${bg}, count=${x}}`);
      lines.push(`/\\ fill{value=${fg}, count=${w}}`);
      if (rightMargin > 0) lines.push(`/\\ fill{value=${bg}, count=${rightMargin}}`);
      lines.push('/\\ send{port=0x15D, value=0x20000}');
      lines.push('/\\ again{}');
      lines.push('');
      lines.push('/\\');
      lines.push('');

      // Bottom margin
      const bottomMargin = screenH - y - h;
      if (bottomMargin > 0) {
        lines.push(`-- Bottom margin: ${bottomMargin} rows`);
        lines.push(`loop{n=${bottomMargin}}`);
        lines.push(`/\\ fill{value=${bg}, count=${screenW}}`);
        lines.push('/\\ send{port=0x15D, value=0x20000}');
        lines.push('/\\ again{}');
        lines.push('');
        lines.push('/\\');
        lines.push('');
      }

      lines.push('-- End of frame');
      lines.push('send{port=0x15D, value=0x10000}');

      return lines.join('\n');
    }

    case 'cube_gradient': {
      // Generate a full-screen RGB gradient
      const node = parseInt(args[0] ?? '117', 10);
      const screenW = parseInt(args[1] ?? '640', 10);
      const screenH = parseInt(args[2] ?? '480', 10);
      const stepsH = 8; // 8 color steps for 3-bit channels

      const lines: string[] = [];
      lines.push(`-- VGA ${screenW}x${screenH} Color Gradient`);
      lines.push('');
      lines.push(`node ${node}`);
      lines.push('');
      lines.push('/\\');
      lines.push('');

      const rowsPerStep = Math.floor(screenH / stepsH);
      const colsPerStep = Math.floor(screenW / stepsH);

      for (let row = 0; row < stepsH; row++) {
        const g = row; // green varies by row
        const rows = row === stepsH - 1 ? screenH - rowsPerStep * (stepsH - 1) : rowsPerStep;
        lines.push(`-- Row band ${row}: green=${g}`);
        lines.push(`loop{n=${rows}}`);
        for (let col = 0; col < stepsH; col++) {
          const r = col;
          const b = (row + col) & 7;
          const color = (r << 6) | (g << 3) | b;
          const cols = col === stepsH - 1 ? screenW - colsPerStep * (stepsH - 1) : colsPerStep;
          lines.push(`/\\ fill{value=${color}, count=${cols}}`);
        }
        lines.push('/\\ send{port=0x15D, value=0x20000}');
        lines.push('/\\ again{}');
        lines.push('');
        lines.push('/\\');
        lines.push('');
      }

      lines.push('-- End of frame');
      lines.push('send{port=0x15D, value=0x10000}');

      return lines.join('\n');
    }

    default:
      return `[Error: unknown function @${name}]`;
  }
}

/** Evaluate a simple condition: supports >, <, =, >=, <= between numbers. */
function evalCondition(cond: string): boolean {
  const ops = ['>=', '<=', '!=', '>', '<', '='] as const;
  for (const op of ops) {
    const idx = cond.indexOf(op);
    if (idx !== -1) {
      const left = cond.slice(0, idx).trim();
      const right = cond.slice(idx + op.length).trim();
      const a = parseFloat(left);
      const b = parseFloat(right);
      if (isNaN(a) || isNaN(b)) return false;
      switch (op) {
        case '>': return a > b;
        case '<': return a < b;
        case '=': return a === b;
        case '>=': return a >= b;
        case '<=': return a <= b;
        case '!=': return a !== b;
      }
    }
  }
  // Truthy: non-empty, non-zero
  const n = parseFloat(cond);
  if (!isNaN(n)) return n !== 0;
  return cond.trim().length > 0;
}

function isAlpha(ch: string | undefined): boolean {
  if (!ch) return false;
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isAlphaNum(ch: string | undefined): boolean {
  if (!ch) return false;
  return isAlpha(ch) || (ch >= '0' && ch <= '9');
}

/** Simple arithmetic evaluator for @math(): supports +, -, *, /, and parentheses. */
function evalMath(expr: string): number {
  const tokens = expr.replace(/\s+/g, '').split('');
  let pos = 0;

  function parseExpr(): number {
    let left = parseTerm();
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++];
      const right = parseFactor();
      left = op === '*' ? left * right : right !== 0 ? left / right : 0;
    }
    return left;
  }

  function parseFactor(): number {
    if (tokens[pos] === '(') {
      pos++;
      const val = parseExpr();
      if (tokens[pos] === ')') pos++;
      return val;
    }
    if (tokens[pos] === '-') {
      pos++;
      return -parseFactor();
    }
    let numStr = '';
    while (pos < tokens.length && (tokens[pos] >= '0' && tokens[pos] <= '9' || tokens[pos] === '.')) {
      numStr += tokens[pos++];
    }
    return parseFloat(numStr) || 0;
  }

  return parseExpr();
}
