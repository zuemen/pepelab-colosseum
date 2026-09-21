import type { AttestedTier } from 'src/hooks/useCarbonTiers'

import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'

import { TIER_COLOR } from './AssetProvenance'

/**
 * #152：見證碳等級（Attested Carbon Tier）的顯示。
 *
 * 和 `AssetProvenanceSummary` 的分級 chip 看起來像,但**講的不是同一件事**,所以
 * 是分開的元件而不是多加一個 prop：
 *  - `AssetProvenanceSummary` 顯示本機靜態 metadata 推導的分級。
 *  - 這裡顯示鏈上 `ESGRegistryV2.medianCarbonTier` 的見證中位數,附帶見證筆數與
 *    離散度。Tier 本身就是被見證的事實,不是讀取時從碳強度推導出來的數字
 *    （frontend/docs/adr/0008）。
 *
 * 兩者共用等級名稱與配色（TIER_COLOR）是刻意的——同一套等級,不同的來源。把它
 * 們畫成兩種顏色反而會讓人以為是兩套分級制度。
 *
 * **字串只有一個家**：chip 層級的字全部放 `t.esg.attested`,即使在 /tokens 的
 * 面板裡也一樣。同一句話在兩個 catalog 各寫一份,遲早會漂成兩種講法。
 * `t.tokens.attested` 只留面板專屬的那幾句（標題、來源、費率因果）。
 */

/** 離散度的講法。0 代表所有見證者講同一件事,那是值得講出來的事實,不是沒事發生。 */
function dispersionLabel(w: AttestedTier, agree: string, apart: string): string {
  return w.dispersion === 0 ? agree : interpolate(apart, { n: String(w.dispersion) })
}

export interface AttestedTierChipsProps {
  attested: AttestedTier | undefined
  /** 讀取尚未結束。和「讀完了但沒有見證」是兩件事。 */
  loading?: boolean
}

/**
 * 一列的摘要：等級 chip ＋ 見證筆數 ＋ 離散度。表格列與詳情面板共用。
 *
 * 三種「沒有數字」的狀態刻意分開講,因為對使用者的意義完全不同：
 *   loading      → 還不知道
 *   undefined    → 這一筆讀失敗,沒有結論
 *   !isRated     → 有結論,答案是「沒有有效見證」(Unrated Asset)
 * 把它們混成同一句「—」會讓「查不到」看起來像「查到了,是零」。
 *
 * 第四種狀態——這條鏈根本沒有見證登記——**不在這裡處理**。呼叫端直接不渲染
 * 整個區塊：CONTEXT.md 的 The Vault 詞條規定畫面不得出現「本網路尚未部署」這
 * 類提示,那個規則對這裡同樣適用。
 */
export function AttestedTierChips({ attested, loading }: AttestedTierChipsProps) {
  const a = t.esg.attested

  if (loading) {
    return <Typography variant="caption" color="text.secondary">{a.loading}</Typography>
  }
  if (!attested) {
    // 讀到這一筆時失敗了。不能顯示成「未評等」——那是一個結論,這裡沒有結論。
    return <Typography variant="caption" color="warning.main">{a.failed}</Typography>
  }

  if (!attested.isRated) {
    return (
      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="nowrap" useFlexGap>
        <Chip size="small" color={TIER_COLOR.unrated} variant="outlined" label={a.unrated} />
        <Typography variant="caption" color="text.secondary">{a.noAttestations}</Typography>
      </Stack>
    )
  }

  return (
    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="nowrap" useFlexGap>
      <Chip
        size="small"
        color={TIER_COLOR[attested.tier]}
        variant="outlined"
        label={t.tokens.provenance.carbonTier[attested.tier]}
      />
      <Typography variant="caption" color="text.secondary">
        {interpolate(a.countUnit, { count: String(attested.count) })}
      </Typography>
      <Typography
        variant="caption"
        // 見證不一致時用暖色標出來——那是要被看見的狀況,不是雜訊。
        color={attested.dispersion === 0 ? 'text.secondary' : 'warning.main'}
      >
        {dispersionLabel(attested, a.agree, a.apart)}
      </Typography>
    </Stack>
  )
}

export interface AttestedTierBlockProps extends AttestedTierChipsProps {
  /**
   * `AssetVaultV2_4.mintFeeBpsForAsset(assetId)` 的鏈上結果（bps）。
   *
   * 一定要是這個值,不能拿 `assetRow.tradingFeeBps` 代替：後者由本機靜態 tier
   * 推導,而且 carbon.ts 註明那組數字對齊的是 PerpetualExchange 的交易費,不是
   * 金庫的鑄造費。兩者不一致時,用錯的那個會讓這段文案斷言一件假的事。
   *
   * null = 沒讀到（舊版金庫沒有這個函式,或該筆讀取失敗）。此時整句話不顯示,
   * 而不是退回一個猜出來的數字。
   */
  mintFeeBps: number | null
}

/**
 * 詳情面板用的版本：摘要之外再講一句「這個等級決定手續費」。
 *
 * issue #152 要的不只是顯示等級,而是讓人看得出等級與費率之間的因果——所以那句
 * 話只在真的讀到鏈上鑄造費時才出現。`mintFeeBpsForAsset` 自己就是讀
 * `medianCarbonTier` 算出來的,因果因此是真的,不是文案宣稱的。
 */
export function AttestedTierBlock({ attested, loading, mintFeeBps }: AttestedTierBlockProps) {
  const at = t.tokens.attested

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">
        {at.title}
      </Typography>
      <Box sx={{ mt: 0.75 }}>
        <AttestedTierChips attested={attested} loading={loading} />
      </Box>
      {attested && !loading && mintFeeBps !== null && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
          {interpolate(at.feeNote, { fee: `${(mintFeeBps / 100).toFixed(2)}%` })}
          {!attested.isRated && ` ${at.unratedNote}`}
        </Typography>
      )}
      <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 0.5 }}>
        {at.sourceNote}
      </Typography>
    </Box>
  )
}
