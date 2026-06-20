/* OmniAI — Full Application */
'use strict';

const API = '';

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  mode: 'chat',
  messages: [],
  attachedFiles: [],
  streaming: false,
  deepResearch: false,
  // Video studio
  videoFile: null,
  videoBlobUrl: null,
  frames: [],       // [{file_id, timestamp_sec, frame_index}]
  meta: null,       // {duration_sec, fps, width, height, filename, ...}
  scenes: [],       // [{timestamp_sec, timestamp, correlation}]
  energy: [],       // [{t, e}]
  editData: null,   // parsed AI edit JSON
  analyzing: false,
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  // Chat
  emptyState: $('empty-state'), messages: $('messages'),
  input: $('user-input'), sendBtn: $('send-btn'),
  attachBtn: $('attach-btn'), fileInput: $('file-input'),
  filePreviews: $('file-previews'),
  micBtn: $('mic-btn'), drBtn: $('dr-btn'), drBar: $('dr-bar'), drOff: $('dr-off'),
  // Sidebar
  modelSel: $('model-select'), tSearch: $('t-search'), tCode: $('t-code'), tThink: $('t-think'),
  newChatBtn: $('new-chat-btn'),
  chatSb: $('chat-sidebar'), videoSb: $('video-sidebar'),
  modeBtns: document.querySelectorAll('.mode-btn'),
  frameCount: $('frame-count'), frameCountLabel: $('frame-count-label'),
  sceneThresh: $('scene-thresh'), sceneThreshLabel: $('scene-thresh-label'),
  videoModelSel: $('video-model-select'),
  // Views
  chatView: $('chat-view'), videoView: $('video-view'),
  // Video upload
  vUpload: $('v-upload'), vDrop: $('v-drop'),
  vPickBtn: $('v-pick-btn'), vFileInput: $('v-file-input'),
  vProcessing: $('v-processing'),
  procTitle: $('proc-title'), procSub: $('proc-sub'), progBar: $('prog-bar'),
  stepUpload: $('step-upload'), stepFrames: $('step-frames'),
  stepScenes: $('step-scenes'), stepReady: $('step-ready'),
  // Studio
  vStudio: $('v-studio'), vMeta: $('v-meta'),
  vPlayer: $('v-player'),
  timelineCanvas: $('timeline-canvas'), timelineMarkers: $('timeline-markers'), timelineCursor: $('timeline-cursor'),
  filmstrip: $('filmstrip'),
  aiEditBtn: $('ai-edit-btn'), vResetBtn: $('v-reset-btn'),
  // Results
  resultsTabs: document.querySelectorAll('.rtab'),
  aiPlaceholder: $('ai-placeholder'), overviewContent: $('tab-overview-content'),
  tabOverview: $('tab-overview'), tabCuts: $('tab-cuts'), tabScenes: $('tab-scenes'),
  tabColor: $('tab-color'), tabCaptions: $('tab-captions'),
  tabFfmpeg: $('tab-ffmpeg'), tabShorts: $('tab-shorts'), tabExport: $('tab-export'),
};

// ── Markdown ───────────────────────────────────────────────────────────────
const mdRenderer = new marked.Renderer();
mdRenderer.code = (code, lang) => {
  const l = lang || 'text';
  let hi;
  try { hi = l && hljs.getLanguage(l) ? hljs.highlight(code, {language: l}).value : hljs.highlightAuto(code).value; }
  catch { hi = code; }
  return `<pre><div class="code-header"><span>${l}</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div><code class="hljs">${hi}</code></pre>`;
};
marked.use({renderer: mdRenderer, breaks: true, gfm: true});
const md = t => marked.parse(t || '');
function copyCode(btn) {
  navigator.clipboard.writeText(btn.closest('pre').querySelector('code').textContent).then(() => {
    const o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = o; }, 2000);
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Mode switch ─────────────────────────────────────────────────────────────
el.modeBtns.forEach(btn => btn.addEventListener('click', () => {
  const mode = btn.dataset.mode;
  S.mode = mode;
  el.modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  el.chatView.classList.toggle('hidden', mode !== 'chat');
  el.videoView.classList.toggle('hidden', mode !== 'video');
  el.chatSb.classList.toggle('hidden', mode !== 'chat');
  el.videoSb.classList.toggle('hidden', mode !== 'video');
}));

// ── Sliders ────────────────────────────────────────────────────────────────
el.frameCount.addEventListener('input', () => { el.frameCountLabel.textContent = `${el.frameCount.value} frames`; });
el.sceneThresh.addEventListener('input', () => { el.sceneThreshLabel.textContent = `${el.sceneThresh.value}% sensitivity`; });

// ── Voice input ─────────────────────────────────────────────────────────────
let recognition = null, isRecording = false;
function initRecog() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { el.micBtn.style.opacity = '.35'; el.micBtn.title = 'Not supported'; return null; }
  const r = new SR();
  r.continuous = true; r.interimResults = true; r.lang = 'he-IL';
  r.onresult = e => {
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++)
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
    if (final) { el.input.value = (el.input.value + ' ' + final).trim(); autoResize(); el.sendBtn.disabled = false; }
  };
  r.onerror = () => stopRecording();
  r.onend = () => { if (isRecording) r.start(); };
  return r;
}
function startRecording() {
  if (!recognition) recognition = initRecog();
  if (!recognition) return;
  isRecording = true; el.micBtn.classList.add('recording'); el.input.placeholder = 'Listening…';
  recognition.start();
}
function stopRecording() {
  isRecording = false; el.micBtn.classList.remove('recording'); el.input.placeholder = 'Ask OmniAI anything…';
  if (recognition) recognition.stop();
}
el.micBtn.addEventListener('click', () => isRecording ? stopRecording() : startRecording());

// ── Deep Research ───────────────────────────────────────────────────────────
const DR_SYSTEM = `You are OmniAI in Deep Research mode. For any question, you MUST:
1. Use web_search at least 4-5 times from different angles (main topic, recent news, expert opinions, statistics, counterarguments)
2. Synthesize all findings into a structured report:
   **Executive Summary** (3-5 bullets)
   **Key Findings** (sourced)
   **Detailed Analysis** (multiple H2 sections)
   **Data & Statistics** (table)
   **Expert Perspectives**
   **Conclusion & Recommendations**
   **All Sources** (every URL found)
Be thorough, objective, and cite everything. Think like a senior analyst at McKinsey.`;

el.drBtn.addEventListener('click', () => {
  S.deepResearch = !S.deepResearch;
  el.drBtn.classList.toggle('active', S.deepResearch);
  el.drBar.classList.toggle('hidden', !S.deepResearch);
  if (S.deepResearch) { el.tSearch.checked = true; toast('Deep Research activated', 'info'); }
});
el.drOff.addEventListener('click', () => { S.deepResearch = false; el.drBtn.classList.remove('active'); el.drBar.classList.add('hidden'); });

// ── Chat file upload ────────────────────────────────────────────────────────
el.attachBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', async e => {
  for (const f of e.target.files) await uploadChatFile(f);
  e.target.value = '';
});
async function uploadChatFile(file) {
  const item = document.createElement('div');
  item.className = 'fp-item';
  item.innerHTML = `<div class="tool-spinner"></div><span class="fp-name">Uploading ${file.name}…</span>`;
  el.filePreviews.classList.remove('hidden');
  el.filePreviews.appendChild(item);
  const fd = new FormData(); fd.append('file', file);
  try {
    const r = await fetch(`${API}/api/upload`, {method: 'POST', body: fd});
    if (!r.ok) { const e = await r.json(); throw new Error(e.detail || 'Upload failed'); }
    const d = await r.json();
    S.attachedFiles.push({...d, originalFile: file});
    item.remove();
    renderFilePreview(d, file);
  } catch(e) { item.remove(); toast(e.message, 'error'); }
  if (!el.filePreviews.children.length) el.filePreviews.classList.add('hidden');
}
function fileIcon(t) { return t.startsWith('image/') ? '🖼' : t === 'application/pdf' ? '📄' : '📝'; }
function renderFilePreview(d, orig) {
  const item = document.createElement('div');
  item.className = 'fp-item'; item.dataset.fid = d.file_id;
  const prev = d.media_type.startsWith('image/')
    ? `<img src="${URL.createObjectURL(orig)}" alt=""/>` : `<span style="font-size:18px">${fileIcon(d.media_type)}</span>`;
  item.innerHTML = `${prev}<span class="fp-name">${d.filename}</span><button class="fp-rm">✕</button>`;
  item.querySelector('.fp-rm').onclick = () => {
    S.attachedFiles = S.attachedFiles.filter(f => f.file_id !== d.file_id);
    item.remove();
    if (!el.filePreviews.children.length) el.filePreviews.classList.add('hidden');
    fetch(`${API}/api/files/${d.file_id}`, {method: 'DELETE'}).catch(() => {});
  };
  el.filePreviews.classList.remove('hidden');
  el.filePreviews.appendChild(item);
}

// ── Chat send ───────────────────────────────────────────────────────────────
function setStreaming(v) {
  S.streaming = v;
  el.sendBtn.disabled = v || (el.input.value.trim() === '' && !S.attachedFiles.length);
  el.input.disabled = v;
  el.sendBtn.innerHTML = v
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
}
function autoResize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px';
}
function scrollDown() { el.messages.scrollTop = el.messages.scrollHeight; }
function showChat() { el.emptyState.classList.add('hidden'); el.messages.classList.remove('hidden'); }
function esc(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function toggleThinking(h) {
  h.classList.toggle('collapsed');
  h.parentElement.querySelector('.thinking-content').classList.toggle('hidden');
}

async function sendMessage(text) {
  if (!text.trim() && !S.attachedFiles.length) return;
  if (S.streaming) return;
  showChat();

  const parts = [];
  for (const f of S.attachedFiles)
    parts.push(f.media_type.startsWith('image/')
      ? {type:'image',source:{type:'file',file_id:f.file_id}}
      : {type:'document',source:{type:'file',file_id:f.file_id},title:f.filename});
  if (text.trim()) parts.push({type:'text',text:text.trim()});

  const userContent = parts.length === 1 && parts[0].type === 'text' ? text.trim() : parts;
  S.messages.push({role:'user',content:userContent});

  // Render user
  const ud = document.createElement('div');
  ud.className = 'message message-user';
  const fhtml = S.attachedFiles.map(f=>`<div class="file-tag">${fileIcon(f.media_type)} ${f.filename}</div>`).join('');
  ud.innerHTML = `<div class="bubble">${fhtml?`<div class="message-files">${fhtml}</div>`:''}<span>${esc(text.trim())}</span></div>`;
  el.messages.appendChild(ud);

  S.attachedFiles = []; el.filePreviews.innerHTML = ''; el.filePreviews.classList.add('hidden');
  el.input.value = ''; autoResize(); scrollDown();
  setStreaming(true);

  // Assistant container
  const ad = document.createElement('div'); ad.className = 'message message-assistant';
  ad.innerHTML = `<div class="assistant-header"><div class="assistant-avatar"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M6 12C6 8 12 4 18 8C18 16 12 20 6 16Z" fill="white" opacity=".9"/></svg></div><span class="assistant-name">OmniAI</span></div><div class="assistant-content"></div>`;
  el.messages.appendChild(ad);
  const cont = ad.querySelector('.assistant-content');

  let thinkEl=null, toolEl=null, textEl=null, cursor=null;
  let accThink='', accText='', toolName='';

  function ensureText() {
    if (!textEl) {
      textEl = document.createElement('div'); textEl.className = 'text-content';
      cursor = document.createElement('span'); cursor.className = 'streaming-cursor';
      cont.appendChild(textEl); cont.appendChild(cursor);
    }
  }
  function finishTool(div, name) {
    const label = name==='web_search'?'Web Search':name==='code_execution'?'Code Execution':name;
    div.querySelector('.tool-header').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span class="tool-badge">${label}</span><span style="color:var(--text3);font-size:11px">Done</span>`;
  }

  const payload = {
    messages: S.messages.map(m=>({role:m.role,content:m.content})),
    model: el.modelSel.value,
    enable_thinking: el.tThink.checked,
    enable_web_search: el.tSearch.checked,
    enable_code_execution: el.tCode.checked,
    ...(S.deepResearch && {system: DR_SYSTEM}),
  };

  try {
    const resp = await fetch(`${API}/api/chat`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';

    while(true) {
      const {done,value} = await reader.read(); if (done) break;
      buf += dec.decode(value, {stream:true});
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        switch(ev.type) {
          case 'thinking_start': {
            if (toolEl) { finishTool(toolEl,toolName); toolEl=null; }
            accThink='';
            const tb = document.createElement('div'); tb.className='thinking-block';
            tb.innerHTML=`<div class="thinking-header" onclick="toggleThinking(this)"><div class="thinking-dot"></div><span>Thinking…</span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div><div class="thinking-content"></div>`;
            if(cursor) cont.insertBefore(tb,cursor); else cont.appendChild(tb);
            thinkEl = {el:tb, content:tb.querySelector('.thinking-content'), hSpan:tb.querySelector('.thinking-header span')};
            break;
          }
          case 'thinking':
            if(thinkEl) { accThink+=ev.text; thinkEl.content.textContent=accThink; thinkEl.content.scrollTop=thinkEl.content.scrollHeight; }
            break;
          case 'text_start':
            if(thinkEl) { thinkEl.hSpan.textContent='Thought process'; thinkEl.el.querySelector('.thinking-dot')?.style.setProperty('animation','none'); thinkEl=null; }
            if(toolEl) { finishTool(toolEl,toolName); toolEl=null; }
            ensureText(); break;
          case 'text':
            accText+=ev.text;
            if(textEl) textEl.innerHTML=md(accText);
            scrollDown(); break;
          case 'tool_start': {
            if(thinkEl) { thinkEl.hSpan.textContent='Thought process'; thinkEl.el.querySelector('.thinking-dot')?.style.setProperty('animation','none'); thinkEl=null; }
            toolName=ev.tool;
            const label=ev.tool==='web_search'?'Web Search':ev.tool==='code_execution'?'Code Execution':ev.tool;
            const td=document.createElement('div'); td.className='tool-block';
            td.innerHTML=`<div class="tool-header"><div class="tool-spinner"></div><span class="tool-badge">${label}</span><span style="color:var(--text3);font-size:11px">Running…</span></div>`;
            if(cursor) cont.insertBefore(td,cursor); else cont.appendChild(td);
            toolEl=td; scrollDown(); break;
          }
          case 'block_stop': if(toolEl){finishTool(toolEl,toolName);toolEl=null;} break;
          case 'done':
            if(cursor) cursor.remove();
            if(toolEl) finishTool(toolEl,toolName);
            if(thinkEl) { thinkEl.hSpan.textContent='Thought process'; thinkEl.el.querySelector('.thinking-dot')?.style.setProperty('animation','none'); }
            if(textEl) { textEl.innerHTML=md(accText); textEl.querySelectorAll('pre code').forEach(b=>hljs.highlightElement(b)); }
            scrollDown(); break;
          case 'error':
            if(cursor) cursor.remove();
            toast(ev.message,'error');
            cont.innerHTML+=`<div style="color:var(--red);font-size:13px;padding:7px 0">Error: ${ev.message}</div>`;
            break;
        }
      }
    }
  } catch(e) {
    if(cursor) cursor.remove();
    toast(e.message||'Connection error','error');
    cont.innerHTML+=`<div style="color:var(--red);font-size:13px;padding:7px 0">${e.message}</div>`;
  } finally {
    setStreaming(false);
    if(accText) S.messages.push({role:'assistant',content:accText});
    scrollDown();
  }
}

el.input.addEventListener('input', () => { autoResize(); el.sendBtn.disabled=S.streaming||(el.input.value.trim()===''&&!S.attachedFiles.length); });
el.input.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!el.sendBtn.disabled)sendMessage(el.input.value);} });
el.sendBtn.addEventListener('click', () => { if(!S.streaming)sendMessage(el.input.value); });
el.newChatBtn.addEventListener('click', () => {
  S.messages=[]; S.attachedFiles=[];
  el.filePreviews.innerHTML=''; el.filePreviews.classList.add('hidden');
  el.messages.innerHTML=''; el.input.value=''; autoResize();
  el.emptyState.classList.remove('hidden'); el.messages.classList.add('hidden');
  el.sendBtn.disabled=true;
});
document.querySelectorAll('.suggestion-card').forEach(c => c.addEventListener('click', () => { el.input.value=c.dataset.prompt; autoResize(); el.sendBtn.disabled=false; sendMessage(c.dataset.prompt); }));

// Paste images
el.input.addEventListener('paste', async e => {
  for (const item of e.clipboardData.items)
    if (item.type.startsWith('image/')) { e.preventDefault(); const f=item.getAsFile(); await uploadChatFile(new File([f],`paste-${Date.now()}.png`,{type:f.type})); }
});

// Drag/drop in chat
document.getElementById('main').addEventListener('dragover', e=>e.preventDefault());
document.getElementById('main').addEventListener('drop', async e => {
  if(S.mode!=='chat') return; e.preventDefault();
  for(const f of e.dataTransfer.files) await uploadChatFile(f);
});

// ════════════════════════════════════════
//  VIDEO STUDIO
// ════════════════════════════════════════

// Upload triggers
el.vPickBtn.addEventListener('click', () => el.vFileInput.click());
el.vFileInput.addEventListener('change', async e => { const f=e.target.files[0]; if(f) await processVideo(f); e.target.value=''; });
el.vDrop.addEventListener('dragover', e => { e.preventDefault(); el.vDrop.classList.add('drag-over'); });
el.vDrop.addEventListener('dragleave', () => el.vDrop.classList.remove('drag-over'));
el.vDrop.addEventListener('drop', async e => { e.preventDefault(); el.vDrop.classList.remove('drag-over'); const f=e.dataTransfer.files[0]; if(f) await processVideo(f); });

function setStep(step) {
  ['step-upload','step-frames','step-scenes','step-ready'].forEach(id => {
    const el2 = $(id);
    el2.classList.remove('active','done');
    if (id === step) el2.classList.add('active');
    else if (['step-upload','step-frames','step-scenes','step-ready'].indexOf(id) <
             ['step-upload','step-frames','step-scenes','step-ready'].indexOf(step))
      el2.classList.add('done');
  });
}

function setProgress(pct, title, sub) {
  el.progBar.style.width = pct + '%';
  if (title) el.procTitle.textContent = title;
  if (sub) el.procSub.textContent = sub;
}

async function processVideo(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const videoExts = ['mp4','mov','avi','mkv','webm','mpeg','mpg','3gp','flv','m4v'];
  if (!file.type.startsWith('video/') && !videoExts.includes(ext)) { toast('Please upload a video file', 'error'); return; }

  // Store blob URL for player
  if (S.videoBlobUrl) URL.revokeObjectURL(S.videoBlobUrl);
  S.videoBlobUrl = URL.createObjectURL(file);
  S.videoFile = file;

  // Show progress
  el.vUpload.classList.add('hidden');
  el.vProcessing.classList.remove('hidden');
  setProgress(0, 'Preparing…', file.name);
  setStep('step-upload');

  let progTimer = setInterval(() => {
    const cur = parseFloat(el.progBar.style.width) || 0;
    if (cur < 55) el.progBar.style.width = (cur + 1.2) + '%';
  }, 150);

  const fd = new FormData();
  fd.append('file', file);
  fd.append('max_frames', el.frameCount.value);

  try {
    setProgress(10, 'Uploading & extracting frames…', `${(file.size/1024/1024).toFixed(1)} MB`);
    setStep('step-frames');

    const r = await fetch(`${API}/api/extract-video-frames`, {method:'POST', body:fd});
    clearInterval(progTimer);

    if (!r.ok) { const e = await r.json().catch(()=>({detail:r.statusText})); throw new Error(e.detail||'Extraction failed'); }

    setProgress(80, 'Detecting scenes…', 'Analyzing frame transitions');
    setStep('step-scenes');

    const data = await r.json();
    S.frames = data.frames;
    S.meta = {duration_sec:data.duration_sec, fps:data.fps, total_frames:data.total_frames, width:data.width, height:data.height, filename:data.filename};
    S.scenes = data.scenes || [];
    S.energy = data.energy || [];

    setProgress(100, 'Ready!', `${data.frames.length} frames · ${S.scenes.length} scenes detected`);
    setStep('step-ready');

    await new Promise(r => setTimeout(r, 700));

    el.vProcessing.classList.add('hidden');
    el.vStudio.classList.remove('hidden');
    buildStudio();

  } catch(e) {
    clearInterval(progTimer);
    el.vProcessing.classList.add('hidden');
    el.vUpload.classList.remove('hidden');
    toast(e.message || 'Processing failed', 'error');
  }
}

function buildStudio() {
  const m = S.meta;

  // Meta badges
  el.vMeta.innerHTML = [
    `📹 ${m.filename}`,
    `⏱ ${fmt(m.duration_sec)}`,
    `📐 ${m.width}×${m.height}`,
    `🎞 ${m.fps.toFixed(1)}fps`,
    `🔍 ${S.scenes.length} scenes`,
    `🖼 ${S.frames.length} frames`,
  ].map(t => `<span class="v-meta-badge">${t}</span>`).join('');

  // Set video source
  el.vPlayer.src = S.videoBlobUrl;
  el.vPlayer.load();

  // Update player time → timeline cursor
  el.vPlayer.addEventListener('timeupdate', () => {
    const pct = el.vPlayer.currentTime / m.duration_sec;
    const cw = el.timelineCanvas.offsetWidth;
    el.timelineCursor.style.left = (16 + pct * cw) + 'px';
  });

  // Click timeline to seek
  el.timelineCanvas.addEventListener('click', e => {
    const rect = el.timelineCanvas.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    el.vPlayer.currentTime = pct * m.duration_sec;
  });

  buildFilmstrip();
  drawTimeline();
}

function buildFilmstrip() {
  el.filmstrip.innerHTML = '';
  const sceneTimestamps = new Set(S.scenes.map(s => Math.round(s.timestamp_sec * 10)));
  S.frames.forEach((frame, i) => {
    const div = document.createElement('div');
    div.className = 'frame-thumb';
    const isScene = sceneTimestamps.has(Math.round(frame.timestamp_sec * 10));
    if (isScene) div.classList.add('scene-start');
    div.innerHTML = `
      <div class="ft-bg">
        <span>F${i+1}</span>
        <span style="font-size:8px;color:var(--text3)">${fmt(frame.timestamp_sec)}</span>
      </div>
      <span class="ft-ts">${fmt(frame.timestamp_sec)}</span>
      ${isScene ? '<span class="ft-scene-mark"></span>' : ''}
    `;
    div.addEventListener('click', () => { el.vPlayer.currentTime = frame.timestamp_sec; el.vPlayer.play(); });
    el.filmstrip.appendChild(div);
  });
}

function drawTimeline() {
  const canvas = el.timelineCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth;
  const h = 64;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const dur = S.meta.duration_sec || 1;

  // Background
  ctx.fillStyle = '#111113';
  ctx.fillRect(0, 0, w, h);

  // Energy waveform
  if (S.energy.length) {
    ctx.beginPath();
    ctx.fillStyle = 'rgba(124,58,237,0.4)';
    S.energy.forEach((e, i) => {
      const x = (e.t / dur) * w;
      const barH = e.e * h * 2.5;
      ctx.fillRect(x, h - barH, Math.max(2, w / S.energy.length - 1), barH);
    });
    ctx.fill();
  }

  // Scene change markers
  S.scenes.forEach(sc => {
    const x = (sc.timestamp_sec / dur) * w;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(239,68,68,0.9)';
    ctx.lineWidth = 2;
    ctx.moveTo(x, 0); ctx.lineTo(x, h);
    ctx.stroke();
  });

  // Frame markers (subtle)
  S.frames.forEach(f => {
    const x = (f.timestamp_sec / dur) * w;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.moveTo(x, 0); ctx.lineTo(x, h);
    ctx.stroke();
  });

  // Time labels
  ctx.fillStyle = 'rgba(113,113,122,0.8)';
  ctx.font = '9px JetBrains Mono, monospace';
  const steps = Math.min(10, Math.floor(dur / 5));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dur;
    const x = (i / steps) * w;
    ctx.fillText(fmt(t), x + 2, h - 3);
  }

  // Draw cut decisions if we have them
  if (S.editData && S.editData.edit_decisions) {
    S.editData.edit_decisions.forEach(d => {
      if (d.action === 'CUT') {
        const inX = (tcToSec(d.in_point) / dur) * w;
        const outX = (tcToSec(d.out_point) / dur) * w;
        ctx.fillStyle = 'rgba(239,68,68,0.25)';
        ctx.fillRect(inX, 0, outX - inX, h);
        ctx.strokeStyle = 'rgba(245,158,11,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(inX, 0); ctx.lineTo(inX, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(outX, 0); ctx.lineTo(outX, h); ctx.stroke();
      }
    });
  }
}

window.addEventListener('resize', () => { if (S.meta) drawTimeline(); });

// ── Results tabs ────────────────────────────────────────────────────────────
el.resultsTabs.forEach(tab => tab.addEventListener('click', () => {
  el.resultsTabs.forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  ['overview','cuts','scenes','color','captions','ffmpeg','shorts','export'].forEach(name => {
    $(`tab-${name}`).classList.toggle('hidden', tab.dataset.tab !== name);
  });
}));

// ── AI Edit ─────────────────────────────────────────────────────────────────
el.aiEditBtn.addEventListener('click', runAiEdit);

async function runAiEdit() {
  if (S.analyzing || !S.frames.length) return;
  S.analyzing = true;
  el.aiEditBtn.disabled = true;
  el.aiEditBtn.innerHTML = `<div class="tool-spinner" style="width:13px;height:13px;border-color:rgba(255,255,255,.25);border-top-color:white"></div> Analyzing…`;

  // Hide placeholder, show loading in overview
  el.aiPlaceholder.classList.add('hidden');
  el.overviewContent.classList.remove('hidden');
  el.overviewContent.innerHTML = `<div style="display:flex;align-items:center;gap:12px;padding:20px 0;color:var(--text2)"><div class="big-spinner" style="width:28px;height:28px"></div><div><div style="font-weight:600;margin-bottom:3px">AI is analyzing every frame…</div><div style="font-size:12.5px;color:var(--text3)">Generating cut decisions, color grade, captions, FFmpeg scripts</div></div></div>`;

  const fd = new FormData();
  fd.append('frame_ids', JSON.stringify(S.frames.map(f => f.file_id)));
  fd.append('timestamps', JSON.stringify(S.frames.map(f => f.timestamp_sec)));
  fd.append('model', el.videoModelSel.value);
  fd.append('duration', S.meta.duration_sec);

  let accumulated = '';

  try {
    const resp = await fetch(`${API}/api/ai-edit`, {method:'POST', body:fd});
    if (!resp.ok) { const e = await resp.json().catch(()=>({detail:resp.statusText})); throw new Error(e.detail||'Analysis failed'); }

    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';

    while(true) {
      const {done,value} = await reader.read(); if (done) break;
      buf += dec.decode(value, {stream:true});
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        if (ev.type === 'chunk') {
          accumulated += ev.text;
          // Show live JSON building
          el.overviewContent.innerHTML = `<div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text3);padding:10px;background:var(--bg3);border-radius:var(--r2);overflow-x:auto;max-height:180px;overflow-y:auto;white-space:pre">${esc(accumulated.slice(-800))}</div>`;
        } else if (ev.type === 'result') {
          S.editData = ev.data;
          renderEditResults(ev.data);
          drawTimeline(); // Redraw with cut markers
          toast('AI Edit complete!', 'success');
        } else if (ev.type === 'parse_error') {
          // Show raw text as markdown
          S.editData = null;
          el.overviewContent.innerHTML = `<div class="text-content">${md(ev.raw)}</div>`;
          toast('Analysis complete (text format)', 'info');
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
    }
  } catch(e) {
    el.overviewContent.innerHTML = `<div style="color:var(--red);padding:10px">Error: ${e.message}</div>`;
    toast(e.message, 'error');
  } finally {
    S.analyzing = false;
    el.aiEditBtn.disabled = false;
    el.aiEditBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> AI Edit`;
  }
}

function renderEditResults(d) {
  // Overview
  const score = d.overall_score || 0;
  const scorePct = score * 10;
  const pacing = d.pacing || {};
  el.overviewContent.innerHTML = `
    <div class="result-grid">
      <div class="result-card">
        <div class="rc-label">Overall Score</div>
        <div class="rc-value">${score}<span style="font-size:14px;color:var(--text3)">/10</span></div>
        <div class="score-bar"><div class="score-fill" style="width:${scorePct}%"></div></div>
      </div>
      <div class="result-card">
        <div class="rc-label">Genre</div>
        <div class="rc-value" style="font-size:14px">${d.genre || 'Unknown'}</div>
        <div class="rc-sub">${d.summary || ''}</div>
      </div>
      <div class="result-card">
        <div class="rc-label">Pacing</div>
        <div class="rc-value" style="font-size:14px">${pacing.rating || 'N/A'}</div>
        <div class="rc-sub">${pacing.current_cpm || 0} cuts/min → recommended ${pacing.recommended_cpm || 0}</div>
      </div>
      <div class="result-card">
        <div class="rc-label">Recommended Duration</div>
        <div class="rc-value" style="font-size:14px">${d.recommended_final_duration ? fmt(d.recommended_final_duration) : 'N/A'}</div>
        <div class="rc-sub">${pacing.verdict || ''}</div>
      </div>
    </div>
    ${d.top_issues?.length ? `<div style="margin-bottom:12px"><div class="sb-label" style="margin-bottom:6px">⚠️ Issues</div>${d.top_issues.map(i=>`<div style="display:flex;gap:7px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--text2)"><span style="color:var(--red)">✕</span>${i}</div>`).join('')}</div>` : ''}
    ${d.top_strengths?.length ? `<div><div class="sb-label" style="margin-bottom:6px">✅ Strengths</div>${d.top_strengths.map(s=>`<div style="display:flex;gap:7px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--text2)"><span style="color:var(--green)">✓</span>${s}</div>`).join('')}</div>` : ''}
  `;

  // Cuts tab
  if (d.edit_decisions?.length) {
    el.tabCuts.innerHTML = `<div class="cut-list">${d.edit_decisions.map(cut => `
      <div class="cut-item" onclick="seekTo(${tcToSec(cut.in_point)})">
        <span class="cut-action ${cut.action||'KEEP'}">${cut.action||'KEEP'}</span>
        <span class="cut-tc">${cut.in_point||'?'} → ${cut.out_point||'?'}</span>
        ${cut.speed && cut.speed !== 1 ? `<span style="color:var(--purple);font-size:11px">×${cut.speed}</span>` : ''}
        <span class="cut-reason">${cut.reason||''}</span>
      </div>`).join('')}</div>`;
  }

  // Scenes tab
  if (d.scenes?.length) {
    el.tabScenes.innerHTML = `<div class="scene-list">${d.scenes.map(sc => `
      <div class="scene-item" onclick="seekTo(${tcToSec(sc.in_point)})">
        <div class="scene-num">${sc.id}</div>
        <div class="scene-info">
          <div class="scene-title">${sc.title}</div>
          <div class="scene-meta">${sc.in_point} → ${sc.out_point} · ${sc.type}</div>
        </div>
        <span class="scene-mood">${sc.mood||''}</span>
        <span class="scene-score">★${sc.quality_score||'?'}</span>
        ${!sc.keep ? `<span style="color:var(--red);font-size:11px">REMOVE</span>` : ''}
      </div>`).join('')}</div>`;
  }

  // Color tab
  if (d.color_grade) {
    const cg = d.color_grade;
    const params = [
      {label:'Temperature', val:cg.temperature, unit:'K', min:3000, max:8000, color:'#f59e0b'},
      {label:'Exposure', val:cg.exposure, unit:'', min:-2, max:2, color:'#fef08a'},
      {label:'Contrast', val:cg.contrast, unit:'', min:-50, max:50, color:'#a78bfa'},
      {label:'Highlights', val:cg.highlights, unit:'', min:-100, max:100, color:'#e0e0e0'},
      {label:'Shadows', val:cg.shadows, unit:'', min:-100, max:100, color:'#374151'},
      {label:'Saturation', val:cg.saturation, unit:'', min:-100, max:100, color:'#f472b6'},
      {label:'Vibrance', val:cg.vibrance, unit:'', min:-100, max:100, color:'#34d399'},
    ];
    el.tabColor.innerHTML = `
      <div class="result-grid" style="margin-bottom:14px">
        <div class="result-card"><div class="rc-label">Style</div><div class="rc-value" style="font-size:14px">${cg.style||'N/A'}</div></div>
        <div class="result-card"><div class="rc-label">LUT Suggestion</div><div class="rc-value" style="font-size:13px">${cg.lut_suggestion||'N/A'}</div></div>
      </div>
      <div class="result-card" style="margin-bottom:12px">
        <div class="rc-label">Reasoning</div>
        <div style="font-size:12.5px;color:var(--text2);margin-top:4px">${cg.reasoning||''}</div>
      </div>
      <div class="result-card" style="margin-bottom:12px">
        <div class="rc-label">Parameters</div>
        ${params.map(p => {
          const norm = p.label === 'Temperature'
            ? ((p.val - p.min) / (p.max - p.min) * 100)
            : (50 + (p.val || 0) / 2);
          return `<div class="color-slider-row">
            <span class="cs-label">${p.label}</span>
            <div class="cs-bar"><div class="cs-fill" style="width:${Math.max(0,Math.min(100,norm))}%;background:${p.color}"></div></div>
            <span class="cs-value">${p.val||0}${p.unit}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="result-grid">
        <div class="result-card"><div class="rc-label">DaVinci Resolve</div><div style="font-size:12px;color:var(--text2);margin-top:4px">${cg.davinci_node_order||'N/A'}</div></div>
        <div class="result-card"><div class="rc-label">Premiere Pro</div><div style="font-size:12px;color:var(--text2);margin-top:4px">${cg.premiere_lumetri||'N/A'}</div></div>
      </div>
    `;
  }

  // Captions tab
  if (d.captions?.length) {
    el.tabCaptions.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:13px;color:var(--text2)">${d.captions.length} captions generated</span>
        <button class="upload-btn" style="padding:6px 14px;font-size:12px" onclick="downloadSRT()">📥 Download SRT</button>
      </div>
      <div class="caption-list">${d.captions.map(c => `
        <div class="cap-item" onclick="seekTo(${srtTcToSec(c.start)})">
          <span class="cap-tc">${c.start||''} → ${c.end||''}</span>
          <span><span class="cap-speaker">${c.speaker||''}</span><span class="cap-text">${c.text||''}</span></span>
        </div>`).join('')}
      </div>`;
  }

  // FFmpeg tab
  if (d.ffmpeg_commands?.length) {
    el.tabFfmpeg.innerHTML = `
      <div style="margin-bottom:12px;font-size:12.5px;color:var(--text2)">Replace <code>INPUT.mp4</code> with your video filename. Run in terminal.</div>
      <div class="ffmpeg-list">${d.ffmpeg_commands.map((cmd,i) => `
        <div class="ff-item">
          <div class="ff-header">
            <span class="ff-label">${cmd.label||`Command ${i+1}`}</span>
            <button class="ff-copy" onclick="copyFFmpeg(this, ${i})">Copy</button>
          </div>
          <div class="ff-cmd" id="ff-${i}">${esc(cmd.command||'')}</div>
        </div>`).join('')}
      </div>
      <div style="margin-top:12px">
        <button class="upload-btn" style="padding:8px 16px;font-size:12.5px" onclick="downloadFFmpegScript()">📥 Download as .sh Script</button>
      </div>`;
  }

  // Shorts tab
  if (d.shorts_clip) {
    const sc = d.shorts_clip;
    const aud = d.audio || {};
    el.tabShorts.innerHTML = `
      <div class="shorts-score" style="margin-bottom:16px">
        <div class="virality-num">${sc.virality_score||'?'}</div>
        <div><div class="rc-value" style="font-size:15px">Virality Score</div><div class="virality-label">out of 10</div></div>
      </div>
      <div class="result-grid">
        <div class="result-card">
          <div class="rc-label">Best Clip</div>
          <div class="rc-value" style="font-size:13px">${sc.best_start} → ${sc.best_end}</div>
          <div class="rc-sub"><button class="ff-copy" style="margin-top:4px" onclick="seekTo(${tcToSec(sc.best_start)})">▶ Preview</button></div>
        </div>
        <div class="result-card">
          <div class="rc-label">Hook Text</div>
          <div class="rc-value" style="font-size:13px">"${sc.hook_text||'N/A'}"</div>
        </div>
        <div class="result-card">
          <div class="rc-label">Vertical Crop (9:16)</div>
          <div class="rc-value" style="font-size:12px;font-family:'JetBrains Mono',monospace">${sc.vertical_crop||'N/A'}</div>
        </div>
        <div class="result-card">
          <div class="rc-label">Music Genre</div>
          <div class="rc-value" style="font-size:13px">${aud.music_genre_suggestion||'N/A'}</div>
          <div class="rc-sub">${aud.audio_design_notes||''}</div>
        </div>
      </div>
      ${d.broll_suggestions?.length ? `
        <div class="sb-label" style="margin-bottom:6px;margin-top:14px">B-Roll Suggestions</div>
        ${d.broll_suggestions.map(b=>`<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px"><span style="font-family:'JetBrains Mono',monospace;color:var(--accent);cursor:pointer" onclick="seekTo(${tcToSec(b.at_timecode)})">${b.at_timecode}</span><span style="color:var(--text2)">${b.suggestion}</span></div>`).join('')}
      ` : ''}
      ${d.motion_graphics?.length ? `
        <div class="sb-label" style="margin-bottom:6px;margin-top:14px">Motion Graphics</div>
        ${d.motion_graphics.map(mg=>`<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px"><span style="font-family:'JetBrains Mono',monospace;color:var(--accent);cursor:pointer;min-width:65px" onclick="seekTo(${tcToSec(mg.timecode)})">${mg.timecode}</span><span class="tool-badge">${mg.type}</span><span style="color:var(--text2);margin-left:6px">${mg.text} (${mg.duration}s)</span></div>`).join('')}
      ` : ''}
    `;
  }

  // Export tab
  const hasCaptions = !!(d.captions?.length);
  const hasEdits = !!(d.edit_decisions?.length);
  const hasFfmpeg = !!(d.ffmpeg_commands?.length);
  el.tabExport.innerHTML = `
    <div class="export-grid">
      <div class="exp-card">
        <div class="exp-icon">💬</div>
        <div class="exp-name">SRT Subtitles</div>
        <div class="exp-desc">Download generated captions as .srt subtitle file</div>
        <button class="exp-btn" onclick="downloadSRT()" ${hasCaptions?'':'disabled'}>📥 Download .srt</button>
      </div>
      <div class="exp-card">
        <div class="exp-icon">🎬</div>
        <div class="exp-name">EDL File</div>
        <div class="exp-desc">Edit Decision List for Premiere Pro / DaVinci Resolve</div>
        <button class="exp-btn" onclick="downloadEDL()" ${hasEdits?'':'disabled'}>📥 Download .edl</button>
      </div>
      <div class="exp-card">
        <div class="exp-icon">⚙️</div>
        <div class="exp-name">FFmpeg Script</div>
        <div class="exp-desc">Executable shell script with all edit commands</div>
        <button class="exp-btn" onclick="downloadFFmpegScript()" ${hasFfmpeg?'':'disabled'}>📥 Download .sh</button>
      </div>
      <div class="exp-card">
        <div class="exp-icon">📋</div>
        <div class="exp-name">Full Edit JSON</div>
        <div class="exp-desc">Complete AI analysis data in JSON format</div>
        <button class="exp-btn" onclick="downloadJSON()">📥 Download .json</button>
      </div>
    </div>
  `;

  // Auto-switch to overview tab
  el.resultsTabs.forEach(t => t.classList.remove('active'));
  document.querySelector('.rtab[data-tab="overview"]').classList.add('active');
  ['cuts','scenes','color','captions','ffmpeg','shorts','export'].forEach(n => $(`tab-${n}`).classList.add('hidden'));
  el.tabOverview.classList.remove('hidden');
}

// ── Download functions ──────────────────────────────────────────────────────

async function downloadSRT() {
  if (!S.editData?.captions?.length) { toast('No captions generated', 'error'); return; }
  const fd = new FormData();
  fd.append('captions', JSON.stringify(S.editData.captions));
  fd.append('filename', S.meta?.filename?.replace(/\.[^.]+$/, '') || 'subtitles');
  const r = await fetch(`${API}/api/export-srt`, {method:'POST', body:fd});
  const blob = await r.blob();
  dlBlob(blob, 'subtitles.srt');
  toast('SRT downloaded', 'success');
}

async function downloadEDL() {
  if (!S.editData?.edit_decisions?.length) { toast('No edit decisions', 'error'); return; }
  const fd = new FormData();
  fd.append('edit_decisions', JSON.stringify(S.editData.edit_decisions));
  fd.append('filename', S.meta?.filename?.replace(/\.[^.]+$/, '') || 'edit');
  fd.append('fps', S.meta?.fps || 25);
  const r = await fetch(`${API}/api/export-edl`, {method:'POST', body:fd});
  const blob = await r.blob();
  dlBlob(blob, 'edit.edl');
  toast('EDL downloaded', 'success');
}

async function downloadFFmpegScript() {
  if (!S.editData?.ffmpeg_commands?.length) { toast('No FFmpeg commands', 'error'); return; }
  const fd = new FormData();
  fd.append('commands', JSON.stringify(S.editData.ffmpeg_commands));
  fd.append('filename', 'edit_script');
  const r = await fetch(`${API}/api/export-ffmpeg-script`, {method:'POST', body:fd});
  const blob = await r.blob();
  dlBlob(blob, 'edit_script.sh');
  toast('FFmpeg script downloaded', 'success');
}

function downloadJSON() {
  if (!S.editData) { toast('No edit data', 'error'); return; }
  dlBlob(new Blob([JSON.stringify(S.editData, null, 2)], {type:'application/json'}), 'ai_edit.json');
  toast('JSON downloaded', 'success');
}

function dlBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyFFmpeg(btn, idx) {
  const cmd = S.editData?.ffmpeg_commands?.[idx]?.command || '';
  navigator.clipboard.writeText(cmd).then(() => { const o=btn.textContent; btn.textContent='Copied!'; setTimeout(()=>{btn.textContent=o;},2000); });
}

// ── Video studio utils ──────────────────────────────────────────────────────
function seekTo(sec) { if (el.vPlayer) { el.vPlayer.currentTime=sec; el.vPlayer.play(); } }

function fmt(sec) {
  if (!sec && sec !== 0) return '?';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function tcToSec(tc) {
  if (!tc) return 0;
  const parts = tc.replace(',','.').split(':');
  try { return parseInt(parts[0])*3600 + parseInt(parts[1])*60 + parseFloat(parts[2]); }
  catch { return 0; }
}

function srtTcToSec(tc) {
  if (!tc) return 0;
  const parts = tc.replace(',','.').split(':');
  try { return parseInt(parts[0])*3600 + parseInt(parts[1])*60 + parseFloat(parts[2]); }
  catch { return 0; }
}

function esc(t) { return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

el.vResetBtn.addEventListener('click', () => {
  S.frames.forEach(f => fetch(`${API}/api/files/${f.file_id}`,{method:'DELETE'}).catch(()=>{}));
  S.frames=[]; S.meta=null; S.scenes=[]; S.energy=[]; S.editData=null;
  if(S.videoBlobUrl){URL.revokeObjectURL(S.videoBlobUrl);S.videoBlobUrl=null;}
  el.vStudio.classList.add('hidden');
  el.vUpload.classList.remove('hidden');
  el.filmstrip.innerHTML='';
  el.aiPlaceholder.classList.remove('hidden');
  el.overviewContent.classList.add('hidden');
  el.overviewContent.innerHTML='';
});

// ── Global expose ───────────────────────────────────────────────────────────
window.copyCode = copyCode;
window.toggleThinking = h => { h.classList.toggle('collapsed'); h.parentElement.querySelector('.thinking-content').classList.toggle('hidden'); };
window.seekTo = seekTo;
window.downloadSRT = downloadSRT;
window.downloadEDL = downloadEDL;
window.downloadFFmpegScript = downloadFFmpegScript;
window.downloadJSON = downloadJSON;
window.copyFFmpeg = copyFFmpeg;

// ── Init ────────────────────────────────────────────────────────────────────
el.input.focus();
