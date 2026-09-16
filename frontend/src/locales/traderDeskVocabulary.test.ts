import { it, expect, describe } from 'vitest';

import en from './en';
import zhTW from './zh-TW';

// ----------------------------------------------------------------------

/**
 * #150 / ADR-007：CopyTracker 的既有跟單機制只在 Expert Mode 出現,用的是它原本
 * 誠實的交易桌詞彙(Trader、Copy、Follow、Position)。「配置」「採用」（Allocation /
 * Adopt）從 ADR-007 起專屬 Simple Mode 全新的無槓桿現貨商品——這是 adoptVocabulary
 * 反方向的鏡像斷言：那邊禁止 Adopt 流程說交易桌的字,這邊禁止交易桌畫面說 Adopt 的字。
 */
const BANNED = ['配置', '採用', 'allocation', 'adopt'];

function strings(value: unknown, at: string): { at: string; text: string }[] {
  if (typeof value === 'string') return [{ at, text: value }];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`));
  }
  return [];
}

function offenders(catalog: typeof zhTW): string[] {
  const shown = [
    ...strings(catalog.marketplace, 'marketplace'),
    ...strings(catalog.copy, 'copy'),
    ...strings(catalog.stake, 'stake'),
    ...strings(catalog.traderDashboard, 'traderDashboard'),
    ...strings(catalog.traderProfile, 'traderProfile'),
  ];
  return shown.flatMap(({ at, text }) =>
    BANNED.filter((word) => text.toLowerCase().includes(word)).map((word) => `${at}: "${word}" in ${text}`)
  );
}

describe('the Expert Mode trading-desk screens vocabulary', () => {
  it('never uses Allocation/Adopt words in zh-TW', () => {
    expect(offenders(zhTW)).toEqual([]);
  });

  it('never uses Allocation/Adopt words in en', () => {
    expect(offenders(en)).toEqual([]);
  });

  it('actually catches a banned word', () => {
    const leaky = { ...zhTW, marketplace: { ...zhTW.marketplace, subtitle: '瀏覽並採用配置' } };
    expect(offenders(leaky)).not.toEqual([]);
  });
});
