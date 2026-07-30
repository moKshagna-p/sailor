'use client';

import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { type Ref, useImperativeHandle, useMemo, useRef } from 'react';

/** Ochre-on-ink, matching the chrome. Bright enough to read, quiet enough to ignore. */
const theme = EditorView.theme(
  {
    '&': { color: '#cec6ba', backgroundColor: 'transparent' },
    '.cm-line': { padding: '0 12px' },
  },
  { dark: true },
);

const highlight = EditorView.baseTheme({});

/**
 * Revealing a line is a command, not state: the same line asked for twice must
 * scroll twice, which a prop would swallow. Hence an imperative handle.
 */
export type EditorHandle = { revealLine: (line: number) => void };

export function Editor({
  value,
  onChange,
  ref,
}: {
  value: string;
  onChange: (next: string) => void;
  ref?: Ref<EditorHandle>;
}) {
  const viewRef = useRef<EditorView | null>(null);

  const extensions = useMemo(
    () => [StreamLanguage.define(stex), theme, highlight, EditorView.lineWrapping],
    [],
  );

  useImperativeHandle(ref, () => ({
    revealLine(line) {
      const view = viewRef.current;
      if (!view) return;
      // Clamp. The map belongs to the last successful compile, so the buffer may
      // already be shorter than the line it names — better to land at the end
      // than to throw.
      const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: target.from, head: target.to },
        effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
      });
      view.focus();
    },
  }));

  return (
    <CodeMirror
      value={value}
      height="100%"
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={(view) => {
        viewRef.current = view;
      }}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        autocompletion: false,
        bracketMatching: true,
        closeBrackets: true,
      }}
      style={{ height: '100%', fontSize: 13 }}
    />
  );
}
