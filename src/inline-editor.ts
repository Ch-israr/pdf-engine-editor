// Inline text editor overlay: a small imperative DOM component that lives
// inside a rendered .page-wrap, anchored to the selected run's text-layer
// spans. It is deliberately NOT React-rendered — the page wraps are built
// imperatively by the viewer, and the overlay must share their lifetime
// (any viewer reload destroys the wraps, and with them this overlay).
//
// Contract (assessment Phase 3):
// - Enter commits (App runs the existing engine apply path).
// - Escape cancels: the draft is discarded; document bytes never change.
// - On an engine refusal App calls showError(): the editor STAYS OPEN with
//   the draft intact and the engine's verbatim reason displayed.
// - Clicking away (blur) cancels only an untouched draft; a modified draft
//   keeps the editor open and flags the keys, so work is never silently
//   discarded.
// - Typing reports the draft through onMeasure (debounced) so App can
//   show the engine's own width estimate under the input.

export interface InlineAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
  angleDeg: number;    // display angle of the run's baseline (page rotation + the span's own transform)
  fontSizePx: number;  // rendered font size of the first span
  fontFamily: string;
  // When true, left/top are the CENTER of the target box and the overlay
  // is rotated about its own center — used for rotated text (90/180/270°),
  // where corner-anchoring a rotated box cannot line up with the target.
  center?: boolean;
}

export interface InlineEditorOptions {
  initialText: string;
  anchor: InlineAnchor;
  onCommit: (text: string) => void;
  onCancel: () => void;
  onMeasure: (text: string) => void;
}

export interface InlineEditorHandle {
  close: () => void;
  showError: (message: string) => void;
  setMeasure: (text: string, warn: boolean) => void;
  isClosed: () => boolean;
}

export function openInlineEditor(wrap: HTMLElement, opts: InlineEditorOptions): InlineEditorHandle {
  let closed = false;
  let measureTimer: ReturnType<typeof setTimeout> | undefined;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-input';
  input.dataset.testid = 'inline-input';
  input.value = opts.initialText;
  input.setAttribute('aria-label', 'Edit text in place');
  input.style.fontSize = `${opts.anchor.fontSizePx}px`;
  input.style.fontFamily = opts.anchor.fontFamily;
  const charPx = Math.max(6, opts.anchor.fontSizePx * 0.58);
  const inputWidth = Math.max(opts.anchor.width + 28, opts.initialText.length * charPx + 34);
  input.style.width = `${inputWidth}px`;

  const root = document.createElement('div');
  root.className = 'inline-edit';
  root.dataset.testid = 'inline-editor';
  if (opts.anchor.center) {
    // left/top name the target's center: position the overlay so its own
    // center lands there, and rotate about that center. The root is about
    // 50px tall (input + meta line); the input sits at its top, so the
    // input's center is ~11px above the root's center — within tolerance
    // for an editing affordance.
    root.style.left = `${opts.anchor.left - inputWidth / 2}px`;
    root.style.top = `${opts.anchor.top - 25}px`;
    root.style.transformOrigin = 'center center';
  } else {
    root.style.left = `${opts.anchor.left}px`;
    root.style.top = `${opts.anchor.top}px`;
  }
  if (Math.abs(opts.anchor.angleDeg) >= 0.5) {
    root.style.transform = `rotate(${opts.anchor.angleDeg}deg)`;
  }
  root.appendChild(input);

  const meta = document.createElement('div');
  meta.className = 'inline-meta';
  meta.dataset.testid = 'inline-meta';
  meta.textContent = 'Enter ↵ apply · Esc cancel';
  root.appendChild(meta);

  const error = document.createElement('div');
  error.className = 'inline-error';
  error.dataset.testid = 'inline-error';
  error.hidden = true;
  root.appendChild(error);

  const handle: InlineEditorHandle = {
    close: () => {
      if (closed) return;
      closed = true;
      if (measureTimer) clearTimeout(measureTimer);
      root.remove();
    },
    showError: (message: string) => {
      error.textContent = message;
      error.hidden = false;
      root.classList.add('inline-refused');
      input.focus();
      input.select();
    },
    setMeasure: (text: string, warn: boolean) => {
      meta.textContent = text;
      meta.classList.toggle('inline-meta-warn', warn);
    },
    isClosed: () => closed,
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      opts.onCommit(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handle.close();
      opts.onCancel();
    }
  });
  // Keep every keystroke away from the app's global shortcuts while typing.
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('input', () => {
    error.hidden = true;
    root.classList.remove('inline-refused');
    if (measureTimer) clearTimeout(measureTimer);
    measureTimer = setTimeout(() => opts.onMeasure(input.value), 120);
  });
  input.addEventListener('blur', () => {
    if (closed) return;
    if (input.value === opts.initialText) {
      handle.close();
      opts.onCancel();
    } else {
      // Dirty draft: never discard silently. Stay open and flag the keys.
      root.classList.add('inline-attention');
      if (!meta.classList.contains('inline-meta-warn')) {
        meta.textContent = 'Unsaved edit — Enter ↵ to apply · Esc to cancel';
      }
    }
  });

  wrap.appendChild(root);
  input.focus();
  input.select();
  // Measure the untouched draft too, so the width line is meaningful
  // before the user types.
  measureTimer = setTimeout(() => opts.onMeasure(input.value), 60);
  return handle;
}
