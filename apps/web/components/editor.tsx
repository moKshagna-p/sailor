'use client';

import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

/** Ochre-on-ink, matching the chrome. Bright enough to read, quiet enough to ignore. */
const theme = EditorView.theme(
  {
    '&': { color: '#cec6ba', backgroundColor: 'transparent' },
    '.cm-line': { padding: '0 12px' },
  },
  { dark: true },
);

const highlight = EditorView.baseTheme({});

export function Editor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const extensions = useMemo(
    () => [StreamLanguage.define(stex), theme, highlight, EditorView.lineWrapping],
    [],
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      extensions={extensions}
      onChange={onChange}
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
