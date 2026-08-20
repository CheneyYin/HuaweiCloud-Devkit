# 七夕赛博搭子 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-file web app: a humorous AI chat companion for Qixi Festival using DeepSeek API, deployed via Huawei Cloud DevStation sandbox.

**Architecture:** Single HTML file with embedded CSS and JS. API Key stored in browser localStorage, browser calls DeepSeek API directly. Served via `python3 -m http.server 8080` on a DevStation sandbox, exposed through devbridge tunnel.

**Tech Stack:** HTML5, CSS3, vanilla JavaScript (ES2020+), DeepSeek API (OpenAI-compatible chat/completions endpoint with SSE streaming), localStorage for persistence.

## Global Constraints

- Single file: `demos/qixi-companion/index.html`
- No frameworks, no build step, no external CSS/JS dependencies
- API Key NEVER in source code; user enters it in browser, stored in localStorage
- DeepSeek model: `deepseek-chat`
- Streaming via SSE (`stream: true`)
- Mobile responsive, max-width 600px
- Color scheme: dark purple gradient (#1a0a2e → #2d1b4e), pink accent (#ff6b9d)
- All error messages in playful Chinese tone matching the companion's personality

---

### Task 1: Create project directory and HTML skeleton

**Files:**

- Create: `demos/qixi-companion/index.html`

**Interfaces:**

- Produces: `index.html` with complete structural markup for settings panel + chat area + input area

- [ ] **Step 1: Create directory**

```bash
New-Item -ItemType Directory -Path "demos/qixi-companion" -Force
```

- [ ] **Step 2: Write the HTML skeleton with all structural elements**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>🌸 七夕赛博搭子</title>
    <style>
      /* Task 2 fills this in */
    </style>
  </head>
  <body>
    <div id="app">
      <header id="settings-bar">
        <div id="settings-toggle">⚙️</div>
        <div id="settings-content" class="expanded">
          <input type="password" id="api-key-input" placeholder="输入你的 DeepSeek API Key..." />
          <button id="save-key-btn">保存</button>
          <button id="clear-key-btn" style="display:none;">清除 Key</button>
          <span id="key-status"></span>
        </div>
      </header>
      <main id="chat-area">
        <div class="chat-header">
          <span>💬</span>
          <button id="clear-chat-btn">清空</button>
        </div>
        <div id="messages"></div>
      </main>
      <footer id="input-area">
        <textarea id="chat-input" placeholder="跟赛博搭子聊点什么..." rows="1"></textarea>
        <button id="send-btn" disabled>发送</button>
      </footer>
    </div>
    <canvas id="particles"></canvas>
    <script>
      // Task 3-5 fill this in
    </script>
  </body>
</html>
```

- [ ] **Step 3: Commit**

```bash
git add demos/qixi-companion/index.html
git commit -m "feat(qixi): add HTML skeleton for cyber companion app"
```

---

### Task 2: Add all CSS styling

**Files:**

- Modify: `demos/qixi-companion/index.html` (replace `<style>` placeholder)

**Interfaces:**

- Consumes: HTML structure from Task 1 (element IDs: `app`, `settings-bar`, `settings-toggle`, `settings-content`, `api-key-input`, `save-key-btn`, `clear-key-btn`, `key-status`, `chat-area`, `messages`, `input-area`, `chat-input`, `send-btn`, `particles`)

- [ ] **Step 1: Replace empty `<style>` block with full CSS**

Replace the `<style>/* Task 2 fills this in */</style>` placeholder with:

```css
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --bg-start: #1a0a2e;
  --bg-end: #2d1b4e;
  --accent: #ff6b9d;
  --accent-dim: rgba(255, 107, 157, 0.15);
  --text: #f0e6ff;
  --text-dim: rgba(240, 230, 255, 0.6);
  --bubble-companion: rgba(255, 255, 255, 0.08);
  --bubble-user: rgba(138, 43, 226, 0.35);
  --border: rgba(255, 255, 255, 0.1);
  --surface: rgba(255, 255, 255, 0.04);
}

body {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans SC', sans-serif;
  background: linear-gradient(135deg, var(--bg-start), var(--bg-end));
  color: var(--text);
  min-height: 100dvh;
  overflow: hidden;
}

#app {
  display: flex;
  flex-direction: column;
  max-width: 600px;
  height: 100dvh;
  margin: 0 auto;
  position: relative;
  z-index: 1;
}

/* Settings Bar */
#settings-bar {
  position: sticky;
  top: 0;
  background: rgba(26, 10, 46, 0.95);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  z-index: 10;
}
#settings-toggle {
  cursor: pointer;
  font-size: 20px;
  user-select: none;
  transition: transform 0.3s;
}
#settings-toggle.collapsed {
  transform: rotate(-90deg);
}
#settings-content {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  transition:
    max-height 0.3s,
    opacity 0.3s;
  max-height: 60px;
  opacity: 1;
}
#settings-content.hidden {
  max-height: 0;
  opacity: 0;
  pointer-events: none;
}
#api-key-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}
#api-key-input:focus {
  border-color: var(--accent);
}
#api-key-input::placeholder {
  color: var(--text-dim);
}
#save-key-btn,
#clear-key-btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
  transition: opacity 0.2s;
}
#save-key-btn {
  background: var(--accent);
  color: #fff;
}
#clear-key-btn {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}
#save-key-btn:hover,
#clear-key-btn:hover {
  opacity: 0.85;
}
#key-status {
  font-size: 13px;
  color: var(--text-dim);
  white-space: nowrap;
}

/* Chat Area */
#chat-area {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  scroll-behavior: smooth;
}
.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.chat-header span {
  font-size: 14px;
  color: var(--text-dim);
}
#clear-chat-btn {
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
#clear-chat-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
#messages {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
}
#messages:empty::before {
  content: '🌸 先设置 API Key，然后跟我聊天吧~';
  color: var(--text-dim);
  text-align: center;
  font-size: 16px;
  padding: 40px 20px;
  display: block;
}

.message {
  display: flex;
  gap: 8px;
  max-width: 85%;
  animation: fadeIn 0.3s ease;
}
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.message.companion {
  align-self: flex-start;
}
.message.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.message .avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.1);
}
.message.companion .avatar {
  background: rgba(255, 107, 157, 0.25);
}

.message .bubble {
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 15px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
}
.message.companion .bubble {
  background: var(--bubble-companion);
  border: 1px solid var(--border);
  border-top-left-radius: 4px;
}
.message.user .bubble {
  background: var(--bubble-user);
  border-top-right-radius: 4px;
}

.message .time {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 4px;
}

/* Typing indicator */
.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 10px 14px;
  align-self: flex-start;
  max-width: 85%;
}
.typing-indicator span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: bounce 1.4s infinite ease-in-out;
}
.typing-indicator span:nth-child(2) {
  animation-delay: 0.2s;
}
.typing-indicator span:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes bounce {
  0%,
  80%,
  100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

/* Input Area */
#input-area {
  position: sticky;
  bottom: 0;
  background: rgba(26, 10, 46, 0.95);
  backdrop-filter: blur(8px);
  border-top: 1px solid var(--border);
  padding: 10px 16px;
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
#chat-input {
  flex: 1;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 15px;
  font-family: inherit;
  resize: none;
  outline: none;
  max-height: 120px;
  transition: border-color 0.2s;
}
#chat-input:focus {
  border-color: var(--accent);
}
#chat-input::placeholder {
  color: var(--text-dim);
}
#send-btn {
  padding: 10px 18px;
  border-radius: 12px;
  border: none;
  background: var(--accent);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.2s;
}
#send-btn:hover {
  opacity: 0.85;
}
#send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Particles Canvas */
#particles {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}

/* Welcome placeholder override when has-key */
#messages.has-key:empty::before {
  content: '💬 七夕快乐~ 来跟赛博搭子聊聊天吧！';
}

/* Error message */
.error-msg {
  align-self: center;
  text-align: center;
  color: #ff8fa3;
  font-size: 14px;
  padding: 8px 16px;
  border-radius: 8px;
  background: rgba(255, 107, 157, 0.1);
}

/* Scrollbar */
#chat-area::-webkit-scrollbar {
  width: 4px;
}
#chat-area::-webkit-scrollbar-track {
  background: transparent;
}
#chat-area::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}
```

- [ ] **Step 2: Commit**

```bash
git add demos/qixi-companion/index.html
git commit -m "feat(qixi): add complete CSS styling with Qixi theme"
```

---

### Task 3: Implement API Key management + storage layer

**Files:**

- Modify: `demos/qixi-companion/index.html` (add JS to `<script>` block)

**Interfaces:**

- Consumes: HTML structure (Task 1), CSS (Task 2)
- Produces: `StorageManager` object with methods `getApiKey()`, `setApiKey(key)`, `clearApiKey()`, `getMessages()`, `saveMessages(msgs)`, `clearMessages()`

- [ ] **Step 1: Add JS for settings panel and storage**

Add to the empty `<script>` block:

```javascript
const StorageManager = {
  getApiKey() {
    try {
      return localStorage.getItem('deepseek_api_key') || '';
    } catch {
      return '';
    }
  },
  setApiKey(key) {
    try {
      localStorage.setItem('deepseek_api_key', key);
    } catch {}
  },
  clearApiKey() {
    try {
      localStorage.removeItem('deepseek_api_key');
    } catch {}
  },
  getMessages() {
    try {
      const raw = localStorage.getItem('chat_messages');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },
  saveMessages(msgs) {
    try {
      localStorage.setItem('chat_messages', JSON.stringify(msgs));
    } catch {}
  },
  clearMessages() {
    try {
      localStorage.removeItem('chat_messages');
    } catch {}
  },
};

const settingsToggle = document.getElementById('settings-toggle');
const settingsContent = document.getElementById('settings-content');
const apiKeyInput = document.getElementById('api-key-input');
const saveKeyBtn = document.getElementById('save-key-btn');
const clearKeyBtn = document.getElementById('clear-key-btn');
const keyStatus = document.getElementById('key-status');

function updateKeyUI() {
  const key = StorageManager.getApiKey();
  if (key) {
    const masked = key.length > 10 ? key.slice(0, 3) + '****' + key.slice(-4) : '已设置';
    keyStatus.textContent = 'Key: ' + masked;
    apiKeyInput.style.display = 'none';
    saveKeyBtn.style.display = 'none';
    clearKeyBtn.style.display = '';
    settingsContent.classList.add('hidden');
    settingsToggle.classList.add('collapsed');
    document.getElementById('messages').classList.add('has-key');
    document.getElementById('send-btn').disabled = false;
  } else {
    keyStatus.textContent = '';
    apiKeyInput.style.display = '';
    saveKeyBtn.style.display = '';
    clearKeyBtn.style.display = 'none';
    settingsContent.classList.remove('hidden');
    settingsToggle.classList.remove('collapsed');
    document.getElementById('messages').classList.remove('has-key');
    document.getElementById('send-btn').disabled = true;
  }
}

saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  StorageManager.setApiKey(key);
  apiKeyInput.value = '';
  updateKeyUI();
});

clearKeyBtn.addEventListener('click', () => {
  StorageManager.clearApiKey();
  updateKeyUI();
});

settingsToggle.addEventListener('click', () => {
  settingsContent.classList.toggle('hidden');
  settingsToggle.classList.toggle('collapsed');
});

updateKeyUI();
```

- [ ] **Step 2: Test manually** — open `index.html` in browser, verify key save/mask/clear/localStorage persistence

- [ ] **Step 3: Commit**

```bash
git add demos/qixi-companion/index.html
git commit -m "feat(qixi): add API key management with localStorage persistence"
```

---

### Task 4: Implement DeepSeek API client with streaming

**Files:**

- Modify: `demos/qixi-companion/index.html` (append JS to `<script>` block)

**Interfaces:**

- Consumes: `StorageManager.getApiKey()` from Task 3
- Produces: `streamChat(userMessage, history, onChunk, onDone, onError)` async function

- [ ] **Step 1: Add DeepSeek API streaming client**

Append to `<script>` block:

```javascript
const SYSTEM_PROMPT = `你是用户的七夕赛博搭子，一个擅长吐槽的幽默角色。你的风格：爱开玩笑但不过分、偶尔自黑、能接梗、吐槽精准但不伤人。今天是七夕节，你会时不时cue一下七夕的话题（比如别人都在过节你在跟我聊天，看来咱俩挺配的）。回复要简短有趣，控制在2-4句话。不要用"作为AI"这种开场白。用轻松口语化的中文聊天，可以适当使用网络流行语。`;

async function streamChat(userMessage, history, onChunk, onDone, onError) {
  const apiKey = StorageManager.getApiKey();
  if (!apiKey) {
    onError('请先设置 API Key');
    return;
  }

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: userMessage }];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 401) {
        onError('Key 不对，检查一下？');
        return;
      }
      if (response.status === 429) {
        onError('话太多了，歇会儿再聊~');
        return;
      }
      if (response.readyState >= 500) {
        onError('搭子大脑宕机了，稍后再试...');
        return;
      }
      onError('出了点问题（' + response.status + '），刷新试试？');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(delta);
          }
        } catch {}
      }
    }

    onDone(fullContent);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      onError('搭子反应有点慢，刷新重试一下？');
    } else {
      onError('网络走丢了，刷新试试？');
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add demos/qixi-companion/index.html
git commit -m "feat(qixi): add DeepSeek API streaming client"
```

---

### Task 5: Implement chat UI logic

**Files:**

- Modify: `demos/qixi-companion/index.html` (append JS to `<script>` block)

**Interfaces:**

- Consumes: `StorageManager` (Task 3), `streamChat` (Task 4), HTML structure (Task 1)
- Produces: Fully functional chat interface

- [ ] **Step 1: Add chat UI controller**

Append to `<script>` block:

```javascript
const messagesEl = document.getElementById('messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const chatArea = document.getElementById('chat-area');

let chatHistory = StorageManager.getMessages();
let isStreaming = false;

function formatTime(iso) {
  const d = new Date(iso);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function renderMessage(msg, isStreamingBubble) {
  const div = document.createElement('div');
  div.className = 'message ' + msg.role;
  div.innerHTML =
    '<div class="avatar">' +
    (msg.role === 'user' ? '🙂' : '🤖') +
    '</div>' +
    '<div><div class="bubble">' +
    escapeHtml(msg.content) +
    '</div>' +
    '<div class="time">' +
    (msg.time ? formatTime(msg.time) : '') +
    '</div></div>';

  if (isStreamingBubble) {
    div.id = 'streaming-bubble';
  }

  messagesEl.appendChild(div);
  scrollToBottom();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}

function showTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.id = 'typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  messagesEl.appendChild(div);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function showError(msg) {
  removeTypingIndicator();
  const div = document.createElement('div');
  div.className = 'error-msg';
  div.textContent = msg;
  messagesEl.appendChild(div);
  scrollToBottom();
  setTimeout(() => {
    if (div.parentNode) div.remove();
  }, 5000);
}

function setSendingState(sending) {
  isStreaming = sending;
  sendBtn.disabled = sending;
  chatInput.disabled = sending;
}

function renderHistory() {
  messagesEl.innerHTML = '';
  chatHistory = StorageManager.getMessages();
  chatHistory.forEach((msg) => renderMessage(msg, false));
  if (StorageManager.getApiKey()) {
    messagesEl.classList.add('has-key');
  }
  scrollToBottom();
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || isStreaming) return;

  if (!StorageManager.getApiKey()) {
    showError('先设置一下 API Key 才能聊天哦~');
    return;
  }

  const userMsg = { role: 'user', content: text, time: new Date().toISOString() };
  chatHistory.push(userMsg);
  StorageManager.saveMessages(chatHistory);

  renderMessage(userMsg, false);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  setSendingState(true);
  showTypingIndicator();

  const displayHistory = chatHistory.map((m) => ({ role: m.role, content: m.content }));

  let streamedContent = '';

  streamChat(
    text,
    displayHistory.slice(0, -1),
    (chunk) => {
      if (!streamedContent) {
        removeTypingIndicator();
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message companion';
        bubbleDiv.id = 'streaming-bubble';
        bubbleDiv.innerHTML =
          '<div class="avatar">🤖</div>' + '<div><div class="bubble"></div><div class="time"></div></div>';
        messagesEl.appendChild(bubbleDiv);
      }
      streamedContent += chunk;
      const bubble = document.querySelector('#streaming-bubble .bubble');
      if (bubble) bubble.textContent = streamedContent;
      scrollToBottom();
    },
    (fullContent) => {
      const streamingEl = document.getElementById('streaming-bubble');
      if (streamingEl) streamingEl.removeAttribute('id');

      const assistantMsg = { role: 'assistant', content: fullContent, time: new Date().toISOString() };
      chatHistory.push(assistantMsg);
      StorageManager.saveMessages(chatHistory);

      const timeEl = document.querySelector('.message.companion .time');
      if (timeEl) timeEl.textContent = formatTime(assistantMsg.time);

      setSendingState(false);
    },
    (errMsg) => {
      showError(errMsg);
      setSendingState(false);
    },
  );
}

sendBtn.addEventListener('click', sendMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

document.getElementById('clear-chat-btn').addEventListener('click', () => {
  if (isStreaming) return;
  StorageManager.clearMessages();
  chatHistory = [];
  messagesEl.innerHTML = '';
  if (StorageManager.getApiKey()) {
    messagesEl.classList.add('has-key');
  }
});

renderHistory();
```

- [ ] **Step 2: Commit**

```bash
git add demos/qixi-companion/index.html
git commit -m "feat(qixi): add full chat UI with streaming, history, and error handling"
```

---

### Task 6: Add Qixi particle animation

**Files:**

- Modify: `demos/qixi-companion/index.html` (append JS to `<script>` block)

**Interfaces:**

- Consumes: `<canvas id="particles">` from Task 1
- Produces: Floating petal/heart particle animation in background

- [ ] **Step 1: Add particle animation JS**

Append to `<script>` block:

```javascript
(function initParticles() {
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');
  const petals = [];
  const MAX = 20;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const shapes = ['🌸', '💮', '🩷', '✨'];

  for (let i = 0; i < MAX; i++) {
    petals.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: 14 + Math.random() * 18,
      speed: 0.3 + Math.random() * 0.7,
      drift: (Math.random() - 0.5) * 0.4,
      opacity: 0.12 + Math.random() * 0.2,
      shape: shapes[Math.floor(Math.random() * shapes.length)],
    });
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of petals) {
      p.y += p.speed;
      p.x += p.drift;

      if (p.y > canvas.height + 40) {
        p.y = -40;
        p.x = Math.random() * canvas.width;
      }
      if (p.x < -40) p.x = canvas.width + 40;
      if (p.x > canvas.width + 40) p.x = -40;

      ctx.font = p.size + 'px serif';
      ctx.globalAlpha = p.opacity;
      ctx.fillText(p.shape, p.x, p.y);
    }

    ctx.globalAlpha = 1;
    requestAnimationFrame(animate);
  }

  animate();
})();
```

- [ ] **Step 2: Commit**

```bash
git add demos/qixi-companion/index.html
git commit -m "feat(qixi): add floating petal/heart particle animation"
```

---

### Task 7: End-to-end verification (local)

**Files:**

- No changes to `index.html`; manual testing only

- [ ] **Step 1: Verify HTML file renders correctly**
  - Open `demos/qixi-companion/index.html` in browser
  - Confirm dark purple background, settings bar visible, chat area with placeholder text
  - Confirm responsive: resize to mobile width, layout adjusts

- [ ] **Step 2: Test API Key flow**
  - Enter a fake key `sk-test12345678`, click Save
  - Confirm: Key masked as `sk-****5678`, settings panel collapses, send button enables
  - Refresh page: Key persists, settings panel collapsed
  - Click gear icon: panel expands, click "Clear Key": resets to initial state

- [ ] **Step 3: Test chat with real DeepSeek API Key**
  - Enter valid DeepSeek API Key
  - Send a message: confirm typing indicator shows, then streaming reply appears
  - Send multiple messages: history renders correctly, scrolls to bottom
  - Refresh page: chat history restored from localStorage

- [ ] **Step 4: Test error cases**
  - Enter invalid key: confirm error "Key 不对，检查一下？" shows
  - Disconnect network: confirm "网络走丢了" error shows
  - Enter/Shift+Enter: confirm send vs newline behavior

---

### Task 8: Deploy to Huawei Cloud DevStation sandbox

**Files:**

- Upload: `demos/qixi-companion/index.html`

**Interfaces:**

- Consumes: HuaweiCloud DevKit sandbox tools
- Produces: Public URL accessible on web

- [ ] **Step 1: Load the huawei-sandbox skill and check user**

```bash
# Use huaweicloud_retrieve_skill to load huawei-sandbox
# Then: huaweicloud_sandbox_check_user
```

- [ ] **Step 2: Sign sandbox agreement if needed**

```bash
# huaweicloud_sandbox_sign_agreement
```

- [ ] **Step 3: Connect to sandbox and upload file**

```bash
# huaweicloud_sandbox_connect
# huaweicloud_sandbox_upload_file: source=demos/qixi-companion/index.html, target=/workspace/qixi-companion/index.html
```

- [ ] **Step 4: Start HTTP server and expose tunnel**

```bash
# huaweicloud_sandbox_exec: cd /workspace/qixi-companion && python3 -m http.server 8080
# huaweicloud_sandbox_exec: devbridge host -p 8080
```

- [ ] **Step 5: Verify public URL is accessible**

Visit the returned tunnel URL in browser, confirm the app loads and works.

- [ ] **Step 6: Commit deployment notes**

```bash
git commit --allow-empty -m "deploy(qixi): deployed cyber companion to sandbox"
```

---

### Task 9: Push to GitHub

**Files:**

- All committed files

- [ ] **Step 1: Verify all changes committed**

```bash
git status
```

- [ ] **Step 2: Push to remote**

```bash
git push
```
