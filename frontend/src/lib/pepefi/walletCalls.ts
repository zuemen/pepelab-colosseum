// EIP-5792 (wallet_sendCalls / wallet_getCallsStatus) helpers: a smart wallet such as a Base Account
// executes several calls as one atomic batch. Two shapes exist in the wild (1.0 and 2.0.0); both are
// handled so an older wallet still works.

export interface WalletCall { to: string; value: bigint; data: string }

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`

export function sendCallsParams(calls: readonly WalletCall[], from: string, chainId: number, version: '2.0.0' | '1.0' = '2.0.0') {
  const base = {
    version,
    chainId: hex(chainId),
    from,
    calls: calls.map((c) => ({ to: c.to, data: c.data, value: hex(c.value) })),
  }
  return [version === '2.0.0' ? { ...base, atomicRequired: true } : base]
}

export type CallsState = { state: 'pending' | 'confirmed' | 'failed'; txHash?: string }

/** wallet_getCallsStatus result → pending / confirmed / failed (+ the first receipt's tx hash). */
export function parseCallsStatus(result: unknown): CallsState {
  const r = (result ?? {}) as { status?: number | string; receipts?: { status?: string; transactionHash?: string }[] }
  const receipt = r.receipts?.[0]
  const txHash = receipt?.transactionHash
  const reverted = receipt?.status !== undefined && BigInt(receipt.status) === 0n
  const withHash = (state: CallsState['state']): CallsState => (txHash ? { state, txHash } : { state })

  if (typeof r.status === 'number') {
    if (r.status >= 100 && r.status < 200) return { state: 'pending' }
    if (r.status >= 200 && r.status < 300) return withHash(reverted ? 'failed' : 'confirmed')
    if (r.status >= 400) return withHash('failed')
    return { state: 'pending' }
  }
  if (r.status === 'CONFIRMED') return withHash(reverted ? 'failed' : 'confirmed')
  return { state: 'pending' }
}

/** The wallet does not implement the method (as opposed to the user rejecting it). */
export function isUnsupportedMethod(e: unknown): boolean {
  const err = e as { code?: number; error?: { code?: number }; message?: string }
  const code = err?.code ?? err?.error?.code
  if (code === 4200 || code === -32601) return true
  return /does not exist|not supported|unsupported method|is not available|method not found/i.test(err?.message ?? '')
}

/** wallet_getCapabilities result → can this wallet run an atomic batch on `chainId`? */
export function supportsAtomicBatch(caps: unknown, chainId: number): boolean {
  const c = ((caps ?? {}) as Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }>)[hex(chainId)]
  if (!c) return false
  if (c.atomic?.status) return c.atomic.status === 'supported' || c.atomic.status === 'ready'
  return c.atomicBatch?.supported === true
}
