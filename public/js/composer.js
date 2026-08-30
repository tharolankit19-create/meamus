/* =============================================================================
 * The prompt composer: textarea + attachments + mode + send.
 * Used on the landing hero, the dashboard, and the workspace chat.
 * ========================================================================== */

import { el, icon, toast, clear } from './ui.js';
import { api } from './api.js';

const MAX_FILES = 6;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_MIME = ['text/plain', 'text/markdown', 'text/csv', 'application/json',
  'text/javascript', 'application/javascript', 'text/html', 'text/css'];
const ACCEPT = [...IMAGE_MIME, ...TEXT_MIME, '.md', '.txt', '.csv', '.json', '.js', '.html', '.css'].join(',');

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
  reader.readAsDataURL(file);
});

/**
 * @param {object} opts
 * @param {string} opts.placeholder
 * @param {(text:string, attachmentIds:string[]) => Promise<void>|void} opts.onSubmit
 * @param {boolean} [opts.compact] chat-sized rather than hero-sized
 * @param {boolean} [opts.autofocus]
 * @param {string} [opts.submitLabel] accessible label for the send button
 * @returns {{node:HTMLElement, setBusy:Function, setValue:Function, focus:Function, clearAll:Function}}
 */
export function createComposer(opts) {
  const attachments = [];      // { id, name, kind, url, pending }
  let busy = false;

  const textarea = el('textarea', {
    rows: '1',
    placeholder: opts.placeholder || 'Describe the game you want…',
    maxlength: '2000',
    'aria-label': opts.placeholder || 'Game prompt'
  });

  const strip = el('div', { class: 'attach-strip hide' });
  const fileInput = el('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'hide' });

  const sendBtn = el('button', {
    class: 'btn send-btn', type: 'button', disabled: true,
    title: opts.submitLabel || 'Send', 'aria-label': opts.submitLabel || 'Send'
  }, icon('arrowUp'));

  const modeSelect = el('select', { class: 'mode-select', title: 'Generation mode' },
    el('option', { value: 'build' }, 'Build'),
    el('option', { value: 'template' }, 'Template'));

  const bar = el('div', { class: 'composer-bar' },
    el('button', {
      class: 'btn icon sq', type: 'button', title: 'Attach images or files',
      'aria-label': 'Attach images or files',
      onClick: () => fileInput.click()
    }, icon('plus', 'lg')),
    el('span', { class: 'grow' }),
    modeSelect,
    sendBtn);

  const node = el('div', { class: `composer ${opts.compact ? 'compact' : ''}` },
    textarea, strip, bar, fileInput);

  /* --- autosize + submit shortcuts ------------------------------------- */
  const autosize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, opts.compact ? 160 : 220)}px`;
  };
  const syncSend = () => {
    const pending = attachments.some((a) => a.pending);
    sendBtn.disabled = busy || pending || !textarea.value.trim();
  };

  textarea.addEventListener('input', () => { autosize(); syncSend(); });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  sendBtn.addEventListener('click', submit);

  /* --- attachments ------------------------------------------------------ */
  function renderStrip() {
    clear(strip);
    strip.classList.toggle('hide', attachments.length === 0);
    for (const att of attachments) {
      strip.append(el('div', { class: `attach-chip ${att.pending ? 'busy' : ''}` },
        att.kind === 'image' && att.preview
          ? el('img', { src: att.preview, alt: '' })
          : el('span', { class: 'fileicon' }, icon(att.kind === 'image' ? 'image' : 'file', 'sm')),
        el('span', { class: 'nm', title: att.name }, att.name),
        el('button', {
          type: 'button', title: `Remove ${att.name}`, 'aria-label': `Remove ${att.name}`,
          onClick: () => {
            const idx = attachments.indexOf(att);
            if (idx > -1) attachments.splice(idx, 1);
            renderStrip();
            syncSend();
          }
        }, icon('x', 'sm'))));
    }
  }

  async function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    if (attachments.length + files.length > MAX_FILES) {
      toast(`You can attach up to ${MAX_FILES} files per message`, 'warn');
      return;
    }

    // Show every file immediately as pending, then upload as a single batch.
    const entries = [];
    for (const file of files) {
      const kind = file.type.startsWith('image/') ? 'image' : 'text';
      const entry = {
        id: null, name: file.name, kind, pending: true,
        preview: kind === 'image' ? URL.createObjectURL(file) : null
      };
      attachments.push(entry);
      entries.push({ entry, file });
    }
    renderStrip();
    syncSend();

    try {
      const payload = await Promise.all(entries.map(async ({ file }) => ({
        name: file.name,
        dataUrl: await readAsDataUrl(file)
      })));
      const { files: stored } = await api('/uploads', { method: 'POST', body: { files: payload } });
      stored.forEach((record, index) => {
        const { entry } = entries[index];
        entry.id = record.id;
        entry.kind = record.kind;
        entry.pending = false;
      });
    } catch (err) {
      // Drop the failed batch rather than leaving unusable chips behind.
      for (const { entry } of entries) {
        const idx = attachments.indexOf(entry);
        if (idx > -1) attachments.splice(idx, 1);
      }
      toast(err.status === 401 ? 'Sign in to attach files' : err.message, 'err', 6000);
    } finally {
      renderStrip();
      syncSend();
    }
  }

  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  /* Drag-and-drop and clipboard paste both route into the same path. */
  ['dragenter', 'dragover'].forEach((type) => node.addEventListener(type, (event) => {
    event.preventDefault();
    node.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((type) => node.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && node.contains(event.relatedTarget)) return;
    node.classList.remove('drag');
  }));
  node.addEventListener('drop', (event) => {
    if (event.dataTransfer && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  });
  textarea.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData ? event.clipboardData.files : [])];
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });

  /* --- submit ------------------------------------------------------------ */
  async function submit() {
    const text = textarea.value.trim();
    if (!text || busy) return;
    if (attachments.some((a) => a.pending)) {
      toast('Wait for the attachments to finish uploading', 'warn');
      return;
    }
    const ids = attachments.map((a) => a.id).filter(Boolean);
    await opts.onSubmit(text, ids, { mode: modeSelect.value });
  }

  const controller = {
    node,
    focus: () => textarea.focus(),
    setValue(value) { textarea.value = value; autosize(); syncSend(); },
    getValue: () => textarea.value,
    clearAll() {
      textarea.value = '';
      attachments.length = 0;
      renderStrip();
      autosize();
      syncSend();
    },
    setBusy(value) {
      busy = value;
      textarea.disabled = value;
      modeSelect.disabled = value;
      clear(sendBtn).append(value ? el('span', { class: 'spinner' }) : icon('arrowUp'));
      syncSend();
    }
  };

  if (opts.autofocus) setTimeout(() => textarea.focus(), 60);
  return controller;
}
