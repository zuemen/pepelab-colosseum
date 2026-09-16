import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/stake.ts`。
 */
export const stake: Catalog['stake'] = {
  viewOn: 'View on {explorer} ↗',

  sections: {
    reputation: {
      title: '① Reputation Staking',
      subtitle:
        'Stake {token} for eligibility to publish strategies and join the copy-trading market — can be slashed if your strategy causes follower losses.',
    },
    pepe: {
      title: '② PEPE Staking',
      subtitle:
        'Stake PEPE, earn PEPE. Pure yield, never slashed — but rewards depend entirely on whether the contract currently has an active reward period.',
    },
  },

  current: {
    title: 'Your Stake',
    refresh: '↺ Refresh',
    staked: 'Staked',
    totalSlashed: 'Total Slashed',
    reputation: 'Reputation Score',
    reputationValue: '{score} / 100',
    formula: 'Formula: stake × 100 ÷ (stake + totalSlashed × 5)',
    eligible: '✓ Eligible to publish strategies',
    notEligible: '✗ Need 100 {token} stake',
    minimum: 'Minimum stake: {amount} {token} · Skin-in-the-game for your followers',
  },

  /** PepeStaking.sol — real on-chain stake, real on-chain reward pool, Synthetix-style 7-day periods. */
  pepe: {
    title: 'PEPE Staking',
    riskChip: 'Pure yield · never slashed',
    staked: 'PEPE Staked',
    pending: 'Pending Rewards',
    walletBalance: 'Wallet PEPE Balance',
    refresh: '↺ Refresh',

    notDeployed: 'PepeStaking is not deployed on this network.',

    periodActive:
      'Reward period active — all stakers currently earn {amount} PEPE/day combined, ending {when}.',
    periodEnded:
      'The last reward period ended {when} — no new rewards are accruing. Waiting for the contract owner to call notifyRewardAmount() to start the next one.',
    periodNotStarted:
      "The contract owner hasn't funded any reward period yet — staking won't accrue yield right now.",
    fundingUnknown:
      "Can't read reward-funding status — either this network's contract is an older version, or this read just failed transiently. Hit Refresh to try again.",

    stakeTitle: 'Stake PEPE',
    stakeDescription:
      'Starts earning immediately at the current reward rate (if a period is active). No lockup — withdraw any time.',
    stakePlaceholder: '1000',
    staking: 'Staking…',
    stakeCta: 'Approve + Stake',
    stakeEnterAmount: 'Enter a valid amount',
    stakeDone: 'Staked successfully ✓',

    withdrawTitle: 'Withdraw',
    withdrawDescription: 'No cooldown — withdrawn PEPE returns to your wallet immediately.',
    withdrawPlaceholder: '500',
    withdrawing: 'Withdrawing…',
    withdrawCta: 'Withdraw',
    withdrawEnterAmount: 'Enter amount to withdraw',
    withdrawDone: 'Withdrawn successfully ✓',
    withdrawNothingStaked: "You don't have any PEPE staked to withdraw",

    claiming: 'Claiming…',
    claimCta: 'Claim Rewards',
    claimDone: 'Rewards claimed ✓',
    claimNothing: 'Nothing to claim right now',

    addToWallet: '🦊 Add to MetaMask',
    addedToWallet: 'PEPE token contract added to your MetaMask! 🦊🐸',
    addToWalletFailed: 'Failed to add the token — copy the contract address manually.',
  },

  add: {
    title: 'Stake {token}',
    description:
      'Staking puts your capital at risk — followers can trigger slashing if your strategy causes > 30% loss. In return, you earn credibility (reputation score) and can publish strategies.',
    placeholder: '100',
    staking: 'Staking…',
    cta: 'Approve + Stake',
    enterAmount: 'Enter a valid amount',
    done: 'Staked successfully ✓',
  },

  unstake: {
    title: 'Unstake (24 h cooldown)',
    pending: 'Pending unstake: {amount} {token}',
    ready: 'Cooldown elapsed — ready to execute.',
    availableAt: 'Available at: {when}',
    executing: 'Executing…',
    execute: 'Execute Unstake',
    cancelling: 'Cancelling…',
    cancel: 'Cancel',
    description: 'Request unstake — funds unlock after 24 h cooldown.',
    placeholder: '50',
    requesting: 'Requesting…',
    request: 'Request Unstake',
    enterAmount: 'Enter amount to unstake',
    requested: 'Unstake requested ✓ — wait 24 h then execute',
    executed: 'Unstake executed ✓',
    cancelled: 'Unstake cancelled ✓',
  },

  info: {
    title: 'How Trader Stake works',
    publish: 'Stake ≥ 100 {token} to publish strategies on the Marketplace.',
    slashing:
      'If a follower suffers > 30% loss, 50% of that loss amount (capped at 50% of your stake) is slashed and sent to them.',
    reputation:
      'Reputation = stake × 100 ÷ (stake + totalSlashed × 5) — degrades as you get slashed.',
    cooldown: 'Unstaking requires a 24-hour cooldown.',
    backToMarketplace: '← Back to Marketplace',
    traderDashboard: 'Trader Dashboard →',
  },
};
