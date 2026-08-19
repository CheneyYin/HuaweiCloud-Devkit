# 七夕赛博搭子 — Design Spec

**Date:** 2026-08-20  
**Status:** Draft

## Overview

A single-page web app: a humorous/sarcastic AI chat companion for Qixi Festival (Chinese Valentine's Day). Users chat with a "cyber companion" powered by DeepSeek API. Mobile and desktop responsive, deployed via Huawei Cloud DevStation sandbox with a public devbridge tunnel URL.

## Goals

- Chat with an AI companion that has a 吐槽 (roast/sarcastic) personality
- Responsive UI works on phone and desktop
- Public URL for sharing (sandbox + devbridge tunnel)
- API Key never exposed in source code or through the tunnel
- Conversation persists across page refreshes
- Qixi-themed visual atmosphere

## Non-Goals

- User accounts / login
- Multi-user chat rooms
- Backend server / database
- File/image uploads
- Voice chat

## Architecture

```
┌─────────────────────────────────────────────┐
│                User's Browser                │
│  ┌───────────────────────────────────────┐  │
│  │         Single HTML File              │  │
│  │  ┌─────────┐  ┌────────────────────┐  │  │
│  │  │ Settings │  │    Chat Area       │  │  │
│  │  │ Panel    │  │  Messages + Input  │  │  │
│  │  └─────────┘  └────────────────────┘  │  │
│  │          localStorage                 │  │
│  │    (API Key + Chat History)           │  │
│  └───────────────────────────────────────┘  │
│                    │                         │
│                    │ HTTPS (API Key here)    │
│                    ▼                         │
│           api.deepseek.com                  │
│           (chat/completions)                │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│         Huawei Cloud DevStation Sandbox     │
│  ┌───────────────────────────────────────┐  │
│  │  python -m http.server 8080           │  │
│  │  (serves the static HTML file only)    │  │
│  └───────────────────────────────────────┘  │
│                    │                         │
│                    │ devbridge tunnel        │
│                    ▼                         │
│  https://<id>-8080.cn-north-4-bridge.       │
│  myhuaweicloud.com                          │
└─────────────────────────────────────────────┘
```

**Key security property:** The API key travels only between the user's browser and DeepSeek's API. It never passes through the sandbox or devbridge tunnel. The served HTML file contains no API key.

## Components

### 1. API Key Settings Panel

- Collapsible bar at the top of the page
- Input field with type=password (masked during entry)
- On save: stored in localStorage under `deepseek_api_key`
- Saved key displayed as `sk-****abcd` (first 3 + last 4 visible)
- "Clear Key" button removes from localStorage
- Panel auto-collapses 2 seconds after key is saved
- When no key is saved, panel stays expanded with prompt text

### 2. Chat Interface

- Message bubbles: companion on left (avatar + name), user on right
- Scrollable message area, auto-scroll to bottom on new message
- Text input + send button at bottom
- Enter key sends, Shift+Enter for newline
- Typing indicator (three dots animation) while waiting for API response
- Timestamp on each message (HH:MM)
- "Clear chat" button to wipe conversation history

### 3. Personality System Prompt

Injected as the `system` message in every DeepSeek API call:

> 你是用户的七夕赛博搭子，一个擅长吐槽的幽默角色。你的风格：爱开玩笑但不过分、偶尔自黑、
> 能接梗、吐槽精准但不伤人。今天是七夕节，你会时不时cue一下七夕的话题（比如"别人都在过节
> 你在跟我聊天，看来咱俩挺配"）。回复要简短有趣，控制在2-4句话。不要用"作为AI"这种开场白。
> 用轻松口语化的中文聊天，可以适当使用网络流行语。

### 4. LocalStorage Schema

```
deepseek_api_key:   string  (user's API key, masked in UI)
chat_messages:      JSON    (array of {role, content, time})
```

Each message: `{role: "user"|"assistant", content: string, time: ISO string}`

### 5. DeepSeek API Call

- Endpoint: `POST https://api.deepseek.com/v1/chat/completions`
- Auth: `Authorization: Bearer <api_key>`
- Model: `deepseek-chat`
- Body: `{model, messages: [{role: "system", content: <personality>}, ...history, {role: "user", content: <input>}]}`
- Streaming: `stream: true` with Server-Sent Events parsing for real-time typing effect

## UI Design

### Color Palette

- Background: deep gradient `#1a0a2e` → `#2d1b4e` (dark purple, Qixi night sky)
- Companion bubble: `rgba(255, 255, 255, 0.1)` with purple border
- User bubble: `rgba(138, 43, 226, 0.3)` (blueviolet tint)
- Accent: `#ff6b9d` (pink, for buttons and highlights)
- Text: `#f0e6ff` (light lavender)

### Layout

- Max width 600px centered, full height viewport
- Settings panel: 48px tall, sticky top
- Chat area: flex-grow, scrollable
- Input area: 56px tall, sticky bottom
- Font: system font stack, 16px base

### Atmosphere

- Subtle floating petal/heart particles in background (CSS animation, low opacity)
- Page title: "🌸 七夕赛博搭子" with gradient text
- Companion avatar: an emoji (🤖 or 🌸) in a small circle
- Smooth message appear animation

## Error Handling

| Scenario | Handling |
|----------|-----------|
| No API Key set | Show prompt in chat area: "先设置一下 API Key 才能开始吐槽哦~" |
| API returns 401 | Show error: "Key 不对，检查一下？" |
| API returns 429 | Show error: "话太多了，歇会儿再聊~" with retry hint |
| Network error | Show error: "网络走丢了，刷新试试？" |
| API timeout (30s) | Abort fetch, show timeout message |
| Empty input | Send button disabled, no-op on Enter |
| JSON parse error on SSE | Skip malformed chunk, continue streaming |

## Deployment

1. Upload the HTML file to DevStation sandbox via `sandbox_upload_file`
2. Start HTTP server: `python3 -m http.server 8080`
3. Expose tunnel: `devbridge host -p 8080`
4. Return the public URL to user

No build step. No dependencies. Single file.

## Edge Cases

- **First visit:** Settings panel expanded, chat area shows welcome message
- **Returning visit with key:** Settings panel collapsed, previous chat history loaded
- **Very long messages:** Chat bubbles wrap text, max-width 80% of container
- **Rapid sending:** Disable send button during API call, re-enable on response
- **Empty chat history:** Show a cute placeholder message
- **Mobile keyboard:** Input area stays above keyboard (viewport height handling)