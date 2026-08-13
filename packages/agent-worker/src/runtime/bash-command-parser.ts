/**
 * An interpreter invoked with `-c` runs its QUOTED argument as a command, so
 * that body is a command position and must be scanned. Everywhere else a quote
 * introduces data (`git commit -m '…'`), which is why the package-install
 * patterns do not treat a quote character as a word boundary.
 *
 * The interpreter itself must be in COMMAND position — start of the string, a
 * newline, or just after a shell operator. Without that anchor,
 * `echo sh -c 'nix run x'` would have its argument text scanned as if it were
 * executed, and a newline-delimited `sh -c` would be missed entirely.
 *
 * `c` may sit anywhere in a short-option cluster and may follow other options
 * given as separate words, so `-lc`, `-ce`, `-cx` and `bash -euo pipefail -c`
 * all reach the body. Matching only clusters that END in `c` missed every one
 * of those, including the very common `set -euo pipefail` idiom.
 *
 * The preceding-options loop keeps each word's role UNAMBIGUOUS: an option
 * starts with `-`, its optional operand does not. An earlier spelling offered
 * `-[a-z]*\s+` and `-[a-z]*\s+\S+\s+` as alternatives, and since `\S+` also
 * matches an option, `sh - - - - …` had exponentially many parses: a
 * backtracking blowup on input the agent controls (CodeQL alert 481).
 */
export const INTERPRETER_DASH_C =
  /(?:^|[;|&(\n])[^\S\n]*(?:ba|z|k|a|da)?sh\s+(?:-[a-z]*\s+(?:[^-\s]\S*\s+)?)*-[a-z]*c[a-z]*\s+(['"])([\s\S]*?)\1/gi;

/**
 * Replace non-command text with spaces, preserving offsets and delimiters:
 * the contents of quoted spans, anything after an unquoted `#` comment, and a
 * backslash escape together with the character it makes literal.
 * A word boundary inside either then cannot open a command position, so
 * `git commit -m 'document nix shell support'` and `echo done # nix run x`
 * no longer match while the surrounding real command is scanned normally.
 *
 * Offsets are preserved rather than the span deleted so that `foo'a'bar` does
 * not collapse into a new adjacent token.
 *
 * A heredoc body (`cat <<EOF … EOF`) is NOT stripped: recognizing one means
 * tracking the delimiter across lines, which is the bash-lexer rabbit hole this
 * matcher deliberately stays out of. A heredoc that quotes an install command
 * is therefore still flagged — an over-denial on an unusual command, not a hole.
 */
export function blankQuotedSpans(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      // A backslash escape inside double quotes keeps the next char quoted.
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        out += "  ";
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      continue;
    }
    // Outside quotes a backslash escapes the next character, so the pair is
    // argument DATA: `echo foo\; nix run x` is ONE echo command, not two, and
    // `echo it\'s fine; npm install` never enters a quoted span. Blank both
    // characters so the escaped one cannot open a command position, a quoted
    // span, or a comment. An escaped newline is a line continuation, and
    // blanking it likewise keeps the command on one line.
    if (ch === "\\" && i + 1 < text.length) {
      out += "  ";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    // `#` opens a comment only at the START of a word — after whitespace, a
    // shell operator (`echo hi;# …`), or at the very beginning. Mid-token it is
    // an ordinary character and must stay one, since `nix run nixpkgs#hello`
    // depends on it. Blank to end of line, keeping the newline so later lines
    // are still scanned.
    if (ch === "#" && (i === 0 || /[\s;|&()]/.test(text[i - 1] as string))) {
      out += "#";
      i++;
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      if (i < text.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Printer and lookup commands: they display or resolve their operands, so what
 * follows is data. These only narrow in COMMAND POSITION (the word being run:
 * the first that is not a `VAR=value` assignment prefix) — as any later word
 * they are an operand of whatever runs them, and
 * dropping the tail there loses a real install: in `sudo -u ls npm install`,
 * `ls` is a USERNAME and npm still runs.
 */
const ARGUMENT_DATA_COMMANDS = new Set([
  "echo",
  "printf",
  "man",
  "whatis",
  "apropos",
  "which",
  "whereis",
  "type",
  "ls",
  "grep",
  "egrep",
  "fgrep",
  "rg",
]);

/**
 * Long PATTERN options, whose operand is a regex — but ONLY when the command
 * running them is one that owns the spelling. An option is not self-evidently
 * an option: `env -u --grep npm install evil` passes `--grep` as the VARIABLE
 * NAME to unset and then execs the rest, so honouring it anywhere hid a real
 * install behind any exec wrapper that takes a value.
 *
 * Short options are absent entirely: a single letter means different things to
 * different commands, and reading one without knowing its owner loses a real
 * install — `-m` is git's message but `parallel`'s max-args, and
 * `parallel -m npm install lodash ::: left-pad` RUNS npm.
 */
const ARGUMENT_DATA_OPTIONS = new Set(["--grep", "--regexp"]);

/** Commands that own {@link ARGUMENT_DATA_OPTIONS}; anything else exec's. */
const ARGUMENT_DATA_OPTION_OWNERS = new Set([
  "git",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
]);

/**
 * Run `matches` over each command in `text`, dropping the tail that an
 * {@link ARGUMENT_DATA_COMMANDS} or {@link ARGUMENT_DATA_OPTIONS} word
 * consumes as data.
 *
 * Commands are split on the separators the package-install patterns treat as
 * opening a command position (`;`, `|`, `&`, parens, newline), so
 * `echo uvx cowsay | npm install x` still flags the half that runs.
 *
 * This narrowing is intentionally shallow: a command with no data word keeps
 * its whole text, so anything this cannot prove to be an argument is still
 * matched. Modelling wrapper signatures or line-continuation semantics here
 * would amount to reimplementing bash.
 */
export function matchesBeforeArgumentData(
  text: string,
  matches: (candidate: string) => boolean
): boolean {
  for (const command of text.split(/[;|&()\n]/)) {
    // Blanking a quoted span leaves its quotes behind around whitespace, so a
    // quoted assignment value splits in two: `foo="bar"` arrives as `foo="`
    // plus a lone `"`. Dropping the empty-quote residue keeps the assignment
    // one word, so `foo="bar" echo npm install` still finds `echo` running.
    const words = command
      .split(/\s+/)
      .filter((word) => word && !/^['"]+$/.test(word));
    // Leading `VAR=value` words assign to the command's environment, they are
    // not the command: `foo=bar echo npm install` runs echo. The first word
    // that is not one holds command position.
    const commandAt = words.findIndex(
      (word) => !/^[a-z_][a-z0-9_]*=/.test(word)
    );
    // Both narrowings need the word to be doing its own job, not sitting in
    // someone else's operand slot: a printer/lookup name only consumes data as
    // the word being RUN, and a pattern option only when the command running it
    // is the one that owns that spelling.
    const runs = commandAt === -1 ? undefined : words[commandAt];
    const ownsDataOptions =
      runs !== undefined && ARGUMENT_DATA_OPTION_OWNERS.has(runs);
    const dataAt = words.findIndex(
      (word, index) =>
        (ownsDataOptions && ARGUMENT_DATA_OPTIONS.has(word)) ||
        (index === commandAt && ARGUMENT_DATA_COMMANDS.has(word))
    );
    const head = (dataAt === -1 ? words : words.slice(0, dataAt)).join(" ");
    if (head && matches(head)) {
      return true;
    }
  }
  return false;
}

/**
 * Split a shell command into its individual sub-commands.
 *
 * A prefix-only allow/deny check is trivially bypassed by command chaining and
 * substitution: an allowed prefix (`git status`) followed by `;`, `&&`, `||`,
 * `|`, a newline, `$( … )`, or backticks runs an arbitrary second command that
 * the policy never inspects. To close that hole we evaluate the prefix check
 * against EVERY sub-command, not just the leading one.
 *
 * This is a deliberately conservative lexer — not a full shell parser. It walks
 * the string tracking single/double quotes and treats any of the shell control
 * operators, plus the boundaries of `$( … )` / backtick substitutions, as
 * segment separators. Substitution boundaries are split rather than recursed so
 * the substituted command body is checked as its own segment. Quoted operators
 * (e.g. `echo "a; b"`) are intentionally left intact — they are data, not a new
 * command — while unquoted ones start a new segment.
 */
export function splitShellCommands(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      // Inside double quotes only `$( … )` / backticks introduce a new command;
      // everything else (including `;`, `&&`, `|`) is literal data.
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "$" && next === "(") {
        push();
        i++; // consume "("
      } else if (ch === "`") {
        push();
      } else {
        current += ch;
      }
      continue;
    }

    // Backslash-newline is LINE CONTINUATION: the shell deletes both characters
    // before tokenizing, so `r\<newline>m -rf /` runs as `rm -rf /`. Drop both
    // rather than keeping them as text, or a deny prefix can be split in half
    // and evaded.
    if (ch === "\\" && next === "\n") {
      i++;
      continue;
    }

    // Any other outside-quote backslash escapes the next character, making an
    // escaped metacharacter literal data — `echo foo\; nix run` is ONE `echo`,
    // not two commands. Consume both so the escaped `;`/`|`/`&` is not read as
    // a segment boundary.
    if (ch === "\\" && next !== undefined) {
      current += ch + next;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }

    // Command-substitution boundaries become segment separators so the
    // substituted body is checked on its own.
    if (ch === "$" && next === "(") {
      push();
      i++; // consume "("
      continue;
    }
    // Process substitution: `<( … )` / `>( … )` runs the inner command, so the
    // boundary starts a new segment and the substituted body is checked on its
    // own (e.g. `cat <(rm -rf /)` must not let `rm` ride inside the `cat` segment).
    if ((ch === "<" || ch === ">") && next === "(") {
      push();
      i++; // consume "("
      continue;
    }
    if (ch === ")" || ch === "`") {
      push();
      continue;
    }

    // Control operators: ; & && | || and newlines.
    if (ch === "\n" || ch === ";") {
      push();
      continue;
    }
    if (ch === "&" || ch === "|") {
      push();
      if (next === ch) {
        i++; // collapse && / ||
      }
      continue;
    }

    current += ch;
  }

  push();
  return segments;
}
