import { describe, it, expect } from 'vitest'

import { plainStep } from './recordedRun'

describe('plainStep', () => {
  it('圓圈數字換成一般數字，後綴保留', () => {
    expect(plainStep('①a')).toBe('1a')
    expect(plainStep('⑧')).toBe('8')
    expect(plainStep('⑳')).toBe('20')
  })

  it('其他字元不動', () => {
    expect(plainStep('3b')).toBe('3b')
  })
})
