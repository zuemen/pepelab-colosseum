import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link as RouterLink } from 'react-router'
import { parseEther } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { t, interpolate } from 'src/locales'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { STABLE_LABEL, PEPE_LABEL } from 'src/lib/pepefi/tokenLabel'
import { getAddresses } from 'src/contracts/addresses'
import { isDeployed, safeRead } from 'src/lib/pepefi/safeRead'
import { rewardPeriodStatus, dailyRewardPool } from 'src/lib/pepefi/pepeStakingView'

import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import Card from '@mui/material/Card'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Alert from '@mui/material/Alert'
import Link from '@mui/material/Link'
import Chip from '@mui/material/Chip'
import { useToast } from 'src/components/pepefi/ToastProvider'

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (v: unknown) => v as TxResp

interface StakeInfo {
  amount:             bigint
  totalSlashed:       bigint
  unstakeRequestedAt: bigint
  unstakeAmount:      bigint
}

interface PepeStakeInfo {
  staked:       bigint
  earned:       bigint
  totalStaked:  bigint
  rewardRate:   bigint
  periodFinish: bigint
  /** null when the deployed contract can't answer rewardBudget() (pre-PA-9 legacy version). */
  rewardBudget: bigint | null
}

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)

export default function TraderStakePage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [info,       setInfo]       = useState<StakeInfo | null>(null)
  const [repScore,   setRepScore]   = useState<bigint | null>(null)
  const [eligible,   setEligible]   = useState<boolean | null>(null)
  const [minStake,   setMinStake]   = useState<bigint>(100n * 10n ** 18n)
  const [cooldown,   setCooldown]   = useState<bigint>(86400n)
  const [stakeInput, setStakeInput] = useState('100')
  const [unstakeAmt, setUnstakeAmt] = useState('')
  const [busy,  setBusy]  = useState<Record<string, boolean>>({})
  const { notify } = useToast()

  // ── PEPE Staking (PepeStaking.sol) ─────────────────────────────────────────
  // isDeployed(undefined) is true (it only special-cases the zero-address string),
  // so on a chain not in CHAIN_MAP `getAddresses` returns null and the `?.` alone
  // would read as "deployed" — check the address exists before asking isDeployed.
  const pepeAddr = getAddresses(wallet.chainId)?.PepeStaking
  const pepeDeployed = !!pepeAddr && isDeployed(pepeAddr)
  const [onChainPepeBalance, setOnChainPepeBalance] = useState<bigint | null>(null)
  const [pepeStake,      setPepeStake]      = useState<PepeStakeInfo | null>(null)
  const [pepeStakeInput, setPepeStakeInput] = useState('1000')
  const [pepeWithdrawAmt, setPepeWithdrawAmt] = useState('')

  const addPepeToWallet = async () => {
    if (!window.ethereum || !contracts) return
    try {
      await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: String(contracts.pepeToken.target),
            symbol: 'PEPE',
            decimals: 18,
          },
        },
      })
      notify(t.stake.pepe.addedToWallet, true)
    } catch (e) {
      console.error('Add PEPE failed', e)
      notify(t.stake.pepe.addToWalletFailed, false)
    }
  }

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))

  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      // Both groups are independent contract reads keyed off the same wallet.address —
      // kick them off together instead of awaiting reputation before starting PEPE.
      const reputationRead = Promise.all([
        contracts.traderStake.getStake(wallet.address),
        contracts.traderStake.reputationScore(wallet.address),
        contracts.traderStake.isEligible(wallet.address),
        contracts.traderStake.MIN_STAKE(),
        contracts.traderStake.UNSTAKE_COOLDOWN(),
        contracts.pepeToken.balanceOf(wallet.address),
      ])
      const pepeRead = pepeDeployed
        ? Promise.all([
            safeRead<bigint>(contracts.pepeStaking.balanceOf(wallet.address),  0n),
            safeRead<bigint>(contracts.pepeStaking.earned(wallet.address),     0n),
            safeRead<bigint>(contracts.pepeStaking.totalStaked(),              0n),
            safeRead<bigint>(contracts.pepeStaking.rewardRate(),               0n),
            safeRead<bigint>(contracts.pepeStaking.periodFinish(),             0n),
            safeRead<bigint | null>(contracts.pepeStaking.rewardBudget(),      null),
          ])
        : null

      const [[rawInfo, score, elig, min, cd, pepeBal], pepeResult] =
        await Promise.all([reputationRead, pepeRead])

      const s = rawInfo as unknown as StakeInfo
      setInfo(s)
      setRepScore(score as bigint)
      setEligible(elig as boolean)
      setMinStake(min as bigint)
      setCooldown(cd as bigint)
      setOnChainPepeBalance(pepeBal as bigint)

      if (pepeResult) {
        const [staked, earned, totalStaked, rewardRate, periodFinish, rewardBudget] = pepeResult
        setPepeStake({ staked, earned, totalStaked, rewardRate, periodFinish, rewardBudget })
      }
    } catch (e) {
      console.error('[stake fetch]', e)
    }
  }, [contracts, wallet.address, pepeDeployed])

  useEffect(() => { void fetchAll() }, [fetchAll])

  const doApproveAndStakePepe = async () => {
    if (!contracts || !wallet.address) return
    const amt = parseEther(pepeStakeInput || '0')
    if (amt === 0n) { notify(t.stake.pepe.stakeEnterAmount, false); return }
    setLoad('pepeStake', true)
    try {
      const approveTx = asTx(await contracts.pepeToken.approve(String(contracts.pepeStaking.target), amt))
      await approveTx.wait()
      const stakeTx = asTx(await contracts.pepeStaking.stake(amt))
      await stakeTx.wait()
      notify(t.stake.pepe.stakeDone, true, stakeTx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('pepeStake', false) }
  }

  const doWithdrawPepe = async () => {
    if (!contracts) return
    const amt = parseEther(pepeWithdrawAmt || '0')
    if (amt === 0n) { notify(t.stake.pepe.withdrawEnterAmount, false); return }
    setLoad('pepeWithdraw', true)
    try {
      const tx = asTx(await contracts.pepeStaking.withdraw(amt))
      await tx.wait()
      notify(t.stake.pepe.withdrawDone, true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('pepeWithdraw', false) }
  }

  const doClaimPepe = async () => {
    if (!contracts) return
    setLoad('pepeClaim', true)
    try {
      const tx = asTx(await contracts.pepeStaking.claimYield())
      await tx.wait()
      notify(t.stake.pepe.claimDone, true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('pepeClaim', false) }
  }

  const doApproveAndStake = async () => {
    if (!contracts || !wallet.address) return
    const amt = parseEther(stakeInput || '0')
    if (amt === 0n) { notify(t.stake.add.enterAmount, false); return }
    setLoad('stake', true)
    try {
      const approveTx = asTx(await contracts.usdc.approve(String(contracts.traderStake.target), amt))
      await approveTx.wait()
      const stakeTx = asTx(await contracts.traderStake.stake(amt))
      await stakeTx.wait()
      notify(t.stake.add.done, true, stakeTx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('stake', false) }
  }

  const doRequestUnstake = async () => {
    if (!contracts) return
    const amt = parseEther(unstakeAmt || '0')
    if (amt === 0n) { notify(t.stake.unstake.enterAmount, false); return }
    setLoad('reqUnstake', true)
    try {
      const tx = asTx(await contracts.traderStake.requestUnstake(amt))
      await tx.wait()
      notify(t.stake.unstake.requested, true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('reqUnstake', false) }
  }

  const doExecuteUnstake = async () => {
    if (!contracts) return
    setLoad('execUnstake', true)
    try {
      const tx = asTx(await contracts.traderStake.executeUnstake())
      await tx.wait()
      notify(t.stake.unstake.executed, true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('execUnstake', false) }
  }

  const doCancelUnstake = async () => {
    if (!contracts) return
    setLoad('cancelUnstake', true)
    try {
      const tx = asTx(await contracts.traderStake.cancelUnstake())
      await tx.wait()
      notify(t.stake.unstake.cancelled, true, tx.hash)
      await fetchAll()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('cancelUnstake', false) }
  }

  const cooldownEnds = info && info.unstakeRequestedAt > 0n
    ? new Date(Number(info.unstakeRequestedAt + cooldown) * 1000).toLocaleString()
    : null

  const canExecute = info && info.unstakeAmount > 0n &&
    BigInt(Math.floor(Date.now() / 1000)) >= (info.unstakeRequestedAt + cooldown)

  const repPct = repScore !== null ? Math.min(Number(repScore), 100) : 0
  const repBarColor = repScore === null ? 'text.disabled'
    : repScore >= 80n ? 'success.main'
    : repScore >= 50n ? 'warning.main'
    : 'error.main'

  const pepePeriodStatus = useMemo(
    () => pepeStake ? rewardPeriodStatus(pepeStake, Date.now() / 1000) : null,
    [pepeStake],
  )
  const pepeDailyPool = useMemo(
    () => pepeStake ? dailyRewardPool(pepeStake, Date.now() / 1000) : null,
    [pepeStake],
  )
  const pepePeriodEndsAt = pepeStake && pepeStake.periodFinish > 0n
    ? new Date(Number(pepeStake.periodFinish) * 1000).toLocaleString()
    : ''

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to manage your stake.</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="sm" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* ─── Section 1: Reputation Staking (TraderStake.sol) ────────────── */}
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
          {t.stake.sections.reputation.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {interpolate(t.stake.sections.reputation.subtitle, { token: STABLE_LABEL })}
        </Typography>
      </Box>

      {/* ─── A. Current Stake ────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            {t.stake.current.title}
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => void fetchAll()}
            sx={{ textTransform: 'none' }}
          >
            {t.stake.current.refresh}
          </Button>
        </Box>

        <Grid container spacing={2}>
          <Grid size={{ xs: 6 }}>
            <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                {t.stake.current.staked}
              </Typography>
              <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                {info ? f18(info.amount) : '…'}
                <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>{STABLE_LABEL}</Box>
              </Typography>
            </Card>
          </Grid>
          <Grid size={{ xs: 6 }}>
            <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                {t.stake.current.totalSlashed}
              </Typography>
              <Typography variant="h5" sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'error.main' }}>
                {info ? f18(info.totalSlashed) : '…'}
                <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>{STABLE_LABEL}</Box>
              </Typography>
            </Card>
          </Grid>
        </Grid>

        {/* Reputation score with progress bar */}
        <Stack spacing={1}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold' }}>
              {t.stake.current.reputation}
            </Typography>
            <Typography variant="subtitle1" sx={{ fontFamily: MONO, fontWeight: 'bold', color: repBarColor }}>
              {repScore !== null
                ? interpolate(t.stake.current.reputationValue, { score: String(repScore) })
                : '…'}
            </Typography>
          </Box>
          <Box sx={{ h: 8, bgcolor: 'background.neutral', borderRadius: 1, overflow: 'hidden' }}>
            <Box
              sx={{
                bgcolor: repBarColor,
                height: '100%',
                width: `${repPct}%`,
                transition: 'width 0.5s'
              }}
            />
          </Box>
          <Typography variant="caption" color="text.secondary">
            {t.stake.current.formula}
          </Typography>
        </Stack>

        {/* Eligibility badge */}
        {eligible !== null && (
          <Chip
            label={
              eligible
                ? t.stake.current.eligible
                : interpolate(t.stake.current.notEligible, { token: STABLE_LABEL })
            }
            color={eligible ? 'success' : 'error'}
            variant="outlined"
            size="small"
            sx={{ alignSelf: 'flex-start', fontWeight: 'bold' }}
          />
        )}

        <Typography variant="caption" color="text.secondary">
          {interpolate(t.stake.current.minimum, {
            amount: f18(minStake),
            token: STABLE_LABEL,
          })}
        </Typography>
      </Card>

      {/* ─── B. Stake More ───────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {interpolate(t.stake.add.title, { token: STABLE_LABEL })}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t.stake.add.description}
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            type="number"
            size="small"
            placeholder={t.stake.add.placeholder}
            value={stakeInput}
            onChange={e => setStakeInput(e.target.value)}
            slotProps={{ htmlInput: { min: "100", step: "100", style: { fontFamily: MONO } } }}
            sx={{ width: 140 }}
          />
          <Typography variant="body2" color="text.secondary">{STABLE_LABEL}</Typography>
          <Button
            variant="contained"
            onClick={() => void doApproveAndStake()}
            disabled={busy['stake'] || !stakeInput}
            sx={{ flexGrow: 1 }}
          >
            {busy['stake'] ? t.stake.add.staking : t.stake.add.cta}
          </Button>
        </Box>
      </Card>

      {/* ─── C. Unstake Request ──────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {t.stake.unstake.title}
        </Typography>

        {info && info.unstakeAmount > 0n ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Alert severity="warning">
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                {interpolate(t.stake.unstake.pending, {
                  amount: f18(info.unstakeAmount),
                  token: STABLE_LABEL,
                })}
              </Typography>
              {canExecute
                ? t.stake.unstake.ready
                : interpolate(t.stake.unstake.availableAt, { when: cooldownEnds ?? '' })}
            </Alert>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Button
                variant="contained"
                color="warning"
                onClick={() => void doExecuteUnstake()}
                disabled={!canExecute || busy['execUnstake']}
                sx={{ flexGrow: 1 }}
              >
                {busy['execUnstake'] ? t.stake.unstake.executing : t.stake.unstake.execute}
              </Button>
              <Button
                variant="outlined"
                onClick={() => void doCancelUnstake()}
                disabled={busy['cancelUnstake']}
                sx={{ flexGrow: 1 }}
              >
                {busy['cancelUnstake'] ? t.stake.unstake.cancelling : t.stake.unstake.cancel}
              </Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">{t.stake.unstake.description}</Typography>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                type="number"
                size="small"
                placeholder={t.stake.unstake.placeholder}
                value={unstakeAmt}
                onChange={e => setUnstakeAmt(e.target.value)}
                slotProps={{ htmlInput: { min: "0", step: "50", style: { fontFamily: MONO } } }}
                sx={{ width: 140 }}
              />
              <Typography variant="body2" color="text.secondary">{STABLE_LABEL}</Typography>
              <Button
                variant="outlined"
                onClick={() => void doRequestUnstake()}
                disabled={busy['reqUnstake'] || !unstakeAmt}
                sx={{ flexGrow: 1 }}
              >
                {busy['reqUnstake'] ? t.stake.unstake.requesting : t.stake.unstake.request}
              </Button>
            </Box>
          </Box>
        )}
      </Card>

      {/* ─── Info ────────────────────────────────────────────────────── */}
      <Card sx={{ p: 3, bgcolor: 'rgba(0, 184, 217, 0.08)', border: '1px solid', borderColor: 'rgba(0, 184, 217, 0.16)' }}>
        <Typography variant="subtitle2" color="info.lighter" sx={{ fontWeight: 'bold', mb: 1 }}>
          {t.stake.info.title}
        </Typography>
        <Stack spacing={1} sx={{ typography: 'caption', color: 'text.secondary', mb: 2 }}>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>{interpolate(t.stake.info.publish, { token: STABLE_LABEL })}</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>{t.stake.info.slashing}</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>{t.stake.info.reputation}</Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Box component="span" sx={{ color: 'info.main', fontWeight: 'bold' }}>•</Box>
            <Box>{t.stake.info.cooldown}</Box>
          </Box>
        </Stack>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Link component={RouterLink} to="/marketplace" color="info.main" sx={{ fontSize: '0.75rem', fontWeight: 'bold', textDecoration: 'underline' }}>
            {t.stake.info.backToMarketplace}
          </Link>
          <Link component={RouterLink} to="/trader" color="info.main" sx={{ fontSize: '0.75rem', fontWeight: 'bold', textDecoration: 'underline' }}>
            {t.stake.info.traderDashboard}
          </Link>
        </Box>
      </Card>

      {/* ─── Section 2: PEPE Staking (PepeStaking.sol) ──────────────────── */}
      <Box sx={{ mt: 2 }}>
        <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
          {t.stake.sections.pepe.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t.stake.sections.pepe.subtitle}
        </Typography>
      </Box>

      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
              🐸 {t.stake.pepe.title}
            </Typography>
            <Chip label={t.stake.pepe.riskChip} color="success" size="small" variant="outlined" sx={{ fontWeight: 'bold' }} />
          </Stack>
          <Button variant="text" size="small" onClick={() => void fetchAll()} sx={{ textTransform: 'none' }}>
            {t.stake.pepe.refresh}
          </Button>
        </Box>

        {!pepeDeployed ? (
          <Alert severity="info">{t.stake.pepe.notDeployed}</Alert>
        ) : (
          <>
            <Grid container spacing={2}>
              <Grid size={{ xs: 4 }}>
                <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
                  <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                    {t.stake.pepe.staked}
                  </Typography>
                  <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                    {pepeStake ? f18(pepeStake.staked, 0) : '…'}
                  </Typography>
                </Card>
              </Grid>
              <Grid size={{ xs: 4 }}>
                <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
                  <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                    {t.stake.pepe.pending}
                  </Typography>
                  <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold', color: pepeStake && pepeStake.earned > 0n ? 'success.main' : 'text.primary' }}>
                    {pepeStake ? f18(pepeStake.earned, 4) : '…'}
                  </Typography>
                </Card>
              </Grid>
              <Grid size={{ xs: 4 }}>
                <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
                  <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>
                    {t.stake.pepe.walletBalance}
                  </Typography>
                  <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                    {onChainPepeBalance !== null ? f18(onChainPepeBalance, 0) : '…'}
                  </Typography>
                </Card>
              </Grid>
            </Grid>

            {pepeStake && (
              <Alert severity={pepePeriodStatus === 'active' ? 'success' : 'warning'}>
                {pepePeriodStatus === 'active' &&
                  interpolate(t.stake.pepe.periodActive, {
                    amount: pepeDailyPool !== null ? f18(pepeDailyPool, 2) : '0',
                    when: pepePeriodEndsAt,
                  })}
                {pepePeriodStatus === 'ended' &&
                  interpolate(t.stake.pepe.periodEnded, { when: pepePeriodEndsAt })}
                {pepePeriodStatus === 'not-started' && t.stake.pepe.periodNotStarted}
              </Alert>
            )}
            {pepeStake && pepeStake.rewardBudget === null && (
              <Typography variant="caption" color="text.secondary">
                {t.stake.pepe.fundingUnknown}
              </Typography>
            )}

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                {t.stake.pepe.stakeTitle}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t.stake.pepe.stakeDescription}
              </Typography>
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                <TextField
                  type="number"
                  size="small"
                  placeholder={t.stake.pepe.stakePlaceholder}
                  value={pepeStakeInput}
                  onChange={e => setPepeStakeInput(e.target.value)}
                  slotProps={{ htmlInput: { min: "0", step: "100", style: { fontFamily: MONO } } }}
                  sx={{ width: 140 }}
                />
                <Typography variant="body2" color="text.secondary">{PEPE_LABEL}</Typography>
                <Button
                  variant="contained"
                  color="success"
                  onClick={() => void doApproveAndStakePepe()}
                  disabled={busy['pepeStake'] || !pepeStakeInput}
                  sx={{ flexGrow: 1 }}
                >
                  {busy['pepeStake'] ? t.stake.pepe.staking : t.stake.pepe.stakeCta}
                </Button>
              </Box>
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                {t.stake.pepe.withdrawTitle}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t.stake.pepe.withdrawDescription}
              </Typography>
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                <TextField
                  type="number"
                  size="small"
                  placeholder={t.stake.pepe.withdrawPlaceholder}
                  value={pepeWithdrawAmt}
                  onChange={e => setPepeWithdrawAmt(e.target.value)}
                  slotProps={{ htmlInput: { min: "0", step: "100", style: { fontFamily: MONO } } }}
                  sx={{ width: 140 }}
                />
                <Typography variant="body2" color="text.secondary">{PEPE_LABEL}</Typography>
                <Button
                  variant="outlined"
                  onClick={() => void doWithdrawPepe()}
                  disabled={busy['pepeWithdraw'] || !pepeWithdrawAmt || !pepeStake || pepeStake.staked === 0n}
                  title={pepeStake && pepeStake.staked === 0n ? t.stake.pepe.withdrawNothingStaked : undefined}
                  sx={{ flexGrow: 1 }}
                >
                  {busy['pepeWithdraw'] ? t.stake.pepe.withdrawing : t.stake.pepe.withdrawCta}
                </Button>
              </Box>
              {pepeStake && pepeStake.staked === 0n && (
                <Typography variant="caption" color="text.secondary">
                  {t.stake.pepe.withdrawNothingStaked}
                </Typography>
              )}
            </Box>

            <Stack direction="row" spacing={2}>
              <Button
                variant="contained"
                onClick={() => void doClaimPepe()}
                disabled={busy['pepeClaim'] || !pepeStake || pepeStake.earned === 0n}
                sx={{ flexGrow: 1 }}
              >
                {busy['pepeClaim'] ? t.stake.pepe.claiming : t.stake.pepe.claimCta}
              </Button>
              <Button variant="outlined" onClick={() => void addPepeToWallet()} sx={{ flexGrow: 1 }}>
                {t.stake.pepe.addToWallet}
              </Button>
            </Stack>
            {pepeStake && pepeStake.earned === 0n && (
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>
                {t.stake.pepe.claimNothing}
              </Typography>
            )}
          </>
        )}
      </Card>

    </Container>
  )
}
