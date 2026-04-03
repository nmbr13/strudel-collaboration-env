import { type MutableRefObject, type ReactElement, useEffect, useRef } from 'react';
import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import * as random from 'lib0/random';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { STRUDEL_DEFAULT_SNIPPET } from '../strudelDefault';
import { getWsBase } from '../wsUrl';

const usercolors = [
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' },
  { color: '#ecd444', light: '#ecd44433' },
  { color: '#ee6352', light: '#ee635233' },
  { color: '#9ac2c9', light: '#9ac2c933' },
  { color: '#8acb88', light: '#8acb8833' },
  { color: '#1be7ff', light: '#1be7ff33' },
];

export type CodeApi = {
  getCode: () => string;
  ytext: Y.Text;
  getView: () => EditorView | null;
  setText: (code: string) => void;
};

type Props = {
  roomId: string;
  sessionToken: string;
  displayName: string;
  apiRef: MutableRefObject<CodeApi | null>;
  onReady?: () => void;
  hasError?: boolean;
};

export function CollabEditor({ roomId, sessionToken, displayName, apiRef, onReady, hasError }: Props): ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    let destroyed = false;
    let view: EditorView | null = null;
    let didNotifyReady = false;

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('code');
    const wsBase = getWsBase();
    const provider = new WebsocketProvider(`${wsBase}/ws/yjs`, roomId, ydoc, {
      params: { token: sessionToken },
      disableBc: true,
    });

    const userColor = usercolors[random.uint32() % usercolors.length];
    provider.awareness.setLocalStateField('user', {
      name: displayName,
      color: userColor.color,
      colorLight: userColor.light,
    });

    apiRef.current = {
      getCode: () => ytext.toString(),
      ytext,
      getView: () => view,
      setText: (code: string) => {
        ydoc.transact(() => {
          ytext.delete(0, ytext.length);
          ytext.insert(0, code);
        });
      },
    };

    const ymeta = ydoc.getMap<boolean>('meta');
    const seedIfEmpty = () => {
      if (ytext.length === 0 && !ymeta.get('seeded')) {
        ydoc.transact(() => {
          if (!ymeta.get('seeded')) {
            ymeta.set('seeded', true);
            ytext.insert(0, STRUDEL_DEFAULT_SNIPPET);
          }
        });
      }
    };

    const mountEditor = () => {
      if (destroyed || view) return;
      const undoManager = new Y.UndoManager(ytext);
      const state = EditorState.create({
        doc: ytext.toString(),
        extensions: [
          yCollab(ytext, provider.awareness, { undoManager }),
          basicSetup,
          oneDark,
          javascript(),
          EditorView.lineWrapping,
        ],
      });
      view = new EditorView({ state, parent: el });
      if (!didNotifyReady) {
        didNotifyReady = true;
        onReadyRef.current?.();
      }
    };

    const onSync = (synced: boolean) => {
      if (!synced) return;
      seedIfEmpty();
      mountEditor();
    };
    provider.on('sync', onSync);

    const fallbackMount = window.setTimeout(() => {
      seedIfEmpty();
      mountEditor();
    }, 2000);

    return () => {
      destroyed = true;
      provider.off('sync', onSync);
      window.clearTimeout(fallbackMount);
      view?.destroy();
      provider.destroy();
      ydoc.destroy();
      apiRef.current = null;
    };
  }, [roomId, sessionToken, displayName, apiRef]);

  return <div ref={parentRef} className={`editor-wrap${hasError ? ' has-error' : ''}`} />;
}
