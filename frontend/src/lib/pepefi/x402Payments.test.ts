import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'

import { parsePaymentLog, summarizePayments, TRANSFER_TOPIC } from './x402Payments'

const AGENT = '0xd3c6a11ef5aF3D197Ecd0C9C44B15a23138d0EB7'
const SELLER = '0xB4a1EEF4bF5d3D7C8d9058f10A23f98D08f4e7b2'

/** A Circle USDC (6 decimals) Transfer log from the agent to the seller. */
const transferLog = (amount: bigint, block: number, tx = '0xabc') => ({
  transactionHash: tx,
  blockNumber: block,
  topics: [TRANSFER_TOPIC, ethers.zeroPadValue(AGENT, 32), ethers.zeroPadValue(SELLER, 32)],
  data: ethers.zeroPadValue(ethers.toBeHex(amount), 32),
})

describe('parsePaymentLog', () => {
  it('讀出付款人、金額（6 位小數）、區塊與交易', () => {
    expect(parsePaymentLog(transferLog(5_000n, 123, '0x01'))).toEqual({
      tx: '0x01',
      from: AGENT,
      amount: '0.005',
      block: 123,
    })
  })
})

describe('summarizePayments', () => {
  it('加總金額與筆數', () => {
    const payments = [transferLog(10_000n, 3), transferLog(5_000n, 2), transferLog(5_000n, 1)].map(parsePaymentLog)
    expect(summarizePayments(payments)).toEqual({ count: 3, feeUsd: 0.02 })
  })

  it('沒有付款時是 0 筆、0 元（不是 NaN）', () => {
    expect(summarizePayments([])).toEqual({ count: 0, feeUsd: 0 })
  })

  it('用最小單位加總，避免浮點誤差', () => {
    const payments = Array.from({ length: 10 }, (_, i) => parsePaymentLog(transferLog(1_000n, i))) // 10 × 0.001
    expect(summarizePayments(payments).feeUsd).toBe(0.01)
  })
})
