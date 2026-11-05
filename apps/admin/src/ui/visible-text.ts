const SIMPLE_ESCAPE = /[nrt0bfv]/;

class Lexer {
  readonly found: string[] = [];
  private readonly braceDepths: number[] = [];
  private index = 0;

  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  run(): string[] {
    while (this.index < this.source.length) {
      this.step();
    }
    return this.found;
  }

  private at(offset = 0): string {
    return this.source[this.index + offset] ?? "";
  }

  private step() {
    const char = this.at();
    const pair = `${char}${this.at(1)}`;
    if (pair === "//") {
      this.skipLine();
    } else if (pair === "/*") {
      const end = this.source.indexOf("*/", this.index + 2);
      this.index = end === -1 ? this.source.length : end + 2;
    } else if (char === '"' || char === "'") {
      this.readQuoted(char);
    } else if (char === "`") {
      this.index += 1;
      this.readTemplateText();
    } else if (this.braceDepths.length > 0 && (char === "{" || char === "}")) {
      this.moveInExpression(char);
    } else {
      this.index += 1;
    }
  }

  private skipLine() {
    while (this.index < this.source.length && this.at() !== "\n") {
      this.index += 1;
    }
  }

  private moveInExpression(brace: string) {
    const depth = this.braceDepths.pop() ?? 0;
    this.index += 1;
    if (brace === "{") {
      this.braceDepths.push(depth + 1);
    } else if (depth === 0) {
      this.readTemplateText();
    } else {
      this.braceDepths.push(depth - 1);
    }
  }

  private readQuoted(quote: string) {
    let text = "";
    this.index += 1;
    while (this.index < this.source.length && this.at() !== quote) {
      if (this.at() === "\\") {
        text += SIMPLE_ESCAPE.test(this.at(1)) ? " " : this.at(1);
        this.index += 2;
      } else {
        text += this.at();
        this.index += 1;
      }
    }
    this.index += 1;
    this.found.push(text);
  }

  private readTemplateText() {
    let text = "";
    while (this.index < this.source.length) {
      const char = this.at();
      if (char === "\\") {
        text += this.at(1);
        this.index += 2;
      } else if (char === "`") {
        this.index += 1;
        break;
      } else if (char === "$" && this.at(1) === "{") {
        this.index += 2;
        this.braceDepths.push(0);
        break;
      } else {
        text += char;
        this.index += 1;
      }
    }
    this.found.push(text);
  }
}

export function stringLiterals(source: string): string[] {
  return new Lexer(source).run();
}
