/* OmniAI — Frontend Application */

const API_BASE = '';

const state = {
  mode: 'chat',           // 'chat' | 'video'
  messages: [],
  attachedFiles: [],
  isStreaming: false,
  // Video studio
  videoFrames: [],        // [{file_id, timestamp_sec, frame_index}]
  videoMeta: null,        // {duration_sec, fps, width, height, filename, total_frames}
  currentTask: 'full',
  isAnalyzing: false,
};

const el = {
  // Chat
  emptyState: document.getElementById('empty-state'),
  messages: document.getElementById('messages'),
  input: document.getElementById('user-input'),
  sendBtn: document.getElementById('send-btn'),
  attachBtn: document.getElementById('attach-btn'),
  fileInput: document.getElementById('file-input'),
  filePreviews: document.getElementById('file-previews'),
  // Sidebar
  modelSelect: document.getElementById('model-select'),
  toggleSearch: document.getElementById('toggle-search'),
  toggleCode: document.getElementById('toggle-code'),
  toggleThinking: document.getElementById('toggle-thinking'),
  newChatBtn: document.getElementById('new-chat-btn'),
  chatOptions: document.getElementById('chat-options'),
  videoChatCaps: document.getElementById('chat-caps'),
  videoOptions: document.getElementById('video-options'),
  frameCount: document.getElementById('frame-count'),
  frameCountLabel: document.getElementById('frame-count-label'),
  modeBtns: document.querySelectorAll('.mode-btn'),
  micBtn: document.getElementById('mic-btn'),
  deepResearchBtn: document.getElementById('deep-research-btn'),
  deepResearchBar: document.getElementById('deep-research-bar'),
  disableDeepResearch: document.getElementById('disable-deep-research'),
  // Views
  chatView: document.getElementById('chat-view'),
  videoView: document.getElementById('video-view'),
  // Video upload
  videoUploadZone: document.getElementById('video-upload-zone'),
  videoDropInner: document.getElementById('video-drop-inner'),
  videoProgress: document.getElementById('video-progress'),
  progressTitle: document.getElementById('progress-title'),
  progressSub: document.getElementById('progress-sub'),
  progressBar: document.getElementById('progress-bar'),
  videoWorkspace: document.getElementById('video-workspace'),
  videoMeta: document.getElementById('video-meta'),
  filmstrip: document.getElementById('filmstrip'),
  analyzeBtn: document.getElementById('analyze-btn'),
  resetVideoBtn: document.getElementById('reset-video-btn'),
  videoFileInput: document.getElementById('video-file-input'),
  uploadVideoBtn: document.getElementById('upload-video-btn'),
  videoTaskBtns: document.querySelectorAll('.video-task-btn'),
  // Analysis
  analysisPlaceholder: document.getElementById('analysis-placeholder'),
  analysisContent: document.getElementById('analysis-content'),
  chapterTimeline: document.getElementById('chapter-timeline'),
  // Lightbox
  lightbox: document.getElementById('lightbox'),
  lightboxBackdrop: document.getElementById('lightbox-backdrop'),
  lightboxImg: document.getElementById('lightbox-img'),
  lightboxInfo: document.getElementById('lightbox-info'),
  lightboxClose: document.getElementById('lightbox-close'),
};

// ── Markdown ───────────────────────────────────────────────────────────────

marked.setOptions({ breaks: true, gfm: true });

const renderer = new marked.Renderer();
renderer.code = function (code, language) {
  const lang = language || 'text';
  let highlighted;
  try {
    highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang }).value
      : hljs.highlightAuto(code).value;
  } catch { highlighted = code; }
  return `<pre><div class="code-header"><span>${lang}</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div><code class="hljs">${highlighted}</code></pre>`;
};
marked.use({ renderer });

function renderMarkdown(text) { return marked.parse(text || ''); }

function copyCode(btn) {
  const code = btn.closest('pre').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────

function showToast(msg, type = 'error') {
  const toast = document.createElement('div');
  toast.className = type === 'error' ? 'error-toast' : 'success-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Mode switching ─────────────────────────────────────────────────────────

el.modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    state.mode = mode;
    el.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

    if (mode === 'chat') {
      el.chatView.classList.remove('hidden');
      el.videoView.classList.add('hidden');
      el.chatOptions.classList.remove('hidden');
      el.videoChatCaps.classList.remove('hidden');
      el.videoOptions.classList.add('hidden');
    } else {
      el.chatView.classList.add('hidden');
      el.videoView.classList.remove('hidden');
      el.chatOptions.classList.add('hidden');
      el.videoChatCaps.classList.add('hidden');
      el.videoOptions.classList.remove('hidden');
    }
  });
});

// ── Video task buttons ─────────────────────────────────────────────────────

el.videoTaskBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    el.videoTaskBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentTask = btn.dataset.task;
  });
});

// ── Frame count slider ─────────────────────────────────────────────────────

el.frameCount.addEventListener('input', () => {
  el.frameCountLabel.textContent = `${el.frameCount.value} frames`;
});

// ── Video upload ───────────────────────────────────────────────────────────

el.uploadVideoBtn.addEventListener('click', () => el.videoFileInput.click());

el.videoFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await processVideoFile(file);
  e.target.value = '';
});

// Drag & drop on video drop zone
el.videoDropInner.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.videoDropInner.classList.add('drag-over');
});
el.videoDropInner.addEventListener('dragleave', () => {
  el.videoDropInner.classList.remove('drag-over');
});
el.videoDropInner.addEventListener('drop', async (e) => {
  e.preventDefault();
  el.videoDropInner.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) await processVideoFile(file);
});

// Also allow drop anywhere in video view
el.videoView.addEventListener('dragover', (e) => { e.preventDefault(); });
el.videoView.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (state.videoFrames.length === 0) {
    const file = e.dataTransfer.files[0];
    if (file) await processVideoFile(file);
  }
});

async function processVideoFile(file) {
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mpeg', 'mpg', '3gp', 'flv', 'm4v'];
  const ext = file.name.split('.').pop().toLowerCase();
  if (!file.type.startsWith('video/') && !videoExts.includes(ext)) {
    showToast('Please upload a video file (MP4, MOV, AVI, MKV, WEBM)');
    return;
  }

  // Show progress
  el.videoUploadZone.classList.add('hidden');
  el.videoProgress.classList.remove('hidden');
  el.progressBar.style.width = '0%';
  el.progressTitle.textContent = 'Uploading video…';
  el.progressSub.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;

  // Fake progress animation while uploading
  let prog = 0;
  const progInterval = setInterval(() => {
    prog = Math.min(prog + 2, 65);
    el.progressBar.style.width = prog + '%';
  }, 100);

  const formData = new FormData();
  formData.append('file', file);
  formData.append('max_frames', el.frameCount.value);

  try {
    el.progressTitle.textContent = 'Extracting frames…';
    el.progressSub.textContent = 'Analyzing video structure and sampling key frames';

    const resp = await fetch(`${API_BASE}/api/extract-video-frames`, {
      method: 'POST',
      body: formData,
    });

    clearInterval(progInterval);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || 'Frame extraction failed');
    }

    el.progressBar.style.width = '80%';
    el.progressTitle.textContent = 'Processing frames…';
    el.progressSub.textContent = 'Uploading to AI analysis pipeline';

    const data = await resp.json();
    state.videoFrames = data.frames;
    state.videoMeta = {
      duration_sec: data.duration_sec,
      fps: data.fps,
      total_frames: data.total_frames,
      width: data.width,
      height: data.height,
      filename: data.filename,
    };

    el.progressBar.style.width = '100%';
    el.progressTitle.textContent = 'Ready!';
    el.progressSub.textContent = `${data.frames.length} frames extracted`;

    await new Promise(r => setTimeout(r, 600));

    // Show workspace
    el.videoProgress.classList.add('hidden');
    el.videoWorkspace.classList.remove('hidden');
    renderWorkspace();

  } catch (err) {
    clearInterval(progInterval);
    el.videoProgress.classList.add('hidden');
    el.videoUploadZone.classList.remove('hidden');
    showToast(err.message || 'Video processing failed');
  }
}

function renderWorkspace() {
  const m = state.videoMeta;

  // Meta badges
  el.videoMeta.innerHTML = `
    <span class="video-meta-badge">📹 ${m.filename}</span>
    <span class="video-meta-badge">⏱ ${formatDuration(m.duration_sec)}</span>
    <span class="video-meta-badge">📐 ${m.width}×${m.height}</span>
    <span class="video-meta-badge">🎞 ${m.fps.toFixed(1)} fps</span>
    <span class="video-meta-badge">🖼 ${state.videoFrames.length} frames</span>
  `;

  // Filmstrip — we show thumbnails using blob URLs from cached data
  // Since frames are on Files API we show placeholder thumbnails with timestamps
  el.filmstrip.innerHTML = '';
  state.videoFrames.forEach((frame, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'frame-thumb';
    thumb.dataset.index = i;
    thumb.innerHTML = `
      <div style="width:100%;height:100%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-muted)">
        Frame ${i + 1}
      </div>
      <span class="frame-ts">${formatDuration(frame.timestamp_sec)}</span>
    `;
    thumb.addEventListener('click', () => openLightboxFrame(i));
    el.filmstrip.appendChild(thumb);
  });
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function openLightboxFrame(index) {
  const frame = state.videoFrames[index];
  // We can't show the actual image (it's on Files API), but show frame info
  el.lightboxImg.src = '';
  el.lightboxImg.alt = `Frame ${index + 1} @ ${formatDuration(frame.timestamp_sec)}`;
  el.lightboxImg.style.display = 'none';
  const infoEl = document.createElement('div');
  el.lightboxInfo.innerHTML = `Frame ${index + 1} · ${formatDuration(frame.timestamp_sec)} · File ID: ${frame.file_id}`;
  el.lightbox.classList.remove('hidden');
}

el.lightboxBackdrop.addEventListener('click', closeLightbox);
el.lightboxClose.addEventListener('click', closeLightbox);
function closeLightbox() { el.lightbox.classList.add('hidden'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

el.resetVideoBtn.addEventListener('click', resetVideoStudio);

function resetVideoStudio() {
  // Delete uploaded frames from server
  state.videoFrames.forEach(f => {
    fetch(`${API_BASE}/api/files/${f.file_id}`, { method: 'DELETE' }).catch(() => {});
  });
  state.videoFrames = [];
  state.videoMeta = null;
  el.videoWorkspace.classList.add('hidden');
  el.videoUploadZone.classList.remove('hidden');
  el.filmstrip.innerHTML = '';
  el.analysisContent.innerHTML = '';
  el.analysisContent.classList.add('hidden');
  el.analysisPlaceholder.classList.remove('hidden');
  el.chapterTimeline.classList.add('hidden');
}

// ── Video Analysis ─────────────────────────────────────────────────────────

el.analyzeBtn.addEventListener('click', startVideoAnalysis);

async function startVideoAnalysis() {
  if (state.isAnalyzing || !state.videoFrames.length) return;
  state.isAnalyzing = true;

  el.analysisPlaceholder.classList.add('hidden');
  el.analysisContent.classList.remove('hidden');
  el.analysisContent.innerHTML = '';
  el.chapterTimeline.classList.add('hidden');
  el.analyzeBtn.disabled = true;
  el.analyzeBtn.innerHTML = `<div class="tool-spinner" style="width:14px;height:14px;border-color:rgba(255,255,255,0.3);border-top-color:white"></div> Analyzing…`;

  const formData = new FormData();
  formData.append('frame_ids', JSON.stringify(state.videoFrames.map(f => f.file_id)));
  formData.append('timestamps', JSON.stringify(state.videoFrames.map(f => f.timestamp_sec)));
  formData.append('task', state.currentTask);
  formData.append('model', el.modelSelect.value);

  let accText = '';
  let thinkingEl = null;
  let textEl = null;
  let cursor = null;

  try {
    const resp = await fetch(`${API_BASE}/api/analyze-video`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || 'Analysis failed');
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
        try { event = JSON.parse(jsonStr); } catch { continue; }

        switch (event.type) {
          case 'thinking_start':
            thinkingEl = document.createElement('div');
            thinkingEl.className = 'thinking-block';
            thinkingEl.innerHTML = `
              <div class="thinking-header" onclick="toggleThinking(this)">
                <div class="thinking-dot"></div><span>Analyzing…</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
              <div class="thinking-content"></div>`;
            el.analysisContent.appendChild(thinkingEl);
            break;

          case 'thinking':
            if (thinkingEl) {
              const tc = thinkingEl.querySelector('.thinking-content');
              tc.textContent = (tc.textContent || '') + event.text;
            }
            break;

          case 'text_start':
            if (thinkingEl) {
              thinkingEl.querySelector('.thinking-header span').textContent = 'AI Reasoning';
              const dot = thinkingEl.querySelector('.thinking-dot');
              if (dot) dot.style.animation = 'none';
              thinkingEl = null;
            }
            textEl = document.createElement('div');
            textEl.className = 'analysis-content';
            cursor = document.createElement('span');
            cursor.className = 'streaming-cursor';
            el.analysisContent.appendChild(textEl);
            el.analysisContent.appendChild(cursor);
            break;

          case 'text':
            accText += event.text;
            if (textEl) {
              textEl.innerHTML = renderMarkdown(accText);
            }
            el.analysisContent.scrollTop = el.analysisContent.scrollHeight;
            break;

          case 'block_stop':
            break;

          case 'done':
            if (cursor) cursor.remove();
            if (textEl) {
              textEl.innerHTML = renderMarkdown(accText);
              textEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
            }
            // If chapters task, parse and render timeline
            if (state.currentTask === 'chapters' && accText) {
              parseAndRenderChapters(accText);
            }
            break;

          case 'error':
            if (cursor) cursor.remove();
            showToast(event.message);
            break;
        }
      }
    }

  } catch (err) {
    showToast(err.message || 'Analysis failed');
    el.analysisContent.innerHTML += `<p style="color:#f87171">Error: ${err.message}</p>`;
  } finally {
    state.isAnalyzing = false;
    el.analyzeBtn.disabled = false;
    el.analyzeBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Analyze`;
  }
}

function parseAndRenderChapters(text) {
  const lines = text.split('\n');
  const chapters = [];
  let inChapters = false;

  for (const line of lines) {
    if (line.trim().startsWith('CHAPTERS:')) { inChapters = true; continue; }
    if (inChapters) {
      const match = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–]\s*(.+)/);
      if (match) {
        chapters.push({ time: match[1], title: match[2].trim() });
      } else if (line.trim() === '' && chapters.length > 0) {
        inChapters = false;
      }
    }
  }

  if (!chapters.length) return;

  el.chapterTimeline.classList.remove('hidden');
  el.chapterTimeline.innerHTML = `
    <div class="chapter-label">📍 Chapter Markers (${chapters.length})</div>
    <div class="chapter-items">
      ${chapters.map((c, i) => `
        <div class="chapter-item">
          <span class="chapter-ts">${c.time}</span>
          <span class="chapter-name">${i + 1}. ${c.title}</span>
        </div>`).join('')}
    </div>
  `;
}

// ── Chat: file upload ──────────────────────────────────────────────────────

el.attachBtn.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', async (e) => {
  for (const file of Array.from(e.target.files)) await uploadChatFile(file);
  e.target.value = '';
});

async function uploadChatFile(file) {
  const indicator = document.createElement('div');
  indicator.className = 'file-preview-item';
  indicator.innerHTML = `<div class="tool-spinner"></div><span class="file-name">Uploading ${file.name}…</span>`;
  el.filePreviews.classList.remove('hidden');
  el.filePreviews.appendChild(indicator);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
    if (!resp.ok) { const err = await resp.json(); throw new Error(err.detail || 'Upload failed'); }
    const data = await resp.json();
    state.attachedFiles.push({ ...data, originalFile: file });
    renderChatFilePreview(data, file);
  } catch (err) {
    showToast(err.message);
  } finally {
    indicator.remove();
    if (!el.filePreviews.children.length) el.filePreviews.classList.add('hidden');
  }
}

function getFileIcon(mediaType) {
  if (mediaType.startsWith('image/')) return '🖼️';
  if (mediaType === 'application/pdf') return '📄';
  if (mediaType.startsWith('text/')) return '📝';
  return '📎';
}

function renderChatFilePreview(fileData, originalFile) {
  const item = document.createElement('div');
  item.className = 'file-preview-item';
  item.dataset.fileId = fileData.file_id;

  let preview = fileData.media_type.startsWith('image/')
    ? `<img src="${URL.createObjectURL(originalFile)}" alt="${fileData.filename}" />`
    : `<span style="font-size:20px">${getFileIcon(fileData.media_type)}</span>`;

  item.innerHTML = `${preview}<span class="file-name">${fileData.filename}</span><button class="remove-file" title="Remove">✕</button>`;
  item.querySelector('.remove-file').addEventListener('click', () => {
    state.attachedFiles = state.attachedFiles.filter(f => f.file_id !== fileData.file_id);
    item.remove();
    if (!el.filePreviews.children.length) el.filePreviews.classList.add('hidden');
    fetch(`${API_BASE}/api/files/${fileData.file_id}`, { method: 'DELETE' }).catch(() => {});
  });

  el.filePreviews.classList.remove('hidden');
  el.filePreviews.appendChild(item);
}

// ── Chat: send ─────────────────────────────────────────────────────────────

function setStreaming(active) {
  state.isStreaming = active;
  el.sendBtn.disabled = active || (el.input.value.trim() === '' && !state.attachedFiles.length);
  el.input.disabled = active;
  el.sendBtn.innerHTML = active
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
    : `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
}

function autoResize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
}

function scrollToBottom() { el.messages.scrollTop = el.messages.scrollHeight; }

function showChat() {
  el.emptyState.classList.add('hidden');
  el.messages.classList.remove('hidden');
}

function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function toggleThinking(header) {
  header.classList.toggle('collapsed');
  header.parentElement.querySelector('.thinking-content').classList.toggle('hidden');
}

async function sendMessage(text) {
  if (!text.trim() && !state.attachedFiles.length) return;
  if (state.isStreaming) return;

  showChat();

  const contentParts = [];
  for (const f of state.attachedFiles) {
    contentParts.push(f.media_type.startsWith('image/')
      ? { type: 'image', source: { type: 'file', file_id: f.file_id } }
      : { type: 'document', source: { type: 'file', file_id: f.file_id }, title: f.filename });
  }
  if (text.trim()) contentParts.push({ type: 'text', text: text.trim() });

  const userContent = contentParts.length === 1 && contentParts[0].type === 'text' ? text.trim() : contentParts;
  state.messages.push({ role: 'user', content: userContent });

  // Render user bubble
  const userDiv = document.createElement('div');
  userDiv.className = 'message message-user';
  const filesHtml = state.attachedFiles.map(f => `<div class="file-tag"><span>${getFileIcon(f.media_type)}</span><span>${f.filename}</span></div>`).join('');
  userDiv.innerHTML = `<div class="bubble">${filesHtml ? `<div class="message-files">${filesHtml}</div>` : ''}${escapeHtml(text.trim())}</div>`;
  el.messages.appendChild(userDiv);

  state.attachedFiles = [];
  el.filePreviews.innerHTML = '';
  el.filePreviews.classList.add('hidden');
  el.input.value = '';
  autoResize();
  el.sendBtn.disabled = true;
  scrollToBottom();
  setStreaming(true);

  // Assistant container
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message message-assistant';
  msgDiv.innerHTML = `
    <div class="assistant-header">
      <div class="assistant-avatar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 12 C6 8,12 4,18 8 C18 16,12 20,6 16 Z" fill="white" opacity="0.9"/></svg></div>
      <span class="assistant-name">OmniAI</span>
    </div>
    <div class="assistant-content"></div>`;
  el.messages.appendChild(msgDiv);
  const contentEl = msgDiv.querySelector('.assistant-content');

  let currentThinking = null, currentTool = null, currentText = null;
  let currentToolName = '', accThinking = '', accText = '';
  let cursor = null;

  function ensureText() {
    if (!currentText) {
      currentText = document.createElement('div');
      currentText.className = 'text-content';
      cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      contentEl.appendChild(currentText);
      contentEl.appendChild(cursor);
    }
  }

  const payload = {
    messages: state.messages.map(m => ({ role: m.role, content: m.content })),
    model: el.modelSelect.value,
    enable_thinking: el.toggleThinking.checked,
    enable_web_search: el.toggleSearch.checked,
    enable_code_execution: el.toggleCode.checked,
    ...(deepResearchMode && { system: DEEP_RESEARCH_SYSTEM }),
  };

  try {
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

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
        try { event = JSON.parse(jsonStr); } catch { continue; }

        switch (event.type) {
          case 'thinking_start':
            if (currentTool) { finishTool(currentTool, currentToolName); currentTool = null; }
            accThinking = '';
            currentThinking = { el: null, content: null };
            const tb = document.createElement('div');
            tb.className = 'thinking-block';
            tb.innerHTML = `<div class="thinking-header" onclick="toggleThinking(this)"><div class="thinking-dot"></div><span>Thinking…</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div><div class="thinking-content"></div>`;
            if (cursor) contentEl.insertBefore(tb, cursor); else contentEl.appendChild(tb);
            currentThinking.el = tb;
            currentThinking.content = tb.querySelector('.thinking-content');
            currentThinking.header = tb.querySelector('.thinking-header span');
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
              currentThinking.el.querySelector('.thinking-dot')?.style.setProperty('animation', 'none');
              currentThinking = null;
            }
            if (currentTool) { finishTool(currentTool, currentToolName); currentTool = null; }
            ensureText();
            break;

          case 'text':
            accText += event.text;
            if (currentText) { currentText.innerHTML = renderMarkdown(accText); }
            scrollToBottom();
            break;

          case 'tool_start':
            if (currentThinking) {
              currentThinking.header.textContent = 'Thought process';
              currentThinking.el.querySelector('.thinking-dot')?.style.setProperty('animation', 'none');
              currentThinking = null;
            }
            currentToolName = event.tool;
            const toolDiv = document.createElement('div');
            toolDiv.className = 'tool-block';
            const label = event.tool === 'web_search' ? 'Web Search' : event.tool === 'code_execution' ? 'Code Execution' : event.tool;
            toolDiv.innerHTML = `<div class="tool-header"><div class="tool-spinner"></div><span class="tool-badge">${label}</span><span style="color:var(--text-muted);font-size:12px">Running…</span></div>`;
            if (cursor) contentEl.insertBefore(toolDiv, cursor); else contentEl.appendChild(toolDiv);
            currentTool = toolDiv;
            scrollToBottom();
            break;

          case 'block_stop':
            if (currentTool) { finishTool(currentTool, currentToolName); currentTool = null; }
            break;

          case 'done':
            if (cursor) cursor.remove();
            if (currentTool) finishTool(currentTool, currentToolName);
            if (currentThinking) {
              currentThinking.header.textContent = 'Thought process';
              currentThinking.el.querySelector('.thinking-dot')?.style.setProperty('animation', 'none');
            }
            if (currentText) {
              currentText.innerHTML = renderMarkdown(accText);
              currentText.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
            }
            scrollToBottom();
            break;

          case 'error':
            if (cursor) cursor.remove();
            showToast(event.message);
            contentEl.innerHTML += `<div style="color:#f87171;font-size:14px;padding:8px 0">Error: ${event.message}</div>`;
            break;
        }
      }
    }
  } catch (err) {
    if (cursor) cursor.remove();
    showToast(err.message || 'Connection error');
    contentEl.innerHTML += `<div style="color:#f87171;font-size:14px;padding:8px 0">Error: ${err.message}</div>`;
  } finally {
    setStreaming(false);
    if (accText) state.messages.push({ role: 'assistant', content: accText });
    scrollToBottom();
  }
}

function finishTool(toolDiv, toolName) {
  const label = toolName === 'web_search' ? 'Web Search' : toolName === 'code_execution' ? 'Code Execution' : toolName;
  const check = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
  toolDiv.querySelector('.tool-header').innerHTML = `${check}<span class="tool-badge">${label}</span><span style="color:var(--text-muted);font-size:12px">Complete</span>`;
}

// ── Events ─────────────────────────────────────────────────────────────────

el.input.addEventListener('input', () => {
  autoResize();
  el.sendBtn.disabled = state.isStreaming || (el.input.value.trim() === '' && !state.attachedFiles.length);
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!el.sendBtn.disabled) sendMessage(el.input.value);
  }
});

el.sendBtn.addEventListener('click', () => {
  if (!state.isStreaming) sendMessage(el.input.value);
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

document.querySelectorAll('.suggestion-card').forEach(card => {
  card.addEventListener('click', () => {
    const prompt = card.dataset.prompt;
    el.input.value = prompt;
    autoResize();
    el.sendBtn.disabled = false;
    sendMessage(prompt);
  });
});

// Paste images into chat
el.input.addEventListener('paste', async (e) => {
  for (const item of Array.from(e.clipboardData.items)) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      await uploadChatFile(new File([file], `pasted-${Date.now()}.png`, { type: file.type }));
    }
  }
});

// Drag & drop into chat main area
document.getElementById('main').addEventListener('dragover', (e) => { e.preventDefault(); });
document.getElementById('main').addEventListener('drop', async (e) => {
  if (state.mode !== 'chat') return;
  e.preventDefault();
  for (const file of Array.from(e.dataTransfer.files)) await uploadChatFile(file);
});

// ── Voice Input (Web Speech API) ────────────────────────────────────────────

let recognition = null;
let isRecording = false;

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    el.micBtn.title = 'Voice input not supported in this browser';
    el.micBtn.style.opacity = '0.4';
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'he-IL'; // Start with Hebrew, auto-detect

  rec.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t;
      else interim += t;
    }
    if (final) {
      el.input.value = (el.input.value + ' ' + final).trim();
      autoResize();
      el.sendBtn.disabled = false;
    }
    // Show interim as placeholder-style text
    if (interim) {
      el.input.placeholder = interim + '…';
    }
  };

  rec.onerror = (e) => {
    if (e.error !== 'no-speech') showToast(`Voice error: ${e.error}`, 'error');
    stopRecording();
  };

  rec.onend = () => {
    if (isRecording) rec.start(); // Auto-restart for continuous
  };

  return rec;
}

function startRecording() {
  if (!recognition) recognition = initSpeechRecognition();
  if (!recognition) return;

  isRecording = true;
  el.micBtn.classList.add('recording');
  el.micBtn.title = 'Click to stop recording';
  el.input.placeholder = 'Listening…';
  recognition.start();
}

function stopRecording() {
  isRecording = false;
  el.micBtn.classList.remove('recording');
  el.micBtn.title = 'Voice input';
  el.input.placeholder = 'Ask OmniAI anything… (Shift+Enter = new line)';
  if (recognition) recognition.stop();
}

el.micBtn.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});

// ── Deep Research Mode ──────────────────────────────────────────────────────

let deepResearchMode = false;

const DEEP_RESEARCH_SYSTEM = (
  "You are OmniAI in Deep Research mode. You are an expert researcher tasked with producing "
  "comprehensive, well-sourced research reports. For any question:\n\n"
  "1. Use web_search MULTIPLE TIMES (at least 3-5 searches) to gather information from different angles\n"
  "2. Search for: main topic, recent developments, expert opinions, statistics/data, counterarguments\n"
  "3. Synthesize all findings into a structured report with:\n"
  "   - Executive Summary (3-5 bullets)\n"
  "   - Key Findings (with sources)\n"
  "   - Detailed Analysis (multiple sections)\n"
  "   - Data & Statistics table where applicable\n"
  "   - Expert Perspectives\n"
  "   - Conclusion & Recommendations\n"
  "   - Sources (all URLs you found)\n\n"
  "Be thorough, objective, and cite specific sources. Think like a senior analyst at a top research firm."
);

el.deepResearchBtn.addEventListener('click', () => {
  deepResearchMode = !deepResearchMode;
  el.deepResearchBtn.classList.toggle('active-dr', deepResearchMode);
  el.deepResearchBar.classList.toggle('hidden', !deepResearchMode);
  if (deepResearchMode) {
    el.toggleSearch.checked = true; // Force web search on
    showToast('Deep Research mode activated', 'success');
  }
});

el.disableDeepResearch.addEventListener('click', () => {
  deepResearchMode = false;
  el.deepResearchBtn.classList.remove('active-dr');
  el.deepResearchBar.classList.add('hidden');
});

el.input.focus();
