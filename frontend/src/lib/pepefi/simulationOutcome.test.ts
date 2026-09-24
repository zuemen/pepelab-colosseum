import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'

import { classifySimulationFailure } from './simulationOutcome'

const iface = new ethers.Interface(['error MarginExceedsCap(uint256 margin, uint256 cap)'])
const encoded = iface.encodeErrorResult('MarginExceedsCap', [130n, 100n])

describe('classifySimulationFailure', () => {
  it('合約的自訂錯誤 → 合約拒絕，顯示解碼後的名稱與參數', () => {
    expect(classifySimulationFailure({ code: 'CALL_EXCEPTION', data: encoded }, iface)).toEqual({
      kind: 'rejected',
      reason: 'MarginExceedsCap(130, 100)',
    })
  })

  it('revert data 放在 info.error.data（ethers v6 的另一種形狀）也認得', () => {
    expect(classifySimulationFailure({ info: { error: { data: encoded } } }, iface).kind).toBe('rejected')
  })

  it('有 revert data 但 ABI 不認得（例如 exchange 的錯誤）→ 仍是合約拒絕，顯示 selector', () => {
    expect(classifySimulationFailure({ data: '0xdeadbeef00' }, iface)).toEqual({
      kind: 'rejected',
      reason: '0xdeadbeef',
    })
  })

  it('格式壞掉的 revert data 不會讓解碼例外往外拋', () => {
    expect(classifySimulationFailure({ data: '0x12' }, iface)).toEqual({ kind: 'rejected', reason: '0x12' })
  })

  it('沒有 revert data 但 ethers 判定是 CALL_EXCEPTION → 仍是合約拒絕，只是沒有原因', () => {
    // bare revert()，或 sepolia.base.org 只回 {"code":3,"message":"execution reverted"} 的情況
    expect(classifySimulationFailure({ code: 'CALL_EXCEPTION', data: '0x', message: 'missing revert data' }, iface)).toEqual({
      kind: 'rejected',
      reason: null,
    })
    expect(classifySimulationFailure({ code: 'CALL_EXCEPTION', data: null }, iface).kind).toBe('rejected')
  })

  it('不是 CALL_EXCEPTION 的錯誤（RPC、網路）→ 模擬失敗，不能說成合約拒絕', () => {
    expect(classifySimulationFailure(new Error('could not detect network'), iface)).toEqual({
      kind: 'error',
      reason: 'could not detect network',
    })
    expect(classifySimulationFailure({ code: 'NETWORK_ERROR', message: 'fetch failed' }, iface).kind).toBe('error')
  })
})
