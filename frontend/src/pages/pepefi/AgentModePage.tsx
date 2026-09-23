// Agent Mode（/agent-mode）——給評審的一頁：不連錢包、不依賴 signal-api 或任何後端，
// 三分鐘內看懂 agent 付了什麼錢、被授權到多少、哪些下單被合約拒絕。
//
// 資料來源全部是鏈：
//   - x402 付費：Circle USDC 轉給訊號賣方的 Transfer 事件
//   - session 上限：AgentSessionManager.sessions(i)
//   - agent 動作：SessionOpenedPosition / SessionClosedPosition / SessionRevoked 事件
//   - 現場測試：eth_call 以 session agent 的身分模擬超額下單——eth_call 可以指定任意
//     from，所以評審不需要私鑰，回傳的就是合約本身的 revert
// 唯一不是即時讀鏈的是「被拒絕的交易」：revert 不產生事件，日誌裡掃不到，所以顯示
// agent/examples/e2e-demo.ts 最近一次執行寫出的 demoRun.json（每步附 BaseScan 連結）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ethers } from 'ethers'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import TableContainer from '@mui/material/TableContainer'
import CircularProgress from '@mui/material/CircularProgress'

import { t, interpolate } from 'src/locales'
import { getAddresses, ASSET_IDS, PRIMARY_CHAIN_ID } from 'src/contracts/addresses'
import { classifySimulationFailure } from 'src/lib/pepefi/simulationOutcome'
import { getSessionManagerAddress } from 'src/contracts/sessionManager'
import AgentSessionManagerABI from 'src/contracts/abi/AgentSessionManager.json'
import { deployBlock, describeScanWindow } from 'src/lib/pepefi/chainLogs'
import { mapLimit, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'
import { MONO, PEPE, shortAddr } from 'src/components/pepefi/brandKit'
import demoRun from 'src/lib/pepefi/demoRun.json'

// ----------------------------------------------------------------------

const CHAIN_ID = PRIMARY_CHAIN_ID
const READ_RPC = (import.meta.env.VITE_BASE_SEPOLIA_RPC_URL as string | undefined) ?? 'https://sepolia.base.org'
const CIRCLE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

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

type LogFilter = { address: string; topics: (string | string[] | null)[] }

/** Scan [from, to] on the first log RPC that answers every chunk. */
async function scanLogs(filter: LogFilter, from: number, to: number): Promise<ethers.Log[]> {
  let lastError: unknown = null
  for (const rpc of LOG_RPCS) {
    const p = new ethers.JsonRpcProvider(rpc.url, CHAIN_ID, { staticNetwork: true })
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
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')
const MAX_SESSIONS = 50
const basescanTx = (h: string) => `https://sepolia.basescan.org/tx/${h}`
const basescanAddr = (a: string) => `https://sepolia.basescan.org/address/${a}`

const iface = new ethers.Interface(AgentSessionManagerABI as ethers.InterfaceAbi)
const EVENT_TOPICS = ['SessionOpenedPosition', 'SessionClosedPosition', 'SessionRevoked'].map(
  (n) => iface.getEvent(n)!.topicHash,
)

interface Payment { tx: string; from: string; amount: string; block: number }
interface SessionRow {
  id: number; agent: string; perTrade: number; budget: number; spent: number
  maxLeverage: number; expiry: number; revoked: boolean
}
interface ActivityRow { tx: string; block: number; session: number; text: string }
interface TryResult { kind: 'rejected' | 'accepted' | 'error'; text: string }

const fmt18 = (v: bigint) => Number(ethers.formatUnits(v, 18))

function statusOf(s: SessionRow, now: number): 'active' | 'revoked' | 'expired' {
  if (s.revoked) return 'revoked'
  if (s.expiry <= now) return 'expired'
  return 'active'
}

// ----------------------------------------------------------------------

export default function AgentModePage() {
  const provider = useMemo(() => new ethers.JsonRpcProvider(READ_RPC, CHAIN_ID, { staticNetwork: true }), [])
  const addrs = getAddresses(CHAIN_ID)
  const managerAddr = getSessionManagerAddress(CHAIN_ID)
  const seller = demoRun.seller ?? ''

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [windowBlocks, setWindowBlocks] = useState(0)
  const [payments, setPayments] = useState<Payment[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [tryResult, setTryResult] = useState<Record<string, TryResult>>({})
  const [trying, setTrying] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const current = await provider.getBlockNumber()
      const from = deployBlock(CHAIN_ID) ?? Math.max(0, current - 50_000)
      setWindowBlocks(current - from)

      // x402 payments: Circle USDC → seller
      const payLogs = seller
        ? await scanLogs({
            address: CIRCLE_USDC,
            topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(seller, 32)],
          }, from, current)
        : []
      setPayments(
        payLogs
          .map((l) => ({
            tx: l.transactionHash as string,
            from: ethers.getAddress(ethers.dataSlice(l.topics[1], 12)),
            amount: ethers.formatUnits(BigInt(l.data), 6),
            block: Number(l.blockNumber),
          }))
          .sort((a, b) => b.block - a.block),
      )

      // Session caps
      const mgr = new ethers.Contract(managerAddr, AgentSessionManagerABI as ethers.InterfaceAbi, provider)
      const n = Math.min(Number(await mgr.nextSessionId()), MAX_SESSIONS)
      const rows = await mapLimit(Array.from({ length: n }, (_, i) => i), RPC_CONCURRENCY, async (id) => {
        const s = await mgr.sessions(id)
        return {
          id, agent: s.agent as string,
          perTrade: fmt18(s.maxMarginPerTrade), budget: fmt18(s.totalMarginBudget), spent: fmt18(s.spentMargin),
          maxLeverage: Number(s.maxLeverage), expiry: Number(s.expiry), revoked: Boolean(s.revoked),
        } satisfies SessionRow
      })
      setSessions(rows.sort((a, b) => b.id - a.id))

      // Agent actions
      const evLogs = await scanLogs({ address: managerAddr, topics: [EVENT_TOPICS] }, from, current)
      setActivity(
        evLogs
          .map((l) => {
            const p = iface.parseLog(l)
            if (!p) return null
            const session = Number(p.args.sessionId)
            const text =
              p.name === 'SessionOpenedPosition'
                ? interpolate(t.agentMode.activity.opened, {
                    position: String(p.args.positionId), margin: fmt18(p.args.margin).toString(),
                  })
                : p.name === 'SessionClosedPosition'
                  ? interpolate(t.agentMode.activity.closed, { position: String(p.args.positionId) })
                  : t.agentMode.activity.revoked
            return { tx: l.transactionHash as string, block: Number(l.blockNumber), session, text }
          })
          .filter((r): r is ActivityRow => r !== null)
          .sort((a, b) => b.block - a.block),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [provider, managerAddr, seller])

  useEffect(() => { void load() }, [load])

  const now = Math.floor(Date.now() / 1000)
  const sandbox = sessions.find((s) => statusOf(s, now) === 'active')

  /** Simulate an order from the session's own agent address. Nothing is signed or sent. */
  const tryOrder = useCallback(async (key: string, asset: string, margin: number) => {
    if (!sandbox || !addrs) return
    setTrying(key)
    try {
      const exchange = new ethers.Contract(addrs.PerpetualExchange, ['function executionFee() view returns (uint256)'], provider)
      const fee = (await exchange.executionFee()) as bigint
      const data = iface.encodeFunctionData('openPositionForSession', [
        sandbox.id, asset, true, ethers.parseUnits(String(margin), 18), 2, ethers.ZeroAddress,
      ])
      try {
        await provider.call({ from: sandbox.agent, to: managerAddr, data, value: fee })
        setTryResult((r) => ({ ...r, [key]: { kind: 'accepted', text: t.agentMode.tryIt.accepted } }))
      } catch (e) {
        const outcome = classifySimulationFailure(e, iface)
        const template = outcome.kind === 'rejected' ? t.agentMode.tryIt.rejected : t.agentMode.tryIt.simulationFailed
        setTryResult((r) => ({ ...r, [key]: { kind: outcome.kind, text: interpolate(template, { reason: outcome.reason }) } }))
      }
    } catch (e) {
      setTryResult((r) => ({ ...r, [key]: { kind: 'error', text: (e as Error).message } }))
    } finally {
      setTrying(null)
    }
  }, [sandbox, addrs, provider, managerAddr])

  const cellMono = { fontFamily: MONO, fontSize: 13 }
  const txLink = (h: string) => (
    <Link href={basescanTx(h)} target="_blank" rel="noopener" sx={cellMono}>{h.slice(0, 10)}…</Link>
  )

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Stack spacing={3}>
        {/* Header */}
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={2}>
          <Box>
            <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{t.agentMode.title}</Typography>
            <Typography variant="body1" color="text.secondary">{t.agentMode.subtitle}</Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center">
            {windowBlocks > 0 && (
              <Chip size="small" label={interpolate(t.agentMode.scanWindow, { window: describeScanWindow(CHAIN_ID, windowBlocks) })} />
            )}
            <Button variant="outlined" onClick={() => void load()} disabled={loading} sx={{ textTransform: 'none' }}>
              {loading ? <CircularProgress size={18} /> : t.agentMode.refresh}
            </Button>
          </Stack>
        </Stack>

        {error && <Alert severity="error">{interpolate(t.agentMode.readError, { error })}</Alert>}

        {/* How it works */}
        <Card sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 1.5 }}>{t.agentMode.howTitle}</Typography>
          <Stack spacing={1}>
            {t.agentMode.how.map((line, i) => (
              <Stack key={line} direction="row" spacing={1.5} alignItems="flex-start">
                <Chip size="small" label={i + 1} sx={{ bgcolor: PEPE.green, color: '#000', fontWeight: 'bold' }} />
                <Typography variant="body2">{line}</Typography>
              </Stack>
            ))}
          </Stack>
        </Card>

        {/* Try it */}
        <Card sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.agentMode.tryIt.title}</Typography>
          {sandbox ? (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 2 }}>
                {interpolate(t.agentMode.tryIt.caption, {
                  session: String(sandbox.id), margin: String(sandbox.perTrade + 30), cap: String(sandbox.perTrade),
                })}
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <Button variant="contained" disabled={trying !== null}
                  onClick={() => void tryOrder('overCap', ASSET_IDS.sBTC, sandbox.perTrade + 30)}
                  sx={{ textTransform: 'none' }}>
                  {t.agentMode.tryIt.button} · sBTC · {sandbox.perTrade + 30}
                </Button>
                <Button variant="outlined" disabled={trying !== null}
                  onClick={() => void tryOrder('asset', ASSET_IDS.sAAPL, 10)}
                  sx={{ textTransform: 'none' }}>
                  {t.agentMode.tryIt.button} · sAAPL · 10
                </Button>
              </Stack>
              <Stack spacing={1} sx={{ mt: 2 }}>
                {Object.entries(tryResult).map(([k, r]) => (
                  <Alert key={k} severity={r.kind === 'rejected' ? 'success' : r.kind === 'accepted' ? 'warning' : 'error'}
                    sx={{ fontFamily: MONO }}>{r.text}</Alert>
                ))}
              </Stack>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t.agentMode.tryIt.noSession}</Typography>
          )}
        </Card>

        {/* Sessions */}
        <Card sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.agentMode.sessions.title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t.agentMode.sessions.caption}</Typography>
          {sessions.length === 0 ? (
            <Typography variant="body2" color="text.secondary">{loading ? t.agentMode.loading : t.agentMode.sessions.empty}</Typography>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t.agentMode.sessions.colId}</TableCell>
                    <TableCell>{t.agentMode.sessions.colAgent}</TableCell>
                    <TableCell align="right">{t.agentMode.sessions.colPerTrade}</TableCell>
                    <TableCell align="right">{t.agentMode.sessions.colBudget}</TableCell>
                    <TableCell align="right">{t.agentMode.sessions.colLeverage}</TableCell>
                    <TableCell>{t.agentMode.sessions.colExpiry}</TableCell>
                    <TableCell>{t.agentMode.sessions.colStatus}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sessions.map((s) => {
                    const st = statusOf(s, now)
                    return (
                      <TableRow key={s.id}>
                        <TableCell sx={cellMono}>{s.id}</TableCell>
                        <TableCell><Link href={basescanAddr(s.agent)} target="_blank" rel="noopener" sx={cellMono}>{shortAddr(s.agent)}</Link></TableCell>
                        <TableCell align="right" sx={cellMono}>{s.perTrade}</TableCell>
                        <TableCell align="right" sx={cellMono}>{s.spent} / {s.budget}</TableCell>
                        <TableCell align="right" sx={cellMono}>{s.maxLeverage}x</TableCell>
                        <TableCell sx={cellMono}>{new Date(s.expiry * 1000).toISOString().slice(0, 10)}</TableCell>
                        <TableCell>
                          <Chip size="small" label={t.agentMode.sessions[st]}
                            color={st === 'active' ? 'success' : st === 'revoked' ? 'error' : 'default'} />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>

        {/* Payments */}
        <Card sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.agentMode.payments.title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {interpolate(t.agentMode.payments.caption, { seller: seller ? shortAddr(seller) : '—' })}
          </Typography>
          {payments.length === 0 ? (
            <Typography variant="body2" color="text.secondary">{loading ? t.agentMode.loading : t.agentMode.payments.empty}</Typography>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t.agentMode.payments.colFrom}</TableCell>
                    <TableCell align="right">{t.agentMode.payments.colAmount}</TableCell>
                    <TableCell>{t.agentMode.payments.colTx}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.tx}>
                      <TableCell sx={cellMono}>{shortAddr(p.from)}</TableCell>
                      <TableCell align="right" sx={cellMono}>{p.amount} USDC</TableCell>
                      <TableCell>{txLink(p.tx)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>

        {/* Activity */}
        <Card sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 2 }}>{t.agentMode.activity.title}</Typography>
          {activity.length === 0 ? (
            <Typography variant="body2" color="text.secondary">{loading ? t.agentMode.loading : t.agentMode.activity.empty}</Typography>
          ) : (
            <Stack spacing={1}>
              {activity.map((a) => (
                <Stack key={`${a.tx}-${a.text}`} direction="row" spacing={2} alignItems="center">
                  <Chip size="small" label={`#${a.session}`} />
                  <Typography variant="body2" sx={{ flex: 1 }}>{a.text}</Typography>
                  {txLink(a.tx)}
                </Stack>
              ))}
            </Stack>
          )}
        </Card>

        {/* Recorded run */}
        <Card sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.agentMode.recorded.title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {interpolate(t.agentMode.recorded.caption, { at: demoRun.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC' })}
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t.agentMode.recorded.colStep}</TableCell>
                  <TableCell>{t.agentMode.recorded.colActor}</TableCell>
                  <TableCell>{t.agentMode.recorded.colAction}</TableCell>
                  <TableCell>{t.agentMode.recorded.colResult}</TableCell>
                  <TableCell>{t.agentMode.recorded.colTx}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {demoRun.steps.map((s) => {
                  const rejected = s.result.startsWith('reverted')
                  return (
                    <TableRow key={s.n} sx={rejected ? { bgcolor: 'rgba(255,86,48,0.08)' } : undefined}>
                      <TableCell sx={cellMono}>{s.n}</TableCell>
                      <TableCell>{s.actor}</TableCell>
                      <TableCell sx={{ fontSize: 13 }}>{s.action}</TableCell>
                      <TableCell sx={{ fontSize: 13, color: rejected ? PEPE.short : undefined, fontWeight: rejected ? 'bold' : undefined }}>
                        {s.result}
                      </TableCell>
                      <TableCell>{s.tx ? txLink(s.tx) : <Typography variant="caption" color="text.secondary">{t.agentMode.recorded.offChain}</Typography>}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Stack>
    </Container>
  )
}
