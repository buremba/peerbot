import type { ComponentChildren } from "preact";

export type CodeSnippet = {
  code: string;
  path: string;
  githubUrl: string;
  language: "toml" | "yaml" | "typescript" | "markdown";
};

type CodeBlockProps = {
  snippet: CodeSnippet;
  /** Override the filename shown in the tab. Defaults to `snippet.path`. */
  tabLabel?: string;
  /** Optional pill in the tab (e.g. "declarative", "reactive"). */
  badge?: string;
  /** Extra footer text rendered next to the GitHub link. */
  footnote?: ComponentChildren;
};

type Token = { kind: TokenKind; text: string };
type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "key"
  | "builtin"
  | "punctuation";

const KIND_COLOR: Record<TokenKind, string> = {
  plain: "var(--color-landing-code-text)",
  comment: "var(--color-landing-code-comment)",
  string: "var(--color-landing-code-string)",
  keyword: "var(--color-landing-code-keyword)",
  key: "var(--color-landing-code-key)",
  builtin: "var(--color-landing-code-builtin)",
  punctuation: "var(--color-landing-code-comment)",
};

const TS_KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "default",
  "class",
  "extends",
  "implements",
  "interface",
  "type",
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "throw",
  "try",
  "catch",
  "finally",
  "await",
  "async",
  "yield",
  "new",
  "this",
  "super",
  "true",
  "false",
  "null",
  "undefined",
  "typeof",
  "instanceof",
  "in",
  "of",
  "as",
  "void",
]);

/**
 * Render tokens, recombining lines so the calling `<pre>` keeps each line as
 * one element (needed so the optional truncation cleanly cuts on a line break).
 */
function tokensToJsx(tokens: Token[]): ComponentChildren {
  return tokens.map((tok, i) => {
    if (tok.kind === "plain") {
      // Plain text — render as a raw string so React doesn't add wrappers.
      return tok.text;
    }
    return (
      <span key={i} style={{ color: KIND_COLOR[tok.kind] }}>
        {tok.text}
      </span>
    );
  });
}

/* -------------------------------------------------------------------------- */
/*  TOML tokenizer                                                            */
/* -------------------------------------------------------------------------- */

function tokenizeToml(line: string): Token[] {
  const out: Token[] = [];

  // Whole-line comment.
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) {
    return [{ kind: "comment", text: line }];
  }

  // Section header: [agents.foo] or [[agents.foo.providers]]
  const sectionMatch = /^(\s*)(\[\[?[^\]]+\]\]?)(.*)$/.exec(line);
  if (sectionMatch) {
    out.push({ kind: "plain", text: sectionMatch[1] });
    out.push({ kind: "keyword", text: sectionMatch[2] });
    if (sectionMatch[3]) {
      out.push(...tokenizeTomlInline(sectionMatch[3]));
    }
    return out;
  }

  // key = value
  const kvMatch = /^(\s*)([A-Za-z_][\w.-]*)(\s*=\s*)(.*)$/.exec(line);
  if (kvMatch) {
    out.push({ kind: "plain", text: kvMatch[1] });
    out.push({ kind: "key", text: kvMatch[2] });
    out.push({ kind: "punctuation", text: kvMatch[3] });
    out.push(...tokenizeTomlInline(kvMatch[4]));
    return out;
  }

  // Blank or array continuation — tokenize inline.
  return tokenizeTomlInline(line);
}

function tokenizeTomlInline(rest: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "#") {
      out.push({ kind: "comment", text: rest.slice(i) });
      break;
    }
    if (ch === '"') {
      const end = findStringEnd(rest, i + 1, '"');
      out.push({ kind: "string", text: rest.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (ch === "'") {
      const end = findStringEnd(rest, i + 1, "'");
      out.push({ kind: "string", text: rest.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    // Numbers / booleans.
    const wordMatch = /^(true|false|-?[\d.]+)/.exec(rest.slice(i));
    if (wordMatch) {
      out.push({ kind: "keyword", text: wordMatch[0] });
      i += wordMatch[0].length;
      continue;
    }
    out.push({ kind: "plain", text: ch });
    i++;
  }
  return mergePlain(out);
}

function findStringEnd(s: string, from: number, quote: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === quote) return i;
  }
  return s.length - 1;
}

/* -------------------------------------------------------------------------- */
/*  YAML tokenizer                                                            */
/* -------------------------------------------------------------------------- */

function tokenizeYaml(line: string): Token[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) {
    return [{ kind: "comment", text: line }];
  }
  if (trimmed === "---") {
    return [{ kind: "punctuation", text: line }];
  }

  // `- key: value` list-item-with-mapping
  const dashMapping = /^(\s*-\s+)([A-Za-z_][\w-]*)(\s*:)(.*)$/.exec(line);
  if (dashMapping) {
    return [
      { kind: "plain", text: dashMapping[1] },
      { kind: "key", text: dashMapping[2] },
      { kind: "punctuation", text: dashMapping[3] },
      ...tokenizeYamlInline(dashMapping[4]),
    ];
  }

  // `key: value`
  const mapping = /^(\s*)([A-Za-z_][\w.-]*)(\s*:)(.*)$/.exec(line);
  if (mapping) {
    return [
      { kind: "plain", text: mapping[1] },
      { kind: "key", text: mapping[2] },
      { kind: "punctuation", text: mapping[3] },
      ...tokenizeYamlInline(mapping[4]),
    ];
  }

  // `- value`
  const dashScalar = /^(\s*-\s+)(.*)$/.exec(line);
  if (dashScalar) {
    return [
      { kind: "plain", text: dashScalar[1] },
      ...tokenizeYamlInline(dashScalar[2]),
    ];
  }
  return tokenizeYamlInline(line);
}

function tokenizeYamlInline(rest: string): Token[] {
  const out: Token[] = [];
  if (rest.length === 0) return out;
  let i = 0;
  // Leading whitespace preserved.
  while (i < rest.length && rest[i] === " ") {
    out.push({ kind: "plain", text: " " });
    i++;
  }
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "#") {
      out.push({ kind: "comment", text: rest.slice(i) });
      i = rest.length;
      break;
    }
    if (ch === '"') {
      const end = findStringEnd(rest, i + 1, '"');
      out.push({ kind: "string", text: rest.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (ch === "'") {
      const end = findStringEnd(rest, i + 1, "'");
      out.push({ kind: "string", text: rest.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (ch === "|" || ch === ">") {
      // YAML block scalar indicator.
      out.push({ kind: "keyword", text: ch });
      i++;
      continue;
    }
    // Word / scalar — break on whitespace, `,`, `]`, `}`.
    const remainder = rest.slice(i);
    const wordMatch = /^[^\s,\]}#]+/.exec(remainder);
    if (wordMatch) {
      const text = wordMatch[0];
      if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(text)) {
        out.push({ kind: "keyword", text });
      } else {
        out.push({ kind: "string", text });
      }
      i += text.length;
      continue;
    }
    out.push({ kind: "plain", text: ch });
    i++;
  }
  return mergePlain(out);
}

/* -------------------------------------------------------------------------- */
/*  TypeScript tokenizer (intentionally minimal)                              */
/* -------------------------------------------------------------------------- */

function tokenizeTypescript(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const rest = line.slice(i);

    // Line comment.
    if (rest.startsWith("//")) {
      out.push({ kind: "comment", text: rest });
      break;
    }
    // String literal.
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = findStringEnd(line, i + 1, ch);
      out.push({ kind: "string", text: line.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    // Number.
    if (/[\d]/.test(ch)) {
      const m = /^[\d._]+/.exec(rest);
      if (m) {
        out.push({ kind: "keyword", text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    // Identifier / keyword.
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (m) {
        const word = m[0];
        const next = line[i + word.length];
        if (TS_KEYWORDS.has(word)) {
          out.push({ kind: "keyword", text: word });
        } else if (
          /^[A-Z]/.test(word) ||
          next === "(" ||
          (next === ":" && line[i + word.length + 1] !== ":")
        ) {
          // Heuristics: PascalCase, function call, or `key:` object-literal
          // shape -> render as key/identifier accent.
          out.push({ kind: "key", text: word });
        } else {
          out.push({ kind: "plain", text: word });
        }
        i += word.length;
        continue;
      }
    }
    out.push({ kind: "plain", text: ch });
    i++;
  }
  return mergePlain(out);
}

function mergePlain(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (last && last.kind === "plain" && t.kind === "plain") {
      last.text += t.text;
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Markdown tokenizer — frontmatter fence, frontmatter keys, ATX headings,   */
/*  and inline backtick code spans. Everything else falls through as plain.   */
/* -------------------------------------------------------------------------- */

function tokenizeMarkdownFile(code: string): Token[][] {
  const lines = code.split("\n");
  let inFrontmatter = false;
  return lines.map((line, idx) => {
    if (line.trim() === "---") {
      // Open frontmatter on first `---`, close on second.
      if (idx === 0) {
        inFrontmatter = true;
        return [{ kind: "punctuation", text: line }];
      }
      if (inFrontmatter) {
        inFrontmatter = false;
        return [{ kind: "punctuation", text: line }];
      }
      return [{ kind: "punctuation", text: line }];
    }
    if (inFrontmatter) {
      // `key: value`
      const m = /^([A-Za-z_][\w-]*)(\s*:\s*)(.*)$/.exec(line);
      if (m) {
        return [
          { kind: "key", text: m[1] },
          { kind: "punctuation", text: m[2] },
          { kind: "string", text: m[3] },
        ];
      }
      return [{ kind: "plain", text: line }];
    }
    // ATX heading.
    const heading = /^(#{1,6})(\s+.*)$/.exec(line);
    if (heading) {
      return [
        { kind: "keyword", text: heading[1] },
        { kind: "key", text: heading[2] },
      ];
    }
    // Inline backtick code spans.
    if (line.includes("`")) {
      const out: Token[] = [];
      let i = 0;
      while (i < line.length) {
        const tick = line.indexOf("`", i);
        if (tick === -1) {
          out.push({ kind: "plain", text: line.slice(i) });
          break;
        }
        if (tick > i) out.push({ kind: "plain", text: line.slice(i, tick) });
        const end = line.indexOf("`", tick + 1);
        if (end === -1) {
          out.push({ kind: "plain", text: line.slice(tick) });
          break;
        }
        out.push({ kind: "string", text: line.slice(tick, end + 1) });
        i = end + 1;
      }
      return out;
    }
    return [{ kind: "plain", text: line }];
  });
}

function highlight(code: string, language: CodeSnippet["language"]): Token[][] {
  if (language === "markdown") return tokenizeMarkdownFile(code);
  const tokenize =
    language === "toml"
      ? tokenizeToml
      : language === "yaml"
        ? tokenizeYaml
        : tokenizeTypescript;
  return code.split("\n").map((line) => tokenize(line));
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function CodeBlock({
  snippet,
  tabLabel,
  badge,
  footnote,
}: CodeBlockProps) {
  const lines = highlight(snippet.code, snippet.language);

  return (
    <div
      class="overflow-hidden rounded-lg border"
      style={{
        backgroundColor: "var(--color-landing-code-bg)",
        borderColor: "var(--color-page-border)",
      }}
    >
      <div
        class="flex items-center justify-between border-b px-4 py-2 font-mono text-[11.5px] lowercase"
        style={{
          color: "var(--color-landing-code-comment)",
          backgroundColor: "var(--color-landing-code-bg-soft)",
          borderColor: "rgba(255,255,255,0.06)",
        }}
      >
        <span>{tabLabel ?? snippet.path}</span>
        {badge ? (
          <span style={{ color: "var(--color-landing-code-comment)" }}>
            {badge}
          </span>
        ) : null}
      </div>

      <pre
        class="overflow-x-auto px-5 py-4 font-mono text-[12.5px] leading-[1.65]"
        style={{ color: "var(--color-landing-code-text)" }}
      >
        <code class="block">
          {lines.map((toks, idx) => (
            <span class="block whitespace-pre" key={idx}>
              {tokensToJsx(toks)}
              {idx < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>

      <div
        class="flex items-center justify-between border-t px-4 py-2 font-mono text-[11px] lowercase"
        style={{
          color: "var(--color-landing-code-comment)",
          backgroundColor: "var(--color-landing-code-bg-soft)",
          borderColor: "rgba(255,255,255,0.06)",
        }}
      >
        <span>{lines.length} lines</span>
        <span class="flex items-center gap-3">
          {footnote}
          <a href={snippet.githubUrl} rel="noopener noreferrer" target="_blank">
            see on github →
          </a>
        </span>
      </div>
    </div>
  );
}
