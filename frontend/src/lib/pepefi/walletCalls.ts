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

interface WalletError { code?: number; message?: string }

/**
 * The wallet's own EIP-1193 error. ethers' BrowserProvider wraps it: ACTION_REJECTED and
 * UNSUPPORTED_OPERATION keep it in `info.error`, UNKNOWN_ERROR in `error`. The wrapper's own
 * `message` ends with "version=6.x", so never pattern-match the wrapper's message.
 */
export function walletError(e: unknown): WalletError {
  const err = (e ?? {}) as { code?: unknown; message?: string; shortMessage?: string; error?: WalletError; info?: { error?: WalletError } }
  const inner = err.info?.error ?? err.error
  if (inner && typeof inner === 'object') return { code: typeof inner.code === 'number' ? inner.code : undefined, message: inner.message }
  return { code: typeof err.code === 'number' ? err.code : undefined, message: err.shortMessage ?? err.message }
}

/** The user declined in the wallet (EIP-1193 4001; ethers: ACTION_REJECTED). */
export function isUserRejection(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'ACTION_REJECTED' || walletError(e).code === 4001
}

/** The wallet does not implement the method (as opposed to the user rejecting it). */
export function isUnsupportedMethod(e: unknown): boolean {
  if ((e as { code?: unknown } | null)?.code === 'UNSUPPORTED_OPERATION') return true
  const { code, message } = walletError(e)
  if (code === 4200 || code === -32601) return true
  return /does not exist|not supported|unsupported method|is not available|method not found/i.test(message ?? '')
}

/** The wallet refused the request's EIP-5792 version (an older wallet that only speaks 1.0). */
export function isVersionMismatch(e: unknown): boolean {
  if (isUserRejection(e)) return false
  return /version/i.test(walletError(e).message ?? '')
}

/**
 * wallet_getCapabilities result → can this wallet run an atomic batch on `chainId` as it is now?
 * "ready" (2.0.0) only means the wallet could upgrade the account first (EIP-7702), which would
 * not make it a Coinbase Smart Wallet, so it does not count.
 */
export function supportsAtomicBatch(caps: unknown, chainId: number): boolean {
  const c = ((caps ?? {}) as Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }>)[hex(chainId)]
  if (!c) return false
  if (c.atomic?.status) return c.atomic.status === 'supported'
  return c.atomicBatch?.supported === true
}
