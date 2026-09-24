// Base Account + Base Spend Permission setup in one EIP-5792 batch (see src/lib/pepefi/baseAccountSetup.ts).
// The batch is the same one that ran on Base Sepolia on 2026-09-24 (demo/SPEND_PERMISSIONS_RUN.md);
// a test pins the encoding to that transaction.
import { useEffect, useState } from 'react'
import { ethers, isAddress, parseUnits, formatUnits } from 'ethers'

import Card from '@mui/material/Card'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { explorerTx } from 'src/lib/pepefi/notify'
import { MONO } from 'src/components/pepefi/brandKit'
import { getSessionManagerAddress } from 'src/contracts/sessionManager'
import { ASSET_IDS, getAddresses } from 'src/contracts/addresses'
import { MAX_UINT48, SPEND_PERMISSION_MANAGER, buildSetupCalls, permissionJsonOf } from 'src/lib/pepefi/baseAccountSetup'
import { isUnsupportedMethod, parseCallsStatus, sendCallsParams, supportsAtomicBatch } from 'src/lib/pepefi/walletCalls'

const BASE_SEPOLIA = 84532
const RECORDED_RUN = 'https://github.com/zuemen/pepelab-colosseum/blob/hackathon/colosseum-worldsfair/demo/SPEND_PERMISSIONS_RUN.md'
const WALLET = new ethers.Interface(['function isOwnerAddress(address account) view returns (bool)'])
const ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)'])

/** What the connected account can do. */
type AccountKind = 'checking' | 'smart' | 'smartAddOwner' | 'undeployed' | 'notSmart' | 'notCoinbase'

interface Props {
  agent: string
  perTrade: string
  budget: string
  maxLeverage: string
  hours: string
  /** Called after the batch confirms, to refresh the session list. */
  onDone: () => void
}

export default function BaseAccountSetupCard({ agent, perTrade, budget, maxLeverage, hours, onDone }: Props) {
  const wallet = usePepefiWallet()
  const [allowance, setAllowance] = useState('100')
  const [kind, setKind] = useState<AccountKind>('checking')
  const [balance, setBalance] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ severity: 'success' | 'error' | 'info'; text: string; txHash?: string } | null>(null)
  const [permission, setPermission] = useState<string | null>(null)

  const onBaseSepolia = wallet.chainId === BASE_SEPOLIA

  // Classify the connected account: deployed Coinbase Smart Wallet (with or without
  // SpendPermissionManager as owner), a wallet that will deploy one, or neither.
  useEffect(() => {
    const provider = wallet.provider
    const address = wallet.address
    if (!provider || !address || !onBaseSepolia) return undefined
    let alive = true
    setKind('checking')
    ;(async () => {
      let next: AccountKind
      const code = await provider.getCode(address)
      if (code !== '0x') {
        try {
          const raw = await provider.call({ to: address, data: WALLET.encodeFunctionData('isOwnerAddress', [SPEND_PERMISSION_MANAGER]) })
          next = WALLET.decodeFunctionResult('isOwnerAddress', raw)[0] ? 'smart' : 'smartAddOwner'
        } catch {
          next = 'notCoinbase'
        }
      } else {
        let caps: unknown = null
        try {
          caps = await provider.send('wallet_getCapabilities', [address, [`0x${BASE_SEPOLIA.toString(16)}`]])
        } catch {
          caps = null
        }
        next = supportsAtomicBatch(caps, BASE_SEPOLIA) ? 'undeployed' : 'notSmart'
      }
      let bal: bigint | null = null
      try {
        const raw = await provider.call({ to: getAddresses(BASE_SEPOLIA)!.MockUSDC, data: ERC20.encodeFunctionData('balanceOf', [address]) })
        bal = ERC20.decodeFunctionResult('balanceOf', raw)[0] as bigint
      } catch {
        bal = null
      }
      if (alive) {
        setKind(next)
        setBalance(bal)
      }
    })()
    return () => {
      alive = false
    }
  }, [wallet.provider, wallet.address, onBaseSepolia])

  const usable = kind === 'smart' || kind === 'smartAddOwner' || kind === 'undeployed'
  const agentOk = isAddress(agent)

  const setUp = async () => {
    const provider = wallet.provider
    const address = wallet.address
    if (!provider || !address) return
    setBusy(true)
    setResult(null)
    setPermission(null)
    try {
      const latest = await provider.getBlock('latest')
      const now = latest?.timestamp ?? Math.floor(Date.now() / 1000)
      const params = {
        account: address,
        agent,
        sessionManager: getSessionManagerAddress(BASE_SEPOLIA),
        token: getAddresses(BASE_SEPOLIA)!.MockUSDC,
        allowance: parseUnits(allowance || '0', 18),
        period: 86_400,
        start: now - 60,
        end: Number(MAX_UINT48),
        salt: BigInt(ethers.hexlify(ethers.randomBytes(8))),
        perTrade: parseUnits(perTrade || '0', 18),
        budget: parseUnits(budget || '0', 18),
        maxLeverage: Number(maxLeverage),
        expiry: now + Math.round(parseFloat(hours) * 3600),
        assets: [ASSET_IDS.sBTC, ASSET_IDS.sETH],
        addSpmOwner: kind === 'smartAddOwner',
      }
      const calls = buildSetupCalls(params)

      let id: string
      try {
        const res = await provider.send('wallet_sendCalls', sendCallsParams(calls, address, BASE_SEPOLIA))
        id = typeof res === 'string' ? res : (res as { id: string }).id
      } catch (e) {
        if (isUnsupportedMethod(e)) {
          setResult({ severity: 'error', text: t.sessions.baseAccount.unsupported })
          return
        }
        if (!/version/i.test((e as Error).message ?? '')) throw e
        // An older wallet that only speaks EIP-5792 1.0.
        const res = await provider.send('wallet_sendCalls', sendCallsParams(calls, address, BASE_SEPOLIA, '1.0'))
        id = typeof res === 'string' ? res : (res as { id: string }).id
      }

      for (let waited = 0; waited < 90_000; waited += 2_000) {
        const status = parseCallsStatus(await provider.send('wallet_getCallsStatus', [id]))
        if (status.state === 'confirmed') {
          setPermission(JSON.stringify(permissionJsonOf(params), null, 2))
          setResult({ severity: 'success', text: t.sessions.baseAccount.done, txHash: status.txHash })
          onDone()
          return
        }
        if (status.state === 'failed') {
          setResult({ severity: 'error', text: interpolate(t.sessions.baseAccount.failed, { reason: 'reverted' }), txHash: status.txHash })
          return
        }
        await new Promise((r) => setTimeout(r, 2_000))
      }
      setResult({ severity: 'info', text: t.sessions.baseAccount.timeout })
    } catch (e) {
      setResult({ severity: 'error', text: interpolate(t.sessions.baseAccount.failed, { reason: (e as Error).message ?? String(e) }) })
    } finally {
      setBusy(false)
    }
  }

  const statusText = !onBaseSepolia ? t.sessions.baseAccount.wrongChain : t.sessions.baseAccount[kind]
  const txUrl = result?.txHash ? explorerTx(result.txHash, BASE_SEPOLIA) : null

  return (
    <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.sessions.baseAccount.title}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t.sessions.baseAccount.intro}{' '}
        <Link href={RECORDED_RUN} target="_blank" rel="noopener">{t.sessions.baseAccount.recordedRun} ↗</Link>
      </Typography>

      <Alert severity={onBaseSepolia && usable ? 'info' : 'warning'}>{statusText}</Alert>
      {onBaseSepolia && usable && balance !== null && (
        <Typography variant="caption" color="text.secondary">
          {interpolate(t.sessions.baseAccount.balance, { amount: Number(formatUnits(balance, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 }) })}
        </Typography>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
        <TextField
          size="small"
          label={t.sessions.baseAccount.dailyAllowance}
          value={allowance}
          onChange={(e) => setAllowance(e.target.value)}
          type="number"
          sx={{ maxWidth: 220 }}
        />
        <Button variant="contained" disabled={busy || !onBaseSepolia || !usable || !agentOk} onClick={() => void setUp()}>
          {busy ? t.sessions.baseAccount.sending : t.sessions.baseAccount.cta}
        </Button>
      </Stack>
      {!agentOk && <Typography variant="caption" color="text.secondary">{t.sessions.baseAccount.needAgent}</Typography>}

      {result && (
        <Alert severity={result.severity}>
          {result.text}
          {txUrl && (
            <>
              {' '}
              <Link href={txUrl} target="_blank" rel="noopener" color="inherit" sx={{ textDecoration: 'underline' }}>
                {result.txHash!.slice(0, 10)}… ↗
              </Link>
            </>
          )}
        </Alert>
      )}

      {permission && (
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="subtitle2">{t.sessions.baseAccount.permissionLabel}</Typography>
            <Button size="small" onClick={() => void navigator.clipboard?.writeText(permission)}>{t.sessions.baseAccount.copy}</Button>
          </Stack>
          <Typography component="pre" sx={{ fontFamily: MONO, fontSize: 12, m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }}>
            {permission}
          </Typography>
        </Stack>
      )}
    </Card>
  )
}
