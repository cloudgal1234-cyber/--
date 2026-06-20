/* OmniAI — Frontend Application */

const API_BASE = '';

const state = {
  messages: [],
  attachedFiles: [],
  isStreaming: false,
  currentModel: 'claude-opus-4-8',
};

const el = {
  emptyState: document.getElementById('empty-state'),
  messages: document.getElementById('messages'),
  input: document.getElementById('user-input'),
  sendBtn: document.getElementById('send-btn'),
  attachBtn: document.getElementById('attach-btn'),
  fileInput: document.getElementById('file-input'),
  filePreviews: document.getElementById('file-previews'),
  modelSelect: document.getElementById('model-select'),
  toggleSearch: document.getElementById('toggle-search'),
  toggleCode: document.getElementById('toggle-code'),
  toggleThinking: document.getElementById('toggle-thinking'),
  newChatBtn: document.getElementById('new-chat-btn'),
};

// ── Markdown renderer ──────────────────────────────────────────────────────

marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true,
});

const renderer = new marked.Renderer();
renderer.code = function (code, language) {
  const lang = language || 'text';
  let highlighted;
  try {
    highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang }).value
      : hljs.highlightAuto(code).value;
  } catch {
    highlighted = code;
  }
  return `<pre><div class="code-header"><span>${lang}</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div><code class="hljs">${highlighted}</code></pre>`;
};
marked.use({ renderer });

function renderMarkdown(text) {
  return marked.parse(text || '');
}

function copyCode(btn) {
  const code = btn.closest('pre').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function showError(msg) {
  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function setStreaming(active) {
  state.isStreaming = active;
  el.sendBtn.disabled = active || el.input.value.trim() === '';
  el.input.disabled = active;
  if (active) {
    el.sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
  } else {
    el.sendBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  }
}

function autoResize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function showChat() {
  el.emptyState.classList.add('hidden');
  el.messages.classList.remove('hidden');
}

function getFileIcon(mediaType) {
  if (mediaType.startsWith('image/')) return '🖼️';
  if (mediaType === 'application/pdf') return '📄';
  if (mediaType.startsWith('text/')) return '📝';
  return '📎';
}

// ── File upload ────────────────────────────────────────────────────────────

el.attachBtn.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  for (const file of files) {
    await uploadFile(file);
  }
  e.target.value = '';
});

async function uploadFile(file) {
  const indicator = document.createElement('div');
  indicator.className = 'uploading-indicator';
  indicator.innerHTML = `<div class="tool-spinner"></div> Uploading ${file.name}…`;
  el.filePreviews.classList.remove('hidden');
  el.filePreviews.appendChild(indicator);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || 'Upload failed');
    }
    const data = await resp.json();
    state.attachedFiles.push({ ...data, originalFile: file });
    renderFilePreview(data, file);
  } catch (err) {
    showError(err.message);
  } finally {
    indicator.remove();
    if (!el.filePreviews.children.length) el.filePreviews.classList.add('hidden');
  }
}

function renderFilePreview(fileData, originalFile) {
  const item = document.createElement('div');
  item.className = 'file-preview-item';
  item.dataset.fileId = fileData.file_id;

  let preview = '';
  if (fileData.media_type.startsWith('image/')) {
    const url = URL.createObjectURL(originalFile);
    preview = `<img src="${url}" alt="${fileData.filename}" />`;
  } else {
    preview = `<span style="font-size:20px">${getFileIcon(fileData.media_type)}</span>`;
  }

  item.innerHTML = `
    ${preview}
    <span class="file-name">${fileData.filename}</span>
    <button class="remove-file" title="Remove">✕</button>
  `;

  item.querySelector('.remove-file').addEventListener('click', () => {
    state.attachedFiles = state.attachedFiles.filter(f => f.file_id !== fileData.file_id);
    item.remove();
    if (!el.filePreviews.children.length) el.filePreviews.classList.add('hidden');
    // Clean up from server
    fetch(`${API_BASE}/api/files/${fileData.file_id}`, { method: 'DELETE' }).catch(() => {});
  });

  el.filePreviews.classList.remove('hidden');
  el.filePreviews.appendChild(item);
}

// ── Message rendering ──────────────────────────────────────────────────────

function createUserMessage(text, files) {
  const div = document.createElement('div');
  div.className = 'message message-user';

  let filesHtml = '';
  if (files.length) {
    filesHtml = `<div class="message-files">${files.map(f => `
      <div class="file-tag">
        <span>${getFileIcon(f.media_type)}</span>
        <span>${f.filename}</span>
      </div>`).join('')}</div>`;
  }

  div.innerHTML = `
    <div class="bubble">
      ${filesHtml}
      ${escapeHtml(text)}
    </div>`;
  return div;
}

function createAssistantMessage() {
  const div = document.createElement('div');
  div.className = 'message message-assistant';
  div.innerHTML = `
    <div class="assistant-header">
      <div class="assistant-avatar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M6 12 C6 8, 12 4, 18 8 C18 16, 12 20, 6 16 Z" fill="white" opacity="0.9"/>
        </svg>
      </div>
      <span class="assistant-name">OmniAI</span>
    </div>
    <div class="assistant-content"></div>
  `;
  return { el: div, content: div.querySelector('.assistant-content') };
}

function createThinkingBlock() {
  const block = document.createElement('div');
  block.className = 'thinking-block';
  block.innerHTML = `
    <div class="thinking-header" onclick="toggleThinking(this)">
      <div class="thinking-dot"></div>
      <span>Thinking…</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div class="thinking-content"></div>
  `;
  return { el: block, content: block.querySelector('.thinking-content'), header: block.querySelector('.thinking-header span') };
}

function createToolBlock(toolName) {
  const block = document.createElement('div');
  block.className = 'tool-block';
  const label = toolName === 'web_search' ? 'Web Search'
    : toolName === 'code_execution' ? 'Code Execution'
    : toolName;
  block.innerHTML = `
    <div class="tool-header">
      <div class="tool-spinner"></div>
      <span class="tool-badge">${label}</span>
      <span style="color:var(--text-muted);font-size:12px">Running…</span>
    </div>
  `;
  return { el: block, header: block.querySelector('.tool-header') };
}

function finishToolBlock(toolBlock, toolName) {
  const label = toolName === 'web_search' ? 'Web Search'
    : toolName === 'code_execution' ? 'Code Execution'
    : toolName;
  const checkmark = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
  toolBlock.header.innerHTML = `${checkmark} <span class="tool-badge">${label}</span> <span style="color:var(--text-muted);font-size:12px">Complete</span>`;
}

function createTextBlock() {
  const block = document.createElement('div');
  block.className = 'text-content';
  return block;
}

function toggleThinking(header) {
  header.classList.toggle('collapsed');
  const content = header.parentElement.querySelector('.thinking-content');
  content.classList.toggle('hidden');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Send message ───────────────────────────────────────────────────────────

async function sendMessage(text) {
  if (!text.trim() && !state.attachedFiles.length) return;
  if (state.isStreaming) return;

  showChat();

  // Build content parts
  const contentParts = [];

  // Add attached files
  for (const f of state.attachedFiles) {
    if (f.media_type.startsWith('image/')) {
      contentParts.push({
        type: 'image',
        source: { type: 'file', file_id: f.file_id },
      });
    } else {
      contentParts.push({
        type: 'document',
        source: { type: 'file', file_id: f.file_id },
        title: f.filename,
      });
    }
  }

  if (text.trim()) {
    contentParts.push({ type: 'text', text: text.trim() });
  }

  const userContent = contentParts.length === 1 && contentParts[0].type === 'text'
    ? text.trim()
    : contentParts;

  // Add to history
  state.messages.push({ role: 'user', content: userContent });

  // Render user message
  const userMsgEl = createUserMessage(text.trim(), [...state.attachedFiles]);
  el.messages.appendChild(userMsgEl);

  // Clear input state
  state.attachedFiles = [];
  el.filePreviews.innerHTML = '';
  el.filePreviews.classList.add('hidden');
  el.input.value = '';
  autoResize();
  el.sendBtn.disabled = true;

  scrollToBottom();
  setStreaming(true);

  // Create assistant message container
  const { el: msgEl, content: contentEl } = createAssistantMessage();
  el.messages.appendChild(msgEl);

  // Track blocks
  let currentThinking = null;
  let currentTool = null;
  let currentText = null;
  let currentToolName = '';
  let accThinking = '';
  let accText = '';
  let cursor = null;

  function ensureTextBlock() {
    if (!currentText) {
      currentText = createTextBlock();
      cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      contentEl.appendChild(currentText);
      contentEl.appendChild(cursor);
    }
  }

  function flushText() {
    if (currentText && accText) {
      currentText.innerHTML = renderMarkdown(accText);
      currentText.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
    }
  }

  const payload = {
    messages: state.messages.map(m => ({ role: m.role, content: m.content })),
    model: el.modelSelect.value,
    enable_thinking: el.toggleThinking.checked,
    enable_web_search: el.toggleSearch.checked,
    enable_code_execution: el.toggleCode.checked,
  };

  try {
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        switch (event.type) {
          case 'thinking_start':
            if (currentTool) { finishToolBlock(currentTool, currentToolName); currentTool = null; }
            flushText();
            accThinking = '';
            currentThinking = createThinkingBlock();
            contentEl.insertBefore(currentThinking.el, cursor || null);
            break;

          case 'thinking':
            if (currentThinking) {
              accThinking += event.text;
              currentThinking.content.textContent = accThinking;
              currentThinking.content.scrollTop = currentThinking.content.scrollHeight;
            }
            break;

          case 'text_start':
            if (currentThinking) {
              currentThinking.header.textContent = 'Thought process';
              const dot = currentThinking.el.querySelector('.thinking-dot');
              if (dot) dot.style.animation = 'none';
              currentThinking = null;
            }
            if (currentTool) { finishToolBlock(currentTool, currentToolName); currentTool = null; }
            ensureTextBlock();
            break;

          case 'text':
            accText += event.text;
            if (currentText) {
              currentText.innerHTML = renderMarkdown(accText);
              if (cursor && cursor.parentNode === contentEl) {
                contentEl.insertBefore(cursor, currentText.nextSibling);
              }
            }
            scrollToBottom();
            break;

          case 'tool_start':
            if (currentThinking) {
              currentThinking.header.textContent = 'Thought process';
              const dot = currentThinking.el.querySelector('.thinking-dot');
              if (dot) dot.style.animation = 'none';
              currentThinking = null;
            }
            currentToolName = event.tool;
            currentTool = createToolBlock(event.tool);
            if (cursor) {
              contentEl.insertBefore(currentTool.el, cursor);
            } else {
              contentEl.appendChild(currentTool.el);
            }
            scrollToBottom();
            break;

          case 'block_stop':
            if (currentTool) {
              finishToolBlock(currentTool, currentToolName);
              currentTool = null;
            }
            break;

          case 'done':
            if (cursor) cursor.remove();
            if (currentTool) finishToolBlock(currentTool, currentToolName);
            if (currentThinking) {
              currentThinking.header.textContent = 'Thought process';
              const dot = currentThinking.el.querySelector('.thinking-dot');
              if (dot) dot.style.animation = 'none';
            }
            flushText();
            scrollToBottom();
            break;

          case 'error':
            if (cursor) cursor.remove();
            showError(event.message);
            const errEl = document.createElement('div');
            errEl.style.cssText = 'color:#f87171;font-size:14px;padding:8px 0';
            errEl.textContent = `Error: ${event.message}`;
            contentEl.appendChild(errEl);
            break;
        }
      }
    }
  } catch (err) {
    if (cursor) cursor.remove();
    showError(err.message || 'Connection error');
    const errEl = document.createElement('div');
    errEl.style.cssText = 'color:#f87171;font-size:14px;padding:8px 0';
    errEl.textContent = `Error: ${err.message}`;
    contentEl.appendChild(errEl);
  } finally {
    setStreaming(false);
    // Save assistant response
    const finalText = accText;
    if (finalText) {
      state.messages.push({ role: 'assistant', content: finalText });
    }
    scrollToBottom();
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

el.input.addEventListener('input', () => {
  autoResize();
  el.sendBtn.disabled = state.isStreaming || (el.input.value.trim() === '' && state.attachedFiles.length === 0);
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!el.sendBtn.disabled) {
      sendMessage(el.input.value);
    }
  }
});

el.sendBtn.addEventListener('click', () => {
  if (!state.isStreaming) {
    sendMessage(el.input.value);
  }
  // TODO: cancel on stop button click
});

el.newChatBtn.addEventListener('click', () => {
  state.messages = [];
  state.attachedFiles = [];
  el.filePreviews.innerHTML = '';
  el.filePreviews.classList.add('hidden');
  el.messages.innerHTML = '';
  el.input.value = '';
  autoResize();
  el.emptyState.classList.remove('hidden');
  el.messages.classList.add('hidden');
  el.sendBtn.disabled = true;
});

el.modelSelect.addEventListener('change', (e) => {
  state.currentModel = e.target.value;
});

// Suggestion cards
document.querySelectorAll('.suggestion-card').forEach(card => {
  card.addEventListener('click', () => {
    const prompt = card.dataset.prompt;
    el.input.value = prompt;
    autoResize();
    el.sendBtn.disabled = false;
    sendMessage(prompt);
  });
});

// Drag & drop onto main
document.getElementById('main').addEventListener('dragover', (e) => {
  e.preventDefault();
  e.currentTarget.style.outline = '2px dashed var(--accent-purple)';
});

document.getElementById('main').addEventListener('dragleave', (e) => {
  e.currentTarget.style.outline = '';
});

document.getElementById('main').addEventListener('drop', async (e) => {
  e.preventDefault();
  e.currentTarget.style.outline = '';
  const files = Array.from(e.dataTransfer.files);
  for (const file of files) {
    await uploadFile(file);
  }
});

// Paste images
el.input.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData.items);
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      const named = new File([file], `pasted-${Date.now()}.png`, { type: file.type });
      await uploadFile(named);
    }
  }
});

// Initial focus
el.input.focus();
