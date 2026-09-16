/**
 * 交易者質押頁：兩個清楚分開的區塊——
 * 1. 聲譽質押（TraderStake.sol，質押 USDC 換發布資格，可能被罰沒）
 * 2. PEPE 質押（PepeStaking.sol，質押 PEPE 賺 PEPE，純收益、無罰沒）
 */
export const stake = {
  viewOn: '在 {explorer} 查看 ↗',

  sections: {
    reputation: {
      title: '① 聲譽質押',
      subtitle: '質押 {token}，換取發布策略、參與跟單市場的資格——策略造成跟隨者虧損時可能被罰沒。',
    },
    pepe: {
      title: '② PEPE 質押',
      subtitle: '質押 PEPE 賺 PEPE。純收益機制，不會被罰沒，但獎勵完全取決於合約目前是否有在跑的獎勵期。',
    },
  },

  current: {
    title: '你的質押',
    refresh: '↺ 重新整理',
    staked: '已質押',
    totalSlashed: '累計罰沒',
    reputation: '聲譽分數',
    reputationValue: '{score} / 100',
    formula: '公式：質押量 × 100 ÷（質押量 + 累計罰沒 × 5）',
    eligible: '✓ 符合發布策略資格',
    notEligible: '✗ 需質押 100 {token}',
    minimum: '最低質押金額：{amount} {token} · 向跟隨者展現你的風險共擔',
  },

  /** PepeStaking.sol——真的鏈上質押、真的鏈上獎勵池，Synthetix 式 7 天週期。 */
  pepe: {
    title: 'PEPE 質押',
    riskChip: '純收益 · 無罰沒',
    staked: '已質押 PEPE',
    pending: '待領取獎勵',
    walletBalance: '錢包 PEPE 餘額',
    refresh: '↺ 重新整理',

    notDeployed: 'PepeStaking 尚未在本網路部署。',

    periodActive: '獎勵期進行中，全體質押者目前合計每天可領 {amount} PEPE，至 {when} 結束。',
    periodEnded: '上一輪獎勵期已於 {when} 結束，目前沒有新獎勵在累積——需等待合約 owner 呼叫 notifyRewardAmount() 開始下一輪。',
    periodNotStarted: '合約 owner 尚未挹注任何獎勵——目前質押不會累積收益。',
    fundingUnknown: '無法讀取獎勵資金狀態——可能是本網路的合約版本較舊，也可能只是這次讀取暫時失敗，按重新整理再試一次。',

    stakeTitle: '質押 PEPE',
    stakeDescription: '質押後立即開始依目前獎勵速率計息（若獎勵期正在跑），沒有鎖倉期，隨時可解除。',
    stakePlaceholder: '1000',
    staking: '質押中…',
    stakeCta: '批准並質押',
    stakeEnterAmount: '請輸入有效金額',
    stakeDone: '質押成功 ✓',

    withdrawTitle: '解除質押',
    withdrawDescription: '沒有冷卻期——解除質押的 PEPE 立即回到你的錢包。',
    withdrawPlaceholder: '500',
    withdrawing: '解除質押中…',
    withdrawCta: '解除質押',
    withdrawEnterAmount: '請輸入解除質押金額',
    withdrawDone: '解除質押成功 ✓',
    withdrawNothingStaked: '目前沒有已質押的 PEPE 可以解除',

    claiming: '領取中…',
    claimCta: '領取獎勵',
    claimDone: '獎勵已領取 ✓',
    claimNothing: '目前沒有可領取的獎勵',

    addToWallet: '🦊 加 Metamask',
    addedToWallet: '已將 PEPE 代幣合約成功加入您的 Metamask！ 🦊🐸',
    addToWalletFailed: '新增代幣失敗，請手動複製合約地址。',
  },

  add: {
    title: '質押 {token}',
    description:
      '質押會讓你的資金承擔風險——若你的策略造成跟單者虧損超過 30%，可能觸發罰沒。作為回報，你將獲得信譽（聲譽分數）並可發布策略。',
    placeholder: '100',
    staking: '質押中…',
    cta: '批准並質押',
    enterAmount: '請輸入有效金額',
    done: '質押成功 ✓',
  },

  unstake: {
    title: '解除質押（24 小時冷卻）',
    pending: '待處理解除質押：{amount} {token}',
    ready: '冷卻期已過——可以執行。',
    availableAt: '可執行時間：{when}',
    executing: '執行中…',
    execute: '執行解除質押',
    cancelling: '取消中…',
    cancel: '取消',
    description: '申請解除質押——資金將在 24 小時冷卻期後解鎖。',
    placeholder: '50',
    requesting: '申請中…',
    request: '申請解除質押',
    enterAmount: '請輸入解除質押金額',
    requested: '已申請解除質押 ✓——請等待 24 小時後執行',
    executed: '解除質押已執行 ✓',
    cancelled: '解除質押已取消 ✓',
  },

  info: {
    title: '交易者質押機制說明',
    publish: '質押 ≥ 100 {token} 即可在交易市集發布策略。',
    slashing:
      '若跟隨者因你的策略虧損超過 30%，該虧損金額的 50%（上限為你質押額的 50%）將被罰沒並發放給他們。',
    reputation: '聲譽 = 質押量 × 100 ÷（質押量 + 累計罰沒 × 5）——遭罰沒時會下降。',
    cooldown: '解除質押需要 24 小時冷卻期。',
    backToMarketplace: '← 返回交易市集',
    traderDashboard: '交易者主頁 →',
  },
};
