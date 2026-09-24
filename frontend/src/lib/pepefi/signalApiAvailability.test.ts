import { describe, it, expect } from 'vitest'

import { isPublicSignalApi } from './signalApi'

describe('isPublicSignalApi', () => {
  it('正式建置指向公開網址 → 可用', () => {
    expect(isPublicSignalApi('https://signals.example.com', false)).toBe(true)
  })

  it('正式建置仍指向本機 → 不可用（公開網頁連 localhost 一定失敗，瀏覽器還會跳區域網路權限提示）', () => {
    expect(isPublicSignalApi('http://localhost:4021', false)).toBe(false)
    expect(isPublicSignalApi('http://127.0.0.1:4021', false)).toBe(false)
    expect(isPublicSignalApi('http://[::1]:4021', false)).toBe(false)
    expect(isPublicSignalApi('http://0.0.0.0:4021', false)).toBe(false)
  })

  it('同網域的相對路徑（例如反向代理的 /api）→ 可用', () => {
    expect(isPublicSignalApi('/api', false)).toBe(true)
  })

  it('開發模式一律可用（本機 signal-api 就是開發時的正常設定）', () => {
    expect(isPublicSignalApi('http://localhost:4021', true)).toBe(true)
  })

  it('空字串或無法解析的網址 → 不可用', () => {
    expect(isPublicSignalApi('', false)).toBe(false)
    expect(isPublicSignalApi('not a url', false)).toBe(false)
  })
})
