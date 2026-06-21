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
  frames: [],           // [{file_id, timestamp_sec, frame_index, thumbnail_b64}]
  meta: null,           // {duration_sec, fps, width, height, filename, ...}
  scenes: [],           // [{timestamp_sec, timestamp, correlation}]
  energy: [],           // [{t, e}]
  audioWaveform: [],    // [0..1] RMS amplitudes for timeline
  editData: null,       // parsed AI edit JSON
  analyzing: false,
  batchExporting: false,
  // Video Q&A chat
  vqaMsgs: [],          // [{role, content}] Anthropic messages format
  vqaStreaming: false,
  // Image Studio
  imgFile: null,
  imgBlobUrl: null,
  imgFileId: null,      // Files API persistent reference
  imgAnalysis: null,    // parsed JSON from analyze-image
  imgChatMsgs: [],      // [{role, content}]
  imgChatStreaming: false,
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
  chatSb: $('chat-sidebar'), videoSb: $('video-sidebar'), imgSb: $('img-sidebar'),
  modeBtns: document.querySelectorAll('.mode-btn'),
  frameCount: $('frame-count'), frameCountLabel: $('frame-count-label'),
  sceneThresh: $('scene-thresh'), sceneThreshLabel: $('scene-thresh-label'),
  videoModelSel: $('video-model-select'),
  // Views
  chatView: $('chat-view'), videoView: $('video-view'), imageView: $('image-view'),
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
  el.imageView.classList.toggle('hidden', mode !== 'image');
  el.chatSb.classList.toggle('hidden', mode !== 'chat');
  el.videoSb.classList.toggle('hidden', mode !== 'video');
  el.imgSb.classList.toggle('hidden', mode !== 'image');
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
    S.audioWaveform = data.audio_waveform || [];

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
  renderStoryboard();
  renderThumbnailPicker();
  // reset Q&A on new video
  S.vqaMsgs = []; S.vqaStreaming = false;
  const vqaEl = $('vqa-messages');
  if (vqaEl) vqaEl.innerHTML = '';
}

function buildFilmstrip() {
  el.filmstrip.innerHTML = '';
  const sceneTimestamps = new Set(S.scenes.map(s => Math.round(s.timestamp_sec * 10)));
  S.frames.forEach((frame, i) => {
    const div = document.createElement('div');
    div.className = 'frame-thumb';
    const isScene = sceneTimestamps.has(Math.round(frame.timestamp_sec * 10));
    if (isScene) div.classList.add('scene-start');
    if (frame.thumbnail_b64) {
      div.innerHTML = `
        <img class="ft-img" src="${frame.thumbnail_b64}" alt="F${i+1}" loading="lazy"/>
        <span class="ft-ts">${fmt(frame.timestamp_sec)}</span>
        ${isScene ? '<span class="ft-scene-mark"></span>' : ''}
      `;
    } else {
      div.innerHTML = `
        <div class="ft-bg">
          <span>F${i+1}</span>
          <span style="font-size:8px;color:var(--text3)">${fmt(frame.timestamp_sec)}</span>
        </div>
        <span class="ft-ts">${fmt(frame.timestamp_sec)}</span>
        ${isScene ? '<span class="ft-scene-mark"></span>' : ''}
      `;
    }
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

  // Audio waveform (teal, mirrored — fills upper half)
  if (S.audioWaveform.length) {
    const aw = S.audioWaveform;
    const mid = h * 0.45;
    ctx.fillStyle = 'rgba(20,184,166,0.35)';
    aw.forEach((amp, i) => {
      const x = (i / aw.length) * w;
      const bw = Math.max(1, w / aw.length - 0.5);
      const barH = amp * mid;
      ctx.fillRect(x, mid - barH, bw, barH * 2);
    });
    // Center line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(20,184,166,0.5)';
    ctx.lineWidth = 1;
    ctx.moveTo(0, mid); ctx.lineTo(w, mid);
    ctx.stroke();
  }

  // Motion energy waveform (purple, bottom bar)
  if (S.energy.length) {
    ctx.fillStyle = 'rgba(124,58,237,0.35)';
    S.energy.forEach((e) => {
      const x = (e.t / dur) * w;
      const barH = e.e * h * 0.4;
      ctx.fillRect(x, h - barH, Math.max(2, w / S.energy.length - 1), barH);
    });
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
const ALL_TABS = ['overview','storyboard','thumbnail','cuts','scenes','color','captions','content','ffmpeg','shorts','export'];

el.resultsTabs.forEach(tab => tab.addEventListener('click', () => {
  el.resultsTabs.forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  ALL_TABS.forEach(name => {
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
  const editInstr = $('edit-instructions');
  if (editInstr?.value.trim()) fd.append('edit_instructions', editInstr.value.trim());

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
    const keeps = d.edit_decisions.filter(c => c.action !== 'CUT').length;
    const cuts = d.edit_decisions.filter(c => c.action === 'CUT').length;
    const hasSilenceData = S.audioWaveform.length > 0;
    el.tabCuts.innerHTML = `
      ${hasSilenceData ? `
      <div class="silence-detector" id="silence-detector">
        <div class="silence-det-header">
          <span class="silence-det-title">🎙 Silence Remover</span>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <label style="font-size:11.5px;color:var(--text2);display:flex;align-items:center;gap:5px">
              Threshold
              <input type="range" id="sil-thresh" min="2" max="25" value="6" style="width:70px;accent-color:var(--accent)" oninput="this.nextElementSibling.textContent=this.value+'%'"/>
              <span style="font-size:11px;color:var(--text3);min-width:26px">6%</span>
            </label>
            <label style="font-size:11.5px;color:var(--text2);display:flex;align-items:center;gap:5px">
              Min dur
              <input type="range" id="sil-min" min="3" max="30" value="8" style="width:60px;accent-color:var(--accent)" oninput="this.nextElementSibling.textContent=(this.value/10).toFixed(1)+'s'"/>
              <span style="font-size:11px;color:var(--text3);min-width:28px">0.8s</span>
            </label>
            <button class="ff-copy" onclick="runSilenceDetect()">🔍 Detect</button>
          </div>
        </div>
        <div id="silence-list" class="silence-list"></div>
        <div id="silence-actions" class="hidden" style="padding:8px 12px;display:flex;align-items:center;gap:10px;border-top:1px solid var(--border)">
          <span id="silence-summary" style="font-size:12px;color:var(--text2)"></span>
          <button class="exp-btn exp-btn-red" style="padding:6px 14px;font-size:12px;margin-top:0" onclick="removeSilences()">⚡ Remove Silences & Download</button>
        </div>
      </div>` : ''}
      <div style="display:flex;gap:12px;margin-bottom:10px;font-size:12px;color:var(--text2)">
        <span>Total: <strong>${d.edit_decisions.length}</strong></span>
        <span style="color:var(--green)">Keep: <strong>${keeps}</strong></span>
        <span style="color:var(--red)">Cut: <strong>${cuts}</strong></span>
      </div>
      <div class="cut-list">${d.edit_decisions.map((cut,i) => `
        <div class="cut-item">
          <span class="cut-action ${cut.action||'KEEP'}">${cut.action||'KEEP'}</span>
          <span class="cut-tc">${cut.in_point||'?'} → ${cut.out_point||'?'}</span>
          ${cut.speed && cut.speed !== 1 ? `<span style="color:var(--purple);font-size:11px">×${cut.speed}</span>` : ''}
          <span class="cut-reason">${cut.reason||''}</span>
          <div class="cut-preview-btns">
            <button class="cut-prev-btn" onclick="previewCut(${tcToSec(cut.in_point||'0')},${tcToSec(cut.out_point||'5')})" title="Preview this segment">▶ Preview</button>
          </div>
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
      <div class="result-card" style="margin-top:12px">
        <div class="rc-label" style="margin-bottom:8px">🎨 Color DNA — Palette Extracted from Frames</div>
        <div id="color-palette-wrap" class="palette-loading">Extracting palette…</div>
      </div>
    `;
    // Extract palette asynchronously from thumbnails
    buildColorPalette();
  }

  // Captions tab
  if (d.captions?.length) {
    const LANGS = ['Spanish','French','German','Portuguese','Italian','Japanese','Korean','Chinese','Arabic','Hebrew','Russian','Hindi'];
    el.tabCaptions.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <span style="font-size:13px;color:var(--text2)">${d.captions.length} captions</span>
        <div class="cap-translate-row">
          <select id="cap-lang-sel" class="model-select" style="padding:5px 24px 5px 8px;font-size:12px;flex-shrink:0">
            ${LANGS.map(l=>`<option>${l}</option>`).join('')}
          </select>
          <button class="ff-copy" id="cap-translate-btn" style="white-space:nowrap" onclick="translateCaptions()">🌐 Translate</button>
        </div>
        <button class="ff-copy" style="white-space:nowrap" onclick="downloadSRT()">📥 SRT</button>
        <button class="ff-copy" style="white-space:nowrap" onclick="burnSubtitles('default')">🔥 Burn Default</button>
        <button class="ff-copy" style="white-space:nowrap" onclick="burnSubtitles('tiktok')">🔥 TikTok Style</button>
      </div>
      <div id="cap-list" class="caption-list">${d.captions.map(c => `
        <div class="cap-item" onclick="seekTo(${srtTcToSec(c.start)})">
          <span class="cap-tc">${c.start||''} → ${c.end||''}</span>
          <span><span class="cap-speaker">${esc(c.speaker||'')}</span><span class="cap-text">${esc(c.text||'')}</span></span>
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

      <div class="sb-label" style="margin:16px 0 10px">📐 Multi-Format Export</div>
      <div class="format-grid">
        ${[
          {id:'original',  label:'16:9',  sub:'YouTube / Web',         w:16, h:9,  emoji:'🖥'},
          {id:'shorts',    label:'9:16',  sub:'TikTok / Reels',        w:9,  h:16, emoji:'📱'},
          {id:'square_1x1',label:'1:1',   sub:'Instagram Square',      w:1,  h:1,  emoji:'🟦'},
          {id:'portrait_4x5',label:'4:5', sub:'Instagram Portrait',    w:4,  h:5,  emoji:'📸'},
          {id:'cinema_21x9',label:'21:9', sub:'Cinematic Ultra Wide',  w:21, h:9,  emoji:'🎬'},
        ].map(f=>`
          <div class="format-card" onclick="exportAspectRatio('${f.id}')">
            <div class="format-emoji">${f.emoji}</div>
            <div class="format-preview-box" style="aspect-ratio:${f.w}/${f.h}"></div>
            <div class="format-name">${f.label}</div>
            <div class="format-sub">${f.sub}</div>
          </div>`).join('')}
      </div>
    `;
  }

  // Export tab
  const hasCaptions = !!(d.captions?.length);
  const hasEdits = !!(d.edit_decisions?.length);
  const hasFfmpeg = !!(d.ffmpeg_commands?.length);
  const hasShortsClip = !!(d.shorts_clip?.best_start);
  el.tabExport.innerHTML = `
    <div class="export-section-label">🎬 Server-Side Video Processing</div>
    <div class="export-grid export-grid-4">
      <div class="exp-card exp-card-process">
        <div class="exp-icon">✂️</div>
        <div class="exp-name">Full AI Edit</div>
        <div class="exp-desc">Execute all cut/trim decisions + AI color grade — outputs a fully edited MP4</div>
        <div class="exp-proc-status" id="proc-status-full_edit"></div>
        <button class="exp-btn exp-btn-red" id="proc-btn-full_edit" onclick="processVideoOp('full_edit')" ${hasEdits?'':'disabled'}>
          ⚡ Process & Download
        </button>
      </div>
      <div class="exp-card exp-card-process">
        <div class="exp-icon">📱</div>
        <div class="exp-name">Export Shorts (9:16)</div>
        <div class="exp-desc">Trim to best ${hasShortsClip&&d.shorts_clip.best_start?`${d.shorts_clip.best_start}→${d.shorts_clip.best_end}`:'clip'}, vertical crop + color grade</div>
        <div class="exp-proc-status" id="proc-status-shorts"></div>
        <button class="exp-btn exp-btn-red" id="proc-btn-shorts" onclick="processVideoOp('shorts')" ${hasShortsClip?'':'disabled'}>
          ⚡ Process & Download
        </button>
      </div>
      <div class="exp-card exp-card-process">
        <div class="exp-icon">🎨</div>
        <div class="exp-name">Color Grade Only</div>
        <div class="exp-desc">Apply AI color grade (temp ${d.color_grade?.temperature||5500}K · ${d.color_grade?.style||'Cinematic'}) to full video</div>
        <div class="exp-proc-status" id="proc-status-color_grade"></div>
        <button class="exp-btn exp-btn-red" id="proc-btn-color_grade" onclick="processVideoOp('color_grade')" ${d.color_grade?'':'disabled'}>
          ⚡ Process & Download
        </button>
      </div>
      <div class="exp-card exp-card-process">
        <div class="exp-icon">🎯</div>
        <div class="exp-name">Highlight Reel</div>
        <div class="exp-desc">Auto-select best KEEP segments (up to 60s) → single MP4</div>
        <div class="exp-proc-status" id="proc-status-highlight"></div>
        <button class="exp-btn exp-btn-red" id="proc-btn-highlight" onclick="exportHighlightReel()" ${hasEdits?'':'disabled'}>
          ⚡ Generate Highlights
        </button>
      </div>
    </div>

    <div style="margin-top:14px;margin-bottom:18px">
      <button class="batch-export-btn" id="batch-export-btn" onclick="batchExport()">
        ⚡ Batch Export All 3 Versions
      </button>
      <span style="font-size:11.5px;color:var(--text3);margin-left:10px">Full Edit + Shorts 9:16 + Color Grade — all at once</span>
    </div>

    <div class="export-section-label" style="margin-top:4px">📦 Export Data & Scripts</div>
    <div class="export-grid">
      <div class="exp-card">
        <div class="exp-icon">💬</div>
        <div class="exp-name">SRT Subtitles</div>
        <div class="exp-desc">Download generated captions as .srt subtitle file</div>
        <button class="exp-btn" onclick="downloadSRT()" ${hasCaptions?'':'disabled'}>📥 Download .srt</button>
      </div>
      <div class="exp-card">
        <div class="exp-icon">🔥</div>
        <div class="exp-name">Burn Subtitles</div>
        <div class="exp-desc">Permanently burn captions into video (Default / TikTok style)</div>
        <div style="display:flex;gap:6px;margin-top:auto">
          <button class="exp-btn" style="flex:1;padding:7px 8px;font-size:11.5px" onclick="burnSubtitles('default')" ${hasCaptions?'':'disabled'}>Default</button>
          <button class="exp-btn" style="flex:1;padding:7px 8px;font-size:11.5px;background:linear-gradient(135deg,#ef4444,#f59e0b)" onclick="burnSubtitles('tiktok')" ${hasCaptions?'':'disabled'}>TikTok</button>
        </div>
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

  // Refresh tabs with AI data
  renderStoryboard();
  renderThumbnailPicker();
  renderContentTab();

  // Auto-switch to overview tab
  el.resultsTabs.forEach(t => t.classList.remove('active'));
  document.querySelector('.rtab[data-tab="overview"]').classList.add('active');
  ALL_TABS.filter(n=>n!=='overview').forEach(n => $(`tab-${n}`)?.classList.add('hidden'));
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
  S.frames=[]; S.meta=null; S.scenes=[]; S.energy=[]; S.audioWaveform=[]; S.editData=null;
  S.vqaMsgs=[]; S.vqaStreaming=false;
  if(S.videoBlobUrl){URL.revokeObjectURL(S.videoBlobUrl);S.videoBlobUrl=null;}
  S.videoFile=null;
  el.vStudio.classList.add('hidden');
  el.vUpload.classList.remove('hidden');
  el.filmstrip.innerHTML='';
  el.aiPlaceholder.classList.remove('hidden');
  el.overviewContent.classList.add('hidden');
  el.overviewContent.innerHTML='';
  ['storyboard','thumbnail','content'].forEach(n => { const t=$(`tab-${n}`); if(t) t.innerHTML=''; });
  const vqaEl=$('vqa-messages'); if(vqaEl) vqaEl.innerHTML='';
});

// ── Video Q&A ────────────────────────────────────────────────────────────────

function toggleVideoQA() {
  const body = $('vqa-body');
  const chev = $('vqa-chevron');
  if (!body) return;
  const opening = body.classList.toggle('hidden');
  if (chev) chev.classList.toggle('flipped', !body.classList.contains('hidden'));
}

async function sendVideoChat() {
  if (S.vqaStreaming || !S.frames.length) return;
  const input = $('vqa-input');
  const question = (input?.value || '').trim();
  if (!question) return;
  if (input) input.value = '';

  S.vqaStreaming = true;
  const sendBtn = $('vqa-send');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<div class="tool-spinner" style="width:11px;height:11px;border-color:rgba(255,255,255,.2);border-top-color:white"></div>'; }

  const msgs = $('vqa-messages');

  // User bubble
  const qDiv = document.createElement('div');
  qDiv.className = 'vqa-msg vqa-user'; qDiv.textContent = question;
  msgs?.appendChild(qDiv);

  // AI bubble
  const aDiv = document.createElement('div');
  aDiv.className = 'vqa-msg vqa-ai';
  const cursor = document.createElement('span'); cursor.className = 'streaming-cursor';
  aDiv.appendChild(cursor);
  msgs?.appendChild(aDiv);
  msgs && (msgs.scrollTop = msgs.scrollHeight);

  // Build message content
  let content;
  if (S.vqaMsgs.length === 0) {
    const parts = [];
    parts.push({type:'text', text:`Analyze this video: "${S.meta?.filename||'video'}" (${fmt(S.meta?.duration_sec)}, ${S.meta?.width}×${S.meta?.height}, ${S.meta?.fps?.toFixed(1)}fps). I've extracted ${S.frames.length} frames below.`});
    S.frames.forEach((f,i) => {
      parts.push({type:'image', source:{type:'file', file_id:f.file_id}});
      parts.push({type:'text', text:`[Frame ${i+1} @ ${fmt(f.timestamp_sec)}]`});
    });
    parts.push({type:'text', text: question});
    content = parts;
  } else {
    content = question;
  }

  S.vqaMsgs.push({role:'user', content});
  let accText = '';

  try {
    const payload = {
      messages: S.vqaMsgs.map(m=>({role:m.role, content:m.content})),
      model: el.videoModelSel.value,
      enable_thinking: false,
      enable_web_search: false,
      enable_code_execution: false,
      system: `You are OmniAI Video Analyst. You have ${S.frames.length} extracted video frames. Answer questions about the video content — scenes, people, actions, text visible in frames, mood, etc. Reference frame numbers and timestamps when relevant.`,
    };
    const resp = await fetch(`${API}/api/chat`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf='';
    while(true) {
      const {done,value} = await reader.read(); if(done) break;
      buf += dec.decode(value,{stream:true});
      const lines=buf.split('\n'); buf=lines.pop();
      for(const line of lines) {
        if(!line.startsWith('data: ')) continue;
        let ev; try{ev=JSON.parse(line.slice(6));}catch{continue;}
        if(ev.type==='text') { accText+=ev.text; aDiv.innerHTML=md(accText); aDiv.appendChild(cursor); msgs&&(msgs.scrollTop=msgs.scrollHeight); }
      }
    }
    cursor.remove();
    if(accText) { aDiv.innerHTML=md(accText); S.vqaMsgs.push({role:'assistant',content:accText}); }
    const badge=$('vqa-badge');
    if(badge){badge.classList.remove('hidden');badge.textContent=Math.floor(S.vqaMsgs.length/2);}
  } catch(e) {
    cursor.remove(); aDiv.innerHTML=`<span style="color:var(--red)">Error: ${esc(e.message)}</span>`;
  } finally {
    S.vqaStreaming=false;
    if(sendBtn){sendBtn.disabled=false;sendBtn.innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';}
    msgs&&(msgs.scrollTop=msgs.scrollHeight);
  }
}

// ── Thumbnail Picker ──────────────────────────────────────────────────────────

function renderThumbnailPicker() {
  const tab = $('tab-thumbnail');
  if (!tab || !S.frames.length) { if(tab) tab.innerHTML='<div class="ap-sub" style="text-align:center;padding:30px;color:var(--text3)">Upload a video first</div>'; return; }

  const aiTs = S.editData?.thumbnail?.best_frame_timestamp;
  const aiSec = aiTs ? tcToSec(aiTs) : null;

  const panels = S.frames.map((f,i) => {
    const isAI = aiSec !== null && Math.abs(f.timestamp_sec - aiSec) < 2;
    return `
      <div class="thumb-panel${isAI?' thumb-panel-best':''}">
        ${isAI?'<div class="thumb-best-badge">⭐ AI Pick</div>':''}
        ${f.thumbnail_b64
          ?`<img class="sb-thumb" src="${f.thumbnail_b64}" alt="F${i+1}" loading="lazy"/>`
          :`<div class="sb-thumb sb-thumb-placeholder">F${i+1}</div>`}
        <div class="thumb-info">
          <span class="sb-tc">${fmt(f.timestamp_sec)}</span>
          <button class="thumb-dl-btn" onclick="downloadThumbnail(${f.timestamp_sec})">⬇ Save HD</button>
        </div>
      </div>`;
  }).join('');

  const aiNote = S.editData?.thumbnail ? `
    <div class="thumb-ai-rec">
      ⭐ <strong>AI recommends ${aiTs}</strong>${S.editData.thumbnail.text_overlay?` — "${esc(S.editData.thumbnail.text_overlay)}"`:''}<br/>
      ${S.editData.thumbnail.composition_notes?`<span style="font-size:11px;color:var(--text3)">${esc(S.editData.thumbnail.composition_notes)}</span>`:''}
    </div>` : '';

  tab.innerHTML = `
    ${aiNote}
    <div class="sb-header" style="margin-top:${aiNote?'10px':'0'}">
      <span><strong>${S.frames.length}</strong> frames — click Save HD to download full-resolution JPEG</span>
    </div>
    <div class="storyboard-grid">${panels}</div>`;
}

async function downloadThumbnail(ts) {
  if (!S.videoFile) { toast('Video file no longer in memory — re-upload to extract thumbnail', 'error'); return; }
  toast('Extracting high-res thumbnail…', 'info');
  const fd = new FormData(); fd.append('file', S.videoFile); fd.append('timestamp', ts);
  try {
    const resp = await fetch(`${API}/api/extract-thumbnail`, {method:'POST', body:fd});
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const base = (S.meta?.filename||'video').replace(/\.[^.]+$/,'');
    dlBlob(blob, `${base}_thumb_${Math.round(ts)}s.jpg`);
    toast('Thumbnail downloaded!', 'success');
  } catch(e) { toast(e.message,'error'); }
}

// ── Content Tab ───────────────────────────────────────────────────────────────

// Global store for copy-button text (avoids backtick escaping issues in onclick)
// ── Silence Detection ────────────────────────────────────────────────────

function detectSilences(threshold = 0.06, minDurSec = 0.8) {
  if (!S.audioWaveform.length || !S.meta) return [];
  const dur = S.meta.duration_sec;
  const n = S.audioWaveform.length;
  const silences = [];
  let silStart = null;
  for (let i = 0; i <= n; i++) {
    const amp = i < n ? S.audioWaveform[i] : 1; // sentinel ends silence
    const t = (i / n) * dur;
    if (silStart === null && amp < threshold) { silStart = t; }
    else if (silStart !== null && amp >= threshold) {
      if (t - silStart >= minDurSec) silences.push({start: silStart, end: t, dur: t - silStart});
      silStart = null;
    }
  }
  return silences;
}

function runSilenceDetect() {
  const threshEl = $('sil-thresh');
  const minEl = $('sil-min');
  const threshold = threshEl ? parseInt(threshEl.value) / 100 : 0.06;
  const minDur = minEl ? parseInt(minEl.value) / 10 : 0.8;
  const sils = detectSilences(threshold, minDur);

  const listEl = $('silence-list');
  const actEl = $('silence-actions');
  const sumEl = $('silence-summary');

  if (!listEl) return;

  if (!sils.length) {
    listEl.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:var(--text3)">No silences detected above threshold</div>';
    if (actEl) actEl.classList.add('hidden');
    return;
  }

  const totalSaved = sils.reduce((a, s) => a + s.dur, 0);
  listEl.innerHTML = sils.map(s => `
    <div class="silence-item">
      <span class="sil-icon">🔇</span>
      <span class="sil-tc" onclick="seekTo(${s.start.toFixed(2)})">${fmt(s.start)} → ${fmt(s.end)}</span>
      <span class="sil-dur">${s.dur.toFixed(1)}s</span>
    </div>`).join('');

  if (actEl) actEl.style.display = 'flex';
  if (actEl) actEl.classList.remove('hidden');
  if (sumEl) sumEl.textContent = `${sils.length} silences · ${totalSaved.toFixed(1)}s saved`;

  S._detectedSilences = sils;
}

async function removeSilences() {
  if (!S.videoFile) { toast('No video file', 'error'); return; }
  const sils = S._detectedSilences;
  if (!sils?.length) { toast('Detect silences first', 'error'); return; }

  toast('Removing silences… please wait', 'info');
  const fd = new FormData();
  fd.append('file', S.videoFile);
  fd.append('silences', JSON.stringify(sils));
  fd.append('color_grade', JSON.stringify(S.editData?.color_grade || {}));

  try {
    const resp = await fetch(`${API}/api/remove-silences`, {method:'POST', body:fd});
    if (!resp.ok) { const e = await resp.json().catch(()=>({detail:resp.statusText})); throw new Error(e.detail||'Failed'); }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${S.meta?.filename?.replace(/\.[^.]+$/,'')||'video'}_no_silence.mp4`;
    a.click(); URL.revokeObjectURL(url);
    toast(`Done! ${sils.length} silences removed`, 'success');
  } catch(e) {
    toast(e.message || 'Failed', 'error');
  }
}

// ── Color DNA Palette ─────────────────────────────────────────────────────

async function extractPaletteFromImg(src, n = 8) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = 40; c.height = 23;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 40, 23);
        const d = ctx.getImageData(0, 0, 40, 23).data;
        const buckets = {};
        for (let i = 0; i < d.length; i += 4) {
          const r = Math.round(d[i] / 28) * 28;
          const g = Math.round(d[i+1] / 28) * 28;
          const b = Math.round(d[i+2] / 28) * 28;
          if (d[i+3] < 128) continue;
          const k = `${r},${g},${b}`;
          buckets[k] = (buckets[k] || 0) + 1;
        }
        const colors = Object.entries(buckets)
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([k]) => {
            const [r,g,b] = k.split(',').map(Number);
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
          });
        resolve(colors);
      } catch { resolve([]); }
    };
    img.onerror = () => resolve([]);
    img.src = src;
  });
}

async function buildColorPalette() {
  const wrap = $('color-palette-wrap');
  if (!wrap || !S.frames.length) return;

  // Extract palette from up to 6 key frames (scene starts preferred)
  const sceneTs = new Set(S.scenes.map(s => Math.round(s.timestamp_sec)));
  const keyFrames = S.frames
    .filter(f => sceneTs.has(Math.round(f.timestamp_sec)) && f.thumbnail_b64)
    .slice(0, 6);
  if (!keyFrames.length) {
    const evenly = [0, Math.floor(S.frames.length/4), Math.floor(S.frames.length/2),
                    Math.floor(3*S.frames.length/4), S.frames.length-1];
    evenly.forEach(i => { if (S.frames[i]?.thumbnail_b64) keyFrames.push(S.frames[i]); });
  }

  const allColors = new Map();
  for (const f of keyFrames.slice(0, 5)) {
    const cols = await extractPaletteFromImg(f.thumbnail_b64, 6);
    cols.forEach(c => allColors.set(c, (allColors.get(c)||0) + 1));
  }

  const sorted = [...allColors.entries()]
    .sort((a,b) => b[1] - a[1])
    .slice(0, 12)
    .map(([c]) => c);

  if (!sorted.length) { wrap.innerHTML = '<span style="font-size:12px;color:var(--text3)">No frames available</span>'; return; }

  wrap.className = 'palette-wrap';
  wrap.innerHTML = sorted.map(hex => {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const luminance = (0.299*r + 0.587*g + 0.114*b) / 255;
    const textColor = luminance > 0.5 ? '#000' : '#fff';
    return `<div class="palette-swatch" style="background:${hex}" title="${hex}">
      <span class="palette-hex" style="color:${textColor}">${hex}</span>
    </div>`;
  }).join('');
}

// ── Multi-Format Export ───────────────────────────────────────────────────

async function exportAspectRatio(format) {
  if (!S.videoFile) { toast('No video file', 'error'); return; }
  if (format === 'original') { processVideoOp('color_grade'); return; }

  const {width: w, height: h} = S.meta || {width:1920, height:1080};
  let crop;

  if (format === 'shorts') {
    // Re-use existing shorts logic
    processVideoOp('shorts');
    return;
  } else if (format === 'square_1x1') {
    const sq = Math.min(w, h);
    const x = w > h ? Math.floor((w - sq) / 2) : 0;
    const y = h > w ? Math.floor((h - sq) / 2) : 0;
    crop = `crop=${sq}:${sq}:${x}:${y}`;
  } else if (format === 'portrait_4x5') {
    const th = Math.floor(w * 5 / 4);
    if (th <= h) {
      crop = `crop=${w}:${th}:0:${Math.floor((h - th) / 2)}`;
    } else {
      const tw = Math.floor(h * 4 / 5);
      crop = `crop=${tw}:${h}:${Math.floor((w - tw) / 2)}:0`;
    }
  } else if (format === 'cinema_21x9') {
    const ch = Math.floor(w * 9 / 21);
    crop = `crop=${w}:${ch}:0:${Math.floor((h - ch) / 2)}`;
  } else {
    return;
  }

  toast(`Exporting ${format.replace('_',' ')}…`, 'info');
  const fd = new FormData();
  fd.append('file', S.videoFile);
  fd.append('operation', 'custom_format');
  fd.append('crop_filter', crop);
  fd.append('color_grade', JSON.stringify(S.editData?.color_grade || {}));
  fd.append('edit_decisions', '[]');
  fd.append('shorts_clip', '{}');

  try {
    const resp = await fetch(`${API}/api/process-video`, {method:'POST', body:fd});
    if (!resp.ok) { const e = await resp.json().catch(()=>({detail:resp.statusText})); throw new Error(e.detail||'Failed'); }
    const blob = await resp.blob();
    const sizeMB = (blob.size/1024/1024).toFixed(1);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${S.meta?.filename?.replace(/\.[^.]+$/,'')||'video'}_${format}.mp4`;
    a.click(); URL.revokeObjectURL(url);
    toast(`${format} exported (${sizeMB} MB)`, 'success');
  } catch(e) {
    toast(e.message || 'Export failed', 'error');
  }
}

// ── AI Voiceover Script ───────────────────────────────────────────────────

async function generateVoiceover(style = 'documentary') {
  if (!S.editData) { toast('Run AI Edit first', 'error'); return; }
  const btn = $('voiceover-btn');
  const out = $('voiceover-output');
  if (btn) { btn.disabled = true; btn.textContent = '✍️ Writing…'; }
  if (out) { out.innerHTML = '<div style="color:var(--text3);font-size:12px">Generating voiceover script…</div>'; out.classList.remove('hidden'); }

  const fd = new FormData();
  fd.append('edit_data', JSON.stringify(S.editData));
  fd.append('style', style);

  let text = '';
  try {
    const resp = await fetch(`${API}/api/generate-voiceover`, {method:'POST', body:fd});
    if (!resp.ok) throw new Error('Failed');
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while(true) {
      const {done, value} = await reader.read(); if (done) break;
      buf += dec.decode(value, {stream:true});
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'text') { text += ev.text; if (out) out.innerHTML = `<div class="md-output">${md(text)}</div>`; }
        else if (ev.type === 'error') throw new Error(ev.message);
      }
    }
    toast('Voiceover script ready!', 'success');
  } catch(e) {
    if (out) out.innerHTML = `<div style="color:var(--red)">Error: ${e.message}</div>`;
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✍️ Generate Voiceover'; }
  }
}

// ── Caption Translation ───────────────────────────────────────────────────

async function translateCaptions() {
  if (!S.editData?.captions?.length) return;
  const langSel = $('cap-lang-sel');
  const lang = langSel?.value || 'Spanish';
  const btn = $('cap-translate-btn');
  if (btn) { btn.disabled = true; btn.textContent = '🌐 Translating…'; }

  const fd = new FormData();
  fd.append('captions', JSON.stringify(S.editData.captions));
  fd.append('target_language', lang);

  let translated = null;
  try {
    const resp = await fetch(`${API}/api/translate-captions`, {method:'POST', body:fd});
    if (!resp.ok) throw new Error('Translation request failed');
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while(true) {
      const {done,value} = await reader.read(); if (done) break;
      buf += dec.decode(value, {stream:true});
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'result') translated = ev.data;
        else if (ev.type === 'error') throw new Error(ev.message);
      }
    }
    if (!translated) throw new Error('No translation received');
    const capList = $('cap-list');
    if (capList) {
      capList.innerHTML = translated.map(c => `
        <div class="cap-item" onclick="seekTo(${srtTcToSec(c.start)})">
          <span class="cap-tc">${c.start||''} → ${c.end||''}</span>
          <span><span class="cap-speaker">${esc(c.speaker||'')}</span><span class="cap-text">${esc(c.text||'')}</span></span>
        </div>`).join('');
    }
    S.editData._translatedCaptions = translated;
    toast(`Translated to ${lang}!`, 'success');
  } catch(e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🌐 Translate'; }
  }
}

// ── AI Video Search ───────────────────────────────────────────────────────

async function videoSearch() {
  if (!S.frames.length) { toast('Upload and analyze a video first', 'info'); return; }
  const input = $('vsearch-input');
  const query = input?.value.trim();
  if (!query) { toast('Enter a search query', 'info'); return; }

  const btn = $('vsearch-btn');
  const resultEl = $('vsearch-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; }
  if (resultEl) resultEl.classList.add('hidden');

  const fd = new FormData();
  fd.append('query', query);
  fd.append('frame_ids', JSON.stringify(S.frames.map(f => f.file_id)));
  fd.append('timestamps', JSON.stringify(S.frames.map(f => f.timestamp_sec)));

  try {
    const resp = await fetch(`${API}/api/video-search`, {method:'POST', body:fd});
    if (!resp.ok) throw new Error('Search failed');
    const result = await resp.json();
    const ts = result.timestamp ?? result.timestamp_sec ?? 0;
    const pct = Math.round((result.confidence || 0) * 100);
    if (resultEl) {
      resultEl.className = 'vsearch-result';
      resultEl.innerHTML = `
        <span class="vsearch-ts" onclick="seekTo(${ts})" title="Jump to ${fmt(ts)}">▶ ${fmt(ts)}</span>
        <span class="vsearch-conf">${pct}% match</span>
        <span class="vsearch-reason">${esc(result.reason||'')}</span>`;
    }
    seekTo(ts);
    toast(`Found at ${fmt(ts)} (${pct}% confidence)`, 'success');
  } catch(e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Find'; }
  }
}

// ── Burn Subtitles ────────────────────────────────────────────────────────

async function burnSubtitles(style = 'default') {
  if (!S.videoFile) { toast('No video file', 'error'); return; }
  const caps = S.editData?._translatedCaptions || S.editData?.captions;
  if (!caps?.length) { toast('No captions — run AI Edit first', 'error'); return; }

  toast('Burning subtitles… this may take a moment', 'info');
  const fd = new FormData();
  fd.append('file', S.videoFile);
  fd.append('captions', JSON.stringify(caps));
  fd.append('style', style);

  try {
    const resp = await fetch(`${API}/api/burn-subtitles`, {method:'POST', body:fd});
    if (!resp.ok) { const e = await resp.json().catch(()=>({detail:resp.statusText})); throw new Error(e.detail||'Burn failed'); }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${S.meta?.filename?.replace(/\.[^.]+$/,'')||'video'}_subtitled_${style}.mp4`;
    a.click(); URL.revokeObjectURL(url);
    toast('Subtitled video downloaded!', 'success');
  } catch(e) {
    toast(e.message || 'Burn failed', 'error');
  }
}

// ── Highlight Reel ────────────────────────────────────────────────────────

async function exportHighlightReel() {
  if (!S.videoFile) { toast('No video file', 'error'); return; }
  const btn = $('proc-btn-highlight');
  const statusEl = $('proc-status-highlight');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="tool-spinner" style="width:12px;height:12px;border-color:rgba(255,255,255,.25);border-top-color:white;display:inline-block"></div> Processing…'; }
  if (statusEl) statusEl.innerHTML = '<div class="proc-anim"><div class="tool-spinner" style="width:11px;height:11px;border-color:rgba(255,255,255,.2);border-top-color:var(--accent)"></div> Generating highlight reel…</div>';

  const fd = new FormData();
  fd.append('file', S.videoFile);
  fd.append('edit_decisions', JSON.stringify(S.editData?.edit_decisions || []));
  fd.append('color_grade', JSON.stringify(S.editData?.color_grade || {}));
  fd.append('max_duration', '60');

  try {
    const resp = await fetch(`${API}/api/highlight-reel`, {method:'POST', body:fd});
    if (!resp.ok) { const e = await resp.json().catch(()=>({detail:resp.statusText})); throw new Error(e.detail||'Failed'); }
    const blob = await resp.blob();
    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${S.meta?.filename?.replace(/\.[^.]+$/,'')||'video'}_highlights.mp4`;
    a.click(); URL.revokeObjectURL(url);
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--green);font-size:11.5px">✓ Downloaded (${sizeMB} MB)</span>`;
    toast('Highlight reel ready!', 'success');
  } catch(e) {
    if (statusEl) statusEl.innerHTML = `<div style="color:var(--red);font-size:11.5px">✕ ${e.message}</div>`;
    toast(e.message || 'Export failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '⚡ Generate Highlights'; }
  }
}

const COPY_STORE = {};
let _cpIdx = 0;
function _store(text) { const k=`k${_cpIdx++}`; COPY_STORE[k]=text; return k; }
function copyStored(k) { navigator.clipboard.writeText(COPY_STORE[k]||'').then(()=>toast('Copied!','success')); }
function copyText(t) { navigator.clipboard.writeText(t).then(()=>toast('Copied!','success')); }

function tcToYTChapter(sec) {
  const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=Math.floor(sec%60);
  return h>0?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;
}

function colorGradeToCss(cg) {
  if (!cg) return '';
  const br = Math.max(0.5, Math.min(2, 1 + (cg.exposure||0)/15));
  const co = Math.max(0.5, Math.min(2.5, 1 + (cg.contrast||0)/100));
  const sa = Math.max(0, Math.min(3, 1 + ((cg.saturation||0)+(cg.vibrance||0)*0.4)/100));
  const sep = (cg.temperature||5500) < 4500 ? 0.25 : 0;
  const hue = (cg.temperature||5500) > 6500 ? -15 : ((cg.temperature||5500) < 4500 ? 20 : 0);
  return `brightness(${br.toFixed(2)}) contrast(${co.toFixed(2)}) saturate(${sa.toFixed(2)})${sep>0?` sepia(${sep})`:''}${hue!==0?` hue-rotate(${hue}deg)`:''}`;
}

function renderContentTab() {
  const tab = $('tab-content');
  if (!tab) return;

  if (!S.editData && !S.frames.length) {
    tab.innerHTML = '<div class="ap-sub" style="text-align:center;padding:30px;color:var(--text3)">Upload a video and run AI Edit to generate content</div>';
    return;
  }

  const d = S.editData || {};

  // Auto-chapters from scenes
  const chapters = (d.scenes||[]).filter(sc=>sc.keep!==false).map(sc=>({
    label: tcToYTChapter(tcToSec(sc.in_point||'0')),
    title: sc.title||`Scene ${sc.id||'?'}`,
  }));
  const chapText = chapters.map(c=>`${c.label} ${c.title}`).join('\n');
  const chapKey = _store(chapText);

  // Before/After preview
  const cg = d.color_grade || {};
  const cssFilter = colorGradeToCss(cg);
  const midFrame = S.frames[Math.floor(S.frames.length/2)];

  tab.innerHTML = `
    <div class="content-block">
      <div class="content-heading">📺 YouTube Chapters <span style="font-size:11px;color:var(--text3);font-weight:400">(auto-generated from AI scenes)</span></div>
      ${chapters.length ? `
        <div class="content-card">
          <pre class="content-code">${esc(chapText)}</pre>
          <button class="ff-copy" onclick="copyStored('${chapKey}')">Copy</button>
        </div>
      ` : '<div style="color:var(--text3);font-size:12.5px">Run AI Edit to generate chapters from scenes</div>'}
    </div>

    <div class="content-block">
      <div class="content-heading">🎨 Before / After Color Preview <span style="font-size:11px;color:var(--text3);font-weight:400">(CSS approximation of ${cg.style||'AI'} grade)</span></div>
      ${midFrame?.thumbnail_b64 ? `
        <div class="ba-wrap">
          <div class="ba-panel">
            <div class="ba-label">Original</div>
            <img class="ba-img" src="${midFrame.thumbnail_b64}" alt="Original"/>
            <div class="ba-stat">No filter</div>
          </div>
          <div class="ba-panel">
            <div class="ba-label">${esc(cg.style||'Color Graded')}</div>
            <img class="ba-img" src="${midFrame.thumbnail_b64}" alt="Graded" style="filter:${cssFilter}"/>
            <div class="ba-stat">Temp ${cg.temperature||5500}K · Exp ${cg.exposure>0?'+':''}${cg.exposure||0} · Sat ${cg.saturation>0?'+':''}${cg.saturation||0}</div>
          </div>
        </div>` : '<div style="color:var(--text3);font-size:12.5px">Frame thumbnails not available</div>'}
    </div>

    <div class="content-block">
      <div class="content-heading">✍️ Social Media Content Generator</div>
      <button class="upload-btn" style="padding:9px 18px;font-size:12.5px" id="gen-social-btn" onclick="generateSocialContent()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        Generate YouTube + TikTok + Instagram + X Content
      </button>
      <div id="social-content-result" style="margin-top:12px"></div>
    </div>

    <div class="content-block">
      <div class="content-heading">🎙 AI Voiceover Script Generator</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <select id="voiceover-style" class="model-select" style="padding:5px 24px 5px 8px;font-size:12px;width:auto">
          <option value="documentary">Documentary</option>
          <option value="news">News / Broadcast</option>
          <option value="commercial">Commercial / Ad</option>
          <option value="tutorial">Tutorial / How-To</option>
          <option value="storytelling">Cinematic Storytelling</option>
          <option value="podcast">Podcast / Conversational</option>
        </select>
        <button class="upload-btn" style="padding:8px 16px;font-size:12.5px" id="voiceover-btn" onclick="generateVoiceover($('voiceover-style').value)">
          ✍️ Generate Voiceover
        </button>
      </div>
      <div id="voiceover-output" class="voiceover-block hidden"></div>
    </div>
  `;
}

async function generateSocialContent() {
  if (!S.editData) { toast('Run AI Edit first', 'error'); return; }
  const btn = $('gen-social-btn'); const result = $('social-content-result');
  if (!btn || !result) return;

  btn.disabled = true;
  btn.innerHTML = '<div class="tool-spinner" style="width:12px;height:12px;border-color:rgba(255,255,255,.2);border-top-color:white;display:inline-block;vertical-align:middle;margin-right:6px"></div>Writing content…';
  result.innerHTML = '<div style="color:var(--text3);font-size:12.5px;padding:8px 0">Generating for YouTube, TikTok, Instagram, and X…</div>';

  const d = S.editData;
  const prompt = `Create a full social media content package for this video:
- Duration: ${fmt(S.meta?.duration_sec)} | Genre: ${d.genre||'Unknown'} | Score: ${d.overall_score||'?'}/10
- Summary: ${d.summary||'N/A'}
- Hook: "${d.shorts_clip?.hook_text||'N/A'}" | Virality: ${d.shorts_clip?.virality_score||'?'}/10
- Strengths: ${(d.top_strengths||[]).join(', ')}

Return ONLY this JSON (no markdown fences):
{"youtube":{"title":"SEO title <70 chars","description":"3 paragraphs with timestamps and CTA","tags":["tag1","tag2"]},"tiktok":{"hook":"First 3s script","caption":"<150 chars","hashtags":["#t1","#t2"]},"instagram":{"caption":"150 word caption","hashtags":["#h1","#h2"]},"twitter":{"tweet":"<280 chars","thread":["t1","t2","t3"]}}`;

  try {
    const resp = await fetch(`${API}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      messages:[{role:'user',content:prompt}],
      model:el.videoModelSel.value,
      enable_thinking:false,enable_web_search:false,enable_code_execution:false,
      system:'You are a professional social media content strategist. Output only valid JSON.',
    })});
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const reader=resp.body.getReader(); const dec=new TextDecoder(); let buf='', fullText='';
    while(true){const{done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split('\n');buf=lines.pop();for(const l of lines){if(!l.startsWith('data: '))continue;let ev;try{ev=JSON.parse(l.slice(6));}catch{continue;}if(ev.type==='text')fullText+=ev.text;}}
    let social;
    try { const clean=fullText.replace(/```(?:json)?\s*/g,'').replace(/```\s*$/,'').trim(); social=JSON.parse(clean); }
    catch { result.innerHTML=`<div class="text-content">${md(fullText)}</div>`; return; }
    result.innerHTML = renderSocialContent(social);
  } catch(e) {
    result.innerHTML=`<div style="color:var(--red);font-size:12.5px">Error: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled=false;
    btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Regenerate Content';
  }
}

function renderSocialContent(s) {
  const parts = [];
  if (s.youtube) {
    const yt=s.youtube, tk=_store((yt.tags||[]).join(', ')), dk=_store(yt.description||'');
    parts.push(`<div class="social-platform"><div class="social-ph">▶️ YouTube</div>
      <div class="social-field"><div class="social-label">Title</div><div class="social-val">${esc(yt.title||'')}</div><button class="ff-copy" onclick="copyStored('${_store(yt.title||'')}')">Copy</button></div>
      <div class="social-field"><div class="social-label">Description</div><div class="social-val social-desc">${esc(yt.description||'').replace(/\n/g,'<br>')}</div><button class="ff-copy" onclick="copyStored('${dk}')">Copy</button></div>
      ${yt.tags?.length?`<div class="social-field"><div class="social-label">Tags</div><div class="social-tags">${yt.tags.map(t=>`<span class="social-tag">${esc(t)}</span>`).join('')}</div><button class="ff-copy" onclick="copyStored('${tk}')">Copy All</button></div>`:''}
    </div>`);
  }
  if (s.tiktok) {
    const tt=s.tiktok, hk=_store((tt.hashtags||[]).join(' '));
    parts.push(`<div class="social-platform"><div class="social-ph">🎵 TikTok</div>
      ${tt.hook?`<div class="social-field"><div class="social-label">Hook (First 3s)</div><div class="social-val social-hook">"${esc(tt.hook)}"</div><button class="ff-copy" onclick="copyStored('${_store(tt.hook)}')">Copy</button></div>`:''}
      <div class="social-field"><div class="social-label">Caption</div><div class="social-val">${esc(tt.caption||'')}</div><button class="ff-copy" onclick="copyStored('${_store(tt.caption||'')}')">Copy</button></div>
      ${tt.hashtags?.length?`<div class="social-field"><div class="social-label">Hashtags</div><div class="social-tags">${tt.hashtags.map(t=>`<span class="social-tag">${esc(t)}</span>`).join('')}</div><button class="ff-copy" onclick="copyStored('${hk}')">Copy All</button></div>`:''}
    </div>`);
  }
  if (s.instagram) {
    const ig=s.instagram, hk=_store((ig.hashtags||[]).join(' '));
    parts.push(`<div class="social-platform"><div class="social-ph">📸 Instagram</div>
      <div class="social-field"><div class="social-label">Caption</div><div class="social-val social-desc">${esc(ig.caption||'').replace(/\n/g,'<br>')}</div><button class="ff-copy" onclick="copyStored('${_store(ig.caption||'')}')">Copy</button></div>
      ${ig.hashtags?.length?`<div class="social-field"><div class="social-label">Hashtags</div><div class="social-tags">${ig.hashtags.map(t=>`<span class="social-tag">${esc(t)}</span>`).join('')}</div><button class="ff-copy" onclick="copyStored('${hk}')">Copy All</button></div>`:''}
    </div>`);
  }
  if (s.twitter) {
    const tw=s.twitter;
    parts.push(`<div class="social-platform"><div class="social-ph">𝕏 Twitter / X</div>
      <div class="social-field"><div class="social-label">Tweet</div><div class="social-val">${esc(tw.tweet||'')}</div><button class="ff-copy" onclick="copyStored('${_store(tw.tweet||'')}')">Copy</button></div>
      ${tw.thread?.length?`<div class="social-field"><div class="social-label">Thread</div>${tw.thread.map((t,i)=>`<div class="social-thread-item"><span class="social-thread-num">${i+1}</span><span>${esc(t)}</span><button class="ff-copy" onclick="copyStored('${_store(t)}')">Copy</button></div>`).join('')}</div>`:''}
    </div>`);
  }
  return parts.join('');
}

// ── Cut preview ─────────────────────────────────────────────────────────────

let previewTimer = null;
function previewCut(inSec, outSec) {
  if (!el.vPlayer) return;
  clearTimeout(previewTimer);
  const dur = outSec - inSec;

  // Show a brief 1s preview around in_point, then jump to out_point context
  el.vPlayer.currentTime = Math.max(0, inSec - 0.3);
  el.vPlayer.play();

  // After showing the in_point, jump to out_point context
  previewTimer = setTimeout(() => {
    el.vPlayer.currentTime = Math.max(0, outSec - 0.3);
    // Auto-pause after 1.2s at out_point
    previewTimer = setTimeout(() => el.vPlayer.pause(), 1200);
  }, Math.min(1500, dur * 500 + 400));
}

// ── Storyboard ──────────────────────────────────────────────────────────────

function findNearestScene(timeSec) {
  if (!S.editData?.scenes?.length) return null;
  let best = null, bestDist = Infinity;
  for (const sc of S.editData.scenes) {
    const inS = tcToSec(sc.in_point);
    const outS = tcToSec(sc.out_point);
    if (timeSec >= inS - 0.5 && timeSec <= outS + 0.5) {
      const d = Math.abs(timeSec - inS);
      if (d < bestDist) { bestDist = d; best = sc; }
    }
  }
  return best;
}

function findNearestDecision(timeSec) {
  if (!S.editData?.edit_decisions?.length) return null;
  let best = null, bestDist = Infinity;
  for (const d of S.editData.edit_decisions) {
    const inS = tcToSec(d.in_point);
    const outS = tcToSec(d.out_point);
    if (timeSec >= inS - 0.5 && timeSec <= outS + 0.5) {
      const dist = Math.abs(timeSec - inS);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
  }
  return best;
}

function renderStoryboard() {
  const tab = $('tab-storyboard');
  if (!tab) return;

  if (!S.frames.length) {
    tab.innerHTML = `<div class="ap-sub" style="text-align:center;padding:40px;color:var(--text3)">Upload a video to see the storyboard</div>`;
    return;
  }

  const sceneSet = new Set(S.scenes.map(s => Math.round(s.timestamp_sec)));
  const hasAI = !!(S.editData);

  const panels = S.frames.map((frame, i) => {
    const sc = findNearestScene(frame.timestamp_sec);
    const dec = findNearestDecision(frame.timestamp_sec);
    const isSceneChange = sceneSet.has(Math.round(frame.timestamp_sec));
    const action = dec?.action || null;

    const badge = action
      ? `<span class="cut-action ${action}" style="font-size:9px;padding:1px 5px">${action}</span>`
      : '';
    const scoreEl = sc?.quality_score
      ? `<span style="color:var(--green);font-size:10px">★${sc.quality_score}</span>`
      : '';

    return `
      <div class="sb-panel${isSceneChange ? ' sb-scene-start' : ''}${action==='CUT' ? ' sb-panel-cut' : ''}" onclick="seekTo(${frame.timestamp_sec})">
        ${frame.thumbnail_b64
          ? `<img class="sb-thumb" src="${frame.thumbnail_b64}" alt="F${i+1}" loading="lazy"/>`
          : `<div class="sb-thumb sb-thumb-placeholder">F${i+1}</div>`}
        <div class="sb-info">
          <div class="sb-top">
            <span class="sb-tc">${fmt(frame.timestamp_sec)}</span>
            <div style="display:flex;gap:4px;align-items:center">${scoreEl}${badge}</div>
          </div>
          ${sc ? `<div class="sb-scene-title">${esc(sc.title || `Scene ${sc.id}`)}</div>` : `<div class="sb-scene-title" style="color:var(--text3)">Frame ${i+1}</div>`}
          ${sc?.mood ? `<div class="sb-reason">${sc.mood}</div>` : (dec?.reason ? `<div class="sb-reason">${esc((dec.reason||'').slice(0,55))}</div>` : '')}
        </div>
      </div>`;
  }).join('');

  const keptCount = S.editData?.edit_decisions?.filter(d => d.action !== 'CUT').length;
  const cutCount = S.editData?.edit_decisions?.filter(d => d.action === 'CUT').length;

  tab.innerHTML = `
    <div class="sb-header">
      <span>
        <strong>${S.frames.length}</strong> frames &nbsp;·&nbsp;
        <strong>${S.scenes.length}</strong> scene changes
        ${hasAI ? `&nbsp;·&nbsp; <span style="color:var(--green)">${keptCount} kept</span> &nbsp;·&nbsp; <span style="color:var(--red)">${cutCount} cut</span>` : ''}
      </span>
      <span style="font-size:11px;color:var(--text3)">Click any panel to jump in player${!hasAI ? ' · Run AI Edit for cut decisions' : ''}</span>
    </div>
    <div class="storyboard-grid">${panels}</div>
  `;
}

// ── Batch export ─────────────────────────────────────────────────────────────

async function batchExport() {
  if (!S.videoFile) { toast('No video loaded', 'error'); return; }
  if (!S.editData) { toast('Run AI Edit first to generate batch export data', 'error'); return; }
  if (S.batchExporting) return;

  S.batchExporting = true;
  const btn = $('batch-export-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="tool-spinner" style="width:12px;height:12px;border-color:rgba(255,255,255,.2);border-top-color:white;display:inline-block;vertical-align:middle;margin-right:6px"></div>Exporting 3 versions…`; }

  toast('Starting batch export (Full Edit + Shorts + Color Grade)…', 'info');

  const ops = ['full_edit','shorts','color_grade'];
  const results = await Promise.allSettled(ops.map(op => processVideoOp(op)));

  const failed = results.filter(r => r.status === 'rejected').length;
  S.batchExporting = false;
  if (btn) { btn.disabled = false; btn.innerHTML = '⚡ Batch Export All (3 versions)'; }

  if (failed === 0) toast('Batch export complete — all 3 versions downloaded!', 'success');
  else toast(`Batch export done (${3-failed}/3 succeeded)`, failed < 3 ? 'info' : 'error');
}

// ── Server-side video processing ────────────────────────────────────────────

const PROC_LABELS = {
  full_edit: 'AI Edit',
  shorts: 'Shorts Export',
  color_grade: 'Color Grade',
};

async function processVideoOp(operation) {
  if (!S.videoFile) { toast('No video loaded', 'error'); return; }

  const btn = $(`proc-btn-${operation}`);
  const statusEl = $(`proc-status-${operation}`);
  if (!btn || btn.disabled) return;

  // Disable all process buttons during processing
  ['full_edit','shorts','color_grade'].forEach(op => {
    const b = $(`proc-btn-${op}`);
    if (b) { b.disabled = true; b.style.opacity = '0.5'; }
  });

  const label = PROC_LABELS[operation] || operation;
  btn.innerHTML = `<div class="tool-spinner" style="width:12px;height:12px;border-color:rgba(255,255,255,.2);border-top-color:white"></div> Processing…`;
  if (statusEl) statusEl.innerHTML = `<div class="proc-anim">⚙️ Running FFmpeg — this may take a moment…</div>`;

  const fd = new FormData();
  fd.append('file', S.videoFile);
  fd.append('operation', operation);
  fd.append('edit_decisions', JSON.stringify(S.editData?.edit_decisions || []));
  fd.append('color_grade', JSON.stringify(S.editData?.color_grade || {}));
  fd.append('shorts_clip', JSON.stringify(S.editData?.shorts_clip || {}));

  try {
    const startTime = Date.now();
    const resp = await fetch(`${API}/api/process-video`, {method:'POST', body:fd});

    if (!resp.ok) {
      const e = await resp.json().catch(()=>({detail:resp.statusText}));
      if (resp.status === 503) {
        if (statusEl) statusEl.innerHTML = `<div style="color:var(--amber);font-size:11.5px">⚠️ FFmpeg not installed on server — use the .sh script instead</div>`;
        toast('FFmpeg not available on server', 'error');
      } else {
        throw new Error(e.detail || 'Processing failed');
      }
      return;
    }

    const blob = await resp.blob();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeKB = (blob.size / 1024).toFixed(0);
    const sizeMB = blob.size > 1024*1024 ? `${(blob.size/1024/1024).toFixed(1)} MB` : `${sizeKB} KB`;

    // Build filename from original
    const base = (S.meta?.filename || 'video').replace(/\.[^.]+$/, '');
    const suffix = {full_edit:'_edited',shorts:'_shorts_9x16',color_grade:'_color_graded'}[operation]||'_processed';
    dlBlob(blob, `${base}${suffix}.mp4`);

    if (statusEl) statusEl.innerHTML = `<div style="color:var(--green);font-size:11.5px">✓ Done in ${elapsed}s · ${sizeMB}</div>`;
    toast(`${label} complete! (${sizeMB})`, 'success');

  } catch(e) {
    if (statusEl) statusEl.innerHTML = `<div style="color:var(--red);font-size:11.5px">✕ ${e.message}</div>`;
    toast(e.message || 'Processing failed', 'error');
  } finally {
    // Re-enable buttons
    ['full_edit','shorts','color_grade'].forEach(op => {
      const b = $(`proc-btn-${op}`);
      if (b) { b.disabled = false; b.style.opacity = ''; }
    });
    if (btn) btn.innerHTML = '⚡ Process & Download';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// IMAGE INTELLIGENCE STUDIO
// ════════════════════════════════════════════════════════════════════════════

(function initImageStudio() {
  const imgDrop   = $('img-drop');
  const imgUpload = $('img-upload');
  const imgPickBtn = $('img-pick-btn');
  const imgFileInput = $('img-file-input');
  const imgProcessing = $('img-processing');
  const imgStudio  = $('img-studio');
  const imgProcSub = $('img-proc-sub');
  const imgReanalBtn = $('img-reanalyze-btn');
  const imgResetBtn  = $('img-reset-btn');
  const imgSidebarWebcamBtn = $('img-webcam-btn');
  const imgCamTriggerBtn = $('img-cam-trigger-btn');
  const imgWebcamPanel = $('img-webcam-panel');
  const imgWebcamVideo = $('img-webcam-video');
  const imgCaptureBtn  = $('img-capture-btn');
  const imgCamCloseBtn = $('img-cam-close-btn');

  let webcamStream = null;

  // ── File pick / drag & drop ──────────────────────────────────────────────
  imgPickBtn.addEventListener('click', () => imgFileInput.click());
  imgFileInput.addEventListener('change', e => { if (e.target.files[0]) loadImageFile(e.target.files[0]); e.target.value = ''; });

  imgDrop.addEventListener('dragover', e => { e.preventDefault(); imgDrop.classList.add('drag-over'); });
  imgDrop.addEventListener('dragleave', () => imgDrop.classList.remove('drag-over'));
  imgDrop.addEventListener('drop', e => {
    e.preventDefault(); imgDrop.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) loadImageFile(f);
    else toast('Please drop an image file', 'error');
  });

  // ── Webcam ───────────────────────────────────────────────────────────────
  function openWebcam() {
    imgWebcamPanel.classList.remove('hidden');
    imgDrop.style.display = 'none';
    navigator.mediaDevices.getUserMedia({video: {width: 1280, height: 720}, audio: false})
      .then(stream => { webcamStream = stream; imgWebcamVideo.srcObject = stream; })
      .catch(err => { toast('Camera access denied: ' + err.message, 'error'); closeWebcam(); });
  }
  function closeWebcam() {
    if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
    imgWebcamPanel.classList.add('hidden');
    imgDrop.style.display = '';
  }
  imgCamTriggerBtn.addEventListener('click', openWebcam);
  imgSidebarWebcamBtn.addEventListener('click', () => { if (S.mode !== 'image') { el.modeBtns.forEach(b => b.dataset.mode === 'image' && b.click()); } setTimeout(openWebcam, 50); });
  imgCamCloseBtn.addEventListener('click', closeWebcam);
  imgCaptureBtn.addEventListener('click', () => {
    const canvas = document.createElement('canvas');
    canvas.width  = imgWebcamVideo.videoWidth;
    canvas.height = imgWebcamVideo.videoHeight;
    canvas.getContext('2d').drawImage(imgWebcamVideo, 0, 0);
    closeWebcam();
    canvas.toBlob(blob => { const f = new File([blob], 'webcam-capture.jpg', {type:'image/jpeg'}); loadImageFile(f); }, 'image/jpeg', 0.92);
  });

  // ── Re-analyze / Reset ───────────────────────────────────────────────────
  imgReanalBtn.addEventListener('click', () => { if (S.imgFile) analyzeImage(S.imgFile); });
  imgResetBtn.addEventListener('click', resetImageStudio);

  function resetImageStudio() {
    S.imgFile = null; S.imgBlobUrl = null; S.imgFileId = null; S.imgAnalysis = null;
    S.imgChatMsgs = []; S.imgChatStreaming = false;
    imgUpload.classList.remove('hidden');
    imgProcessing.classList.add('hidden');
    imgStudio.classList.add('hidden');
    $('img-chat-messages').innerHTML = '';
  }

  // ── Load file ────────────────────────────────────────────────────────────
  window.loadImageFile = function(file) {
    if (!file.type.startsWith('image/')) { toast('Please select an image file', 'error'); return; }
    S.imgFile = file;
    if (S.imgBlobUrl) URL.revokeObjectURL(S.imgBlobUrl);
    S.imgBlobUrl = URL.createObjectURL(file);
    analyzeImage(file);
  };

  // ── Analyze ──────────────────────────────────────────────────────────────
  async function analyzeImage(file) {
    imgUpload.classList.add('hidden');
    imgStudio.classList.add('hidden');
    imgProcessing.classList.remove('hidden');
    if (imgProcSub) imgProcSub.textContent = 'Uploading to Claude…';

    const model = $('img-model-select')?.value || 'claude-opus-4-8';
    const fd = new FormData();
    fd.append('file', file);
    fd.append('model', model);

    try {
      const resp = await fetch(`${API}/api/analyze-image`, {method:'POST', body: fd});
      if (!resp.ok) { const e = await resp.json().catch(()=>({detail:resp.statusText})); throw new Error(e.detail || 'Analysis failed'); }

      if (imgProcSub) imgProcSub.textContent = 'AI analyzing…';

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let fileIdFromStream = null;

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'file_id') { fileIdFromStream = evt.file_id; S.imgFileId = evt.file_id; }
            if (evt.type === 'result') {
              let parsed = evt.data;
              if (typeof parsed === 'string') {
                const m = parsed.match(/```json\s*([\s\S]*?)\s*```/);
                if (m) parsed = JSON.parse(m[1]);
                else { const start = parsed.indexOf('{'); if (start !== -1) parsed = JSON.parse(parsed.slice(start)); }
              }
              S.imgAnalysis = parsed;
            }
          } catch { /* partial chunk, continue */ }
        }
      }

      // Reset chat since it's a new image
      S.imgChatMsgs = [];
      $('img-chat-messages').innerHTML = '';

      imgProcessing.classList.add('hidden');
      imgStudio.classList.remove('hidden');

      // Populate preview
      const prevImg = $('img-preview');
      prevImg.src = S.imgBlobUrl;
      const imgMetaDiv = $('img-meta');
      const dim = await getImageDimensions(S.imgBlobUrl);
      const kb = (file.size / 1024).toFixed(0);
      imgMetaDiv.innerHTML = `<span class="v-meta-item">📸 ${file.name}</span><span class="v-meta-item">${dim.w}×${dim.h}</span><span class="v-meta-item">${kb} KB</span><span class="v-meta-item">${file.type}</span>`;

      if (S.imgAnalysis) renderImageAnalysis(S.imgAnalysis);

      // Extract color palette from the preview
      buildImgPalette(S.imgBlobUrl);

    } catch(e) {
      imgProcessing.classList.add('hidden');
      imgUpload.classList.remove('hidden');
      toast(e.message || 'Analysis failed', 'error');
    }
  }

  function getImageDimensions(src) {
    return new Promise(res => {
      const i = new Image(); i.onload = () => res({w: i.naturalWidth, h: i.naturalHeight}); i.src = src;
    });
  }

  // ── Render analysis ──────────────────────────────────────────────────────
  window.renderImageAnalysis = function(d) {
    if (!d) return;

    // Description
    setText('img-desc', d.description || d.scene_description || '—');

    // Objects
    const objList = $('img-objects');
    if (objList) {
      const items = d.objects || d.main_subjects || [];
      objList.innerHTML = items.length
        ? items.map(o => {
            const name = typeof o === 'string' ? o : (o.name || o.object || JSON.stringify(o));
            const conf = typeof o === 'object' && o.confidence ? ` <span style="color:var(--text3);font-size:10px">${Math.round(o.confidence*100)}%</span>` : '';
            return `<span class="img-tag">${esc(name)}${conf}</span>`;
          }).join('')
        : '<span style="color:var(--text3);font-size:12px">No objects detected</span>';
    }

    // Faces
    const faces = d.faces || d.people || [];
    setText('img-faces', faces.length === 0
      ? 'No faces detected'
      : faces.map(f => {
          if (typeof f === 'string') return `• ${f}`;
          const parts = [];
          if (f.count !== undefined) parts.push(`${f.count} ${f.count === 1 ? 'person' : 'people'}`);
          if (f.age_range) parts.push(`Age: ${f.age_range}`);
          if (f.expression || f.emotion) parts.push(f.expression || f.emotion);
          if (f.gender) parts.push(f.gender);
          if (f.description) parts.push(f.description);
          return '• ' + (parts.join(' · ') || JSON.stringify(f));
        }).join('\n'));

    // Composition
    const comp = d.composition || {};
    setText('img-composition', typeof comp === 'string' ? comp : [
      comp.rule_of_thirds !== undefined ? `Rule of thirds: ${comp.rule_of_thirds ? '✓' : '✗'}` : '',
      comp.balance ? `Balance: ${comp.balance}` : '',
      comp.leading_lines ? `Leading lines: ${comp.leading_lines}` : '',
      comp.framing ? `Framing: ${comp.framing}` : '',
      comp.depth ? `Depth: ${comp.depth}` : '',
      comp.symmetry ? `Symmetry: ${comp.symmetry}` : '',
      comp.perspective ? `Perspective: ${comp.perspective}` : '',
      comp.notes ? comp.notes : '',
    ].filter(Boolean).join('\n') || JSON.stringify(comp));

    // Lighting
    const light = d.lighting || {};
    setText('img-lighting', typeof light === 'string' ? light : [
      light.type ? `Type: ${light.type}` : '',
      light.direction ? `Direction: ${light.direction}` : '',
      light.quality ? `Quality: ${light.quality}` : '',
      light.color_temperature ? `Color temp: ${light.color_temperature}` : '',
      light.shadows ? `Shadows: ${light.shadows}` : '',
      (d.mood || light.mood) ? `Mood: ${d.mood || light.mood}` : '',
    ].filter(Boolean).join('\n') || JSON.stringify(light));

    // Technical
    const tech = d.technical_details || d.technical || {};
    setText('img-technical', typeof tech === 'string' ? tech : [
      tech.estimated_focal_length ? `Focal length: ${tech.estimated_focal_length}` : '',
      tech.aperture ? `Aperture: ${tech.aperture}` : '',
      tech.depth_of_field ? `DoF: ${tech.depth_of_field}` : '',
      tech.shutter_speed ? `Shutter: ${tech.shutter_speed}` : '',
      tech.iso ? `ISO: ${tech.iso}` : '',
      tech.camera_angle ? `Angle: ${tech.camera_angle}` : '',
      tech.lens_type ? `Lens: ${tech.lens_type}` : '',
      tech.post_processing ? `Post: ${tech.post_processing}` : '',
    ].filter(Boolean).join('\n') || (Object.keys(tech).length ? JSON.stringify(tech) : 'No EXIF data available'));

    // Quality score
    const qual = d.quality || {};
    const score = qual.overall_score ?? qual.score ?? d.quality_score ?? null;
    const qParts = [];
    if (score !== null) qParts.push(`Overall: ${score}/10`);
    if (qual.sharpness) qParts.push(`Sharpness: ${qual.sharpness}`);
    if (qual.exposure) qParts.push(`Exposure: ${qual.exposure}`);
    if (qual.noise) qParts.push(`Noise: ${qual.noise}`);
    if (qual.color_accuracy) qParts.push(`Color: ${qual.color_accuracy}`);
    if (qual.composition_score) qParts.push(`Composition: ${qual.composition_score}`);
    setText('img-quality', qParts.join('\n') || (typeof qual === 'string' ? qual : JSON.stringify(qual)));

    // Score badge on preview
    if (score !== null) {
      const badges = $('img-overlay-badges');
      if (badges) badges.innerHTML = `<span class="img-score-badge">${score}/10</span>`;
    }

    // Strengths & Improvements
    const str = d.strengths || [];
    const imp = d.improvements || d.suggested_improvements || [];
    const strHtml = str.length ? `<div class="img-si-group"><div class="img-si-label" style="color:var(--green)">✓ Strengths</div>${str.map(s=>`<div class="img-si-item">• ${esc(s)}</div>`).join('')}</div>` : '';
    const impHtml = imp.length ? `<div class="img-si-group"><div class="img-si-label" style="color:var(--amber)">↑ Improvements</div>${imp.map(s=>`<div class="img-si-item">• ${esc(s)}</div>`).join('')}</div>` : '';
    const stEl = $('img-strengths');
    if (stEl) stEl.innerHTML = strHtml + impHtml || '<span style="color:var(--text3)">—</span>';

    // AI Regeneration prompt
    const prompt = d.ai_generation_prompt || d.generation_prompt || d.stable_diffusion_prompt || '';
    const pEl = $('img-prompt');
    if (pEl) { pEl.textContent = prompt || '—'; pEl.dataset.prompt = prompt; }

    // Edit suggestions
    const edits = d.edit_suggestions || d.editing_suggestions || [];
    setText('img-edits', edits.length
      ? edits.map((e,i) => `${i+1}. ${typeof e === 'string' ? e : (e.suggestion || JSON.stringify(e))}`).join('\n')
      : (d.style ? `Style: ${d.style}` : '—'));

    // Tags
    const tags = d.tags || d.keywords || [];
    const tagsEl = $('img-tags');
    if (tagsEl) {
      tagsEl.innerHTML = tags.length
        ? tags.map(t => `<span class="img-tag img-tag-sm">${esc(typeof t === 'string' ? t : String(t))}</span>`).join('')
        : '<span style="color:var(--text3);font-size:12px">—</span>';
    }
  };

  function setText(id, val) {
    const el = $(id); if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.textContent = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
  }

  // ── Color palette ─────────────────────────────────────────────────────────
  async function buildImgPalette(src) {
    const palEl = $('img-palette');
    if (!palEl) return;
    palEl.innerHTML = '<div class="palette-loading">Extracting colors…</div>';
    const colors = await extractPaletteFromImg(src, 10);
    if (!colors.length) { palEl.innerHTML = '<div class="palette-loading">Could not extract palette</div>'; return; }
    palEl.innerHTML = colors.map(hex => {
      const textColor = hexLuminance(hex) > 0.4 ? '#111' : '#fff';
      return `<div class="palette-swatch" style="background:${hex}" title="${hex}" onclick="copyText('${hex}')"><span class="palette-hex" style="color:${textColor}">${hex}</span></div>`;
    }).join('');
  }

  function hexLuminance(hex) {
    const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
    return 0.2126*r + 0.7152*g + 0.0722*b;
  }

  // ── Copy AI generation prompt ─────────────────────────────────────────────
  window.copyImagePrompt = function() {
    const el = $('img-prompt');
    const text = el?.dataset.prompt || el?.textContent || '';
    navigator.clipboard.writeText(text).then(() => toast('Prompt copied!', 'success')).catch(() => toast('Copy failed', 'error'));
  };

  // ── Image Q&A chat ────────────────────────────────────────────────────────
  window.sendImageChat = async function() {
    const input = $('img-chat-input');
    const text = input?.value.trim();
    if (!text || S.imgChatStreaming) return;
    if (!S.imgFileId) { toast('No image analyzed yet', 'error'); return; }
    input.value = '';

    S.imgChatMsgs.push({role:'user', content: text});
    const chatEl = $('img-chat-messages');
    chatEl.innerHTML += `<div class="img-chat-msg img-chat-user"><div class="img-chat-bubble">${esc(text)}</div></div>`;

    const aiBubble = document.createElement('div');
    aiBubble.className = 'img-chat-msg img-chat-ai';
    aiBubble.innerHTML = '<div class="img-chat-bubble"><div class="tool-spinner" style="width:14px;height:14px;display:inline-block"></div></div>';
    chatEl.appendChild(aiBubble);
    chatEl.scrollTop = chatEl.scrollHeight;
    S.imgChatStreaming = true;

    const model = $('img-model-select')?.value || 'claude-opus-4-8';
    const fd = new FormData();
    fd.append('file_id', S.imgFileId);
    fd.append('messages', JSON.stringify(S.imgChatMsgs));
    fd.append('model', model);

    try {
      const resp = await fetch(`${API}/api/image-chat`, {method:'POST', body:fd});
      if (!resp.ok) throw new Error((await resp.json().catch(()=>({}))).detail || resp.statusText);

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '', fullText = '';
      const bubble = aiBubble.querySelector('.img-chat-bubble');
      bubble.innerHTML = '';

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream:true});
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'text' && evt.text) {
              fullText += evt.text;
              bubble.innerHTML = md(fullText);
              hljs.highlightAll();
              chatEl.scrollTop = chatEl.scrollHeight;
            }
          } catch { /* ignore */ }
        }
      }

      S.imgChatMsgs.push({role:'assistant', content: fullText});
    } catch(e) {
      aiBubble.querySelector('.img-chat-bubble').textContent = '⚠ ' + e.message;
    } finally {
      S.imgChatStreaming = false;
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  };

})(); // end initImageStudio

// ── Global expose ───────────────────────────────────────────────────────────
window.copyCode = copyCode;
window.toggleThinking = h => { h.classList.toggle('collapsed'); h.parentElement.querySelector('.thinking-content').classList.toggle('hidden'); };
window.seekTo = seekTo;
window.downloadSRT = downloadSRT;
window.downloadEDL = downloadEDL;
window.downloadFFmpegScript = downloadFFmpegScript;
window.downloadJSON = downloadJSON;
window.copyFFmpeg = copyFFmpeg;
window.processVideoOp = processVideoOp;
window.batchExport = batchExport;
window.previewCut = previewCut;
window.renderStoryboard = renderStoryboard;
window.toggleVideoQA = toggleVideoQA;
window.sendVideoChat = sendVideoChat;
window.downloadThumbnail = downloadThumbnail;
window.renderContentTab = renderContentTab;
window.generateSocialContent = generateSocialContent;
window.copyStored = copyStored;
window.copyText = copyText;
window.translateCaptions = translateCaptions;
window.videoSearch = videoSearch;
window.burnSubtitles = burnSubtitles;
window.exportHighlightReel = exportHighlightReel;
window.runSilenceDetect = runSilenceDetect;
window.removeSilences = removeSilences;
window.exportAspectRatio = exportAspectRatio;
window.generateVoiceover = generateVoiceover;
// Image Studio (functions set inside IIFE, already on window)

// ── Init ────────────────────────────────────────────────────────────────────
el.input.focus();
