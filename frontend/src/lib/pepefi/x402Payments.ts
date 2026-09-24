// x402 payments read straight from the chain: Circle USDC Transfer logs to the signal seller.
// Shared by the Agent Mode page (the payment table) and the landing KPIs (totals), so a public
// build without a hosted signal API still shows real numbers.
import { ethers } from 'ethers'

import { deployBlock } from 'src/lib/pepefi/chainLogs'

export const CIRCLE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
export const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')
export const READ_RPC =
  (import.meta.env.VITE_BASE_SEPOLIA_RPC_URL as string | undefined) ?? 'https://sepolia.base.org'

/**
 * Log RPCs, tried in order. sepolia.base.org caps eth_getLogs at 1,000 blocks
 * (measured 2026-09-23), so scanning from the deployment through a judging period
 * that runs into December would take thousands of calls. Tenderly's public gateway
 * answered a 3,000,000-block range in ~0.7 s with CORS open; publicnode caps at
 * 50,000 and is the fallback.
 */
const LOG_RPCS: readonly { url: string; chunk: number }[] = [
  { url: 'https://base-sepolia.gateway.tenderly.co', chunk: 1_000_000 },
  { url: 'https://base-sepolia-rpc.publicnode.com', chunk: 50_000 },
]

export type LogFilter = { address: string; topics: (string | string[] | null)[] }

/**
 * A read-only provider whose requests give up after `timeoutMs`. ethers' default is five
 * minutes, so a public RPC that hangs instead of failing would stall the page long before
 * the next log RPC in LOG_RPCS got a chance.
 */
export function readProvider(url: string, chainId: number, timeoutMs = 15_000): ethers.JsonRpcProvider {
  const req = new ethers.FetchRequest(url)
  req.timeout = timeoutMs
  return new ethers.JsonRpcProvider(req, chainId, { staticNetwork: true })
}

/** Scan [from, to] on the first log RPC that answers every chunk. */
export async function scanLogs(filter: LogFilter, from: number, to: number, chainId: number): Promise<ethers.Log[]> {
  let lastError: unknown = null
  for (const rpc of LOG_RPCS) {
    const p = readProvider(rpc.url, chainId)
    try {
      const out: ethers.Log[] = []
      for (let a = from; a <= to; a += rpc.chunk) {
        out.push(...(await p.getLogs({ ...filter, fromBlock: a, toBlock: Math.min(a + rpc.chunk - 1, to) })))
      }
      return out
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all log RPCs failed')
}

export interface Payment { tx: string; from: string; amount: string; block: number }

type TransferLogLike = { transactionHash: string; blockNumber: number | bigint; topics: readonly string[]; data: string }

/** One USDC Transfer log → one payment (USDC has 6 decimals). */
export function parsePaymentLog(l: TransferLogLike): Payment {
  return {
    tx: l.transactionHash,
    from: ethers.getAddress(ethers.dataSlice(l.topics[1], 12)),
    amount: ethers.formatUnits(BigInt(l.data), 6),
    block: Number(l.blockNumber),
  }
}

/** Totals in the same shape as the signal API's /revenue, summed in base units. */
export function summarizePayments(payments: readonly Payment[]): { count: number; feeUsd: number } {
  const total = payments.reduce((acc, p) => acc + ethers.parseUnits(p.amount, 6), 0n)
  return { count: payments.length, feeUsd: Number(ethers.formatUnits(total, 6)) }
}

/**
 * Every x402 payment to `seller` since this deployment, newest first. Also returns the
 * scanned block window so a page can say how far back it looked.
 */
export async function loadX402Payments(
  seller: string,
  chainId: number,
  provider: ethers.JsonRpcProvider = readProvider(READ_RPC, chainId),
): Promise<{ payments: Payment[]; fromBlock: number; toBlock: number }> {
  const toBlock = await provider.getBlockNumber()
  const fromBlock = deployBlock(chainId) ?? Math.max(0, toBlock - 50_000)
  const logs = seller
    ? await scanLogs({ address: CIRCLE_USDC, topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(seller, 32)] }, fromBlock, toBlock, chainId)
    : []
  const payments = logs.map((l) => parsePaymentLog(l as unknown as TransferLogLike)).sort((a, b) => b.block - a.block)
  return { payments, fromBlock, toBlock }
}
