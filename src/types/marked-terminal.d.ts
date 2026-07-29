declare module 'marked-terminal' {
  import type { MarkedExtension, RendererObject } from 'marked';

  export default class TerminalRenderer implements RendererObject {
    constructor(options?: Record<string, unknown>);
  }

  export function markedTerminal(
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
