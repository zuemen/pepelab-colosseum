---
status: accepted
---

# 「採用一個配置」是全新的無槓桿現貨商品,不是 CopyTracker 的顯示層改名

ADR-002 的其中一條結論是:既有的 `StrategyRegistry` / `CopyTracker` / `TraderStake`(原本的「跟單交易」機制,複製的是真正的槓桿 `PerpetualExchange` 部位)可以直接「重新理解」成配置發布者與信譽擔保,不需重寫合約 —— 換句話說,只換顯示層語言。同一個 commit 也把 Simple Mode 的規則寫進 `frontend/CONTEXT.md`:槓桿與清算這兩個概念完全不能出現在 Simple Mode 的畫面上,「一個畫面如果發現自己需要用到這兩個詞,代表機制已經滲漏到顯示層了」。

這兩個決定合在一起有矛盾,而且在原本的 commit 裡沒有被注意到:如果「採用一個配置」只是把 CopyTracker 換個名字,使用者在 Simple Mode 底下按下「採用」,實際上開的是真正的槓桿部位 —— 但畫面上永遠不會出現「槓桿」或「清算」這兩個詞去說明這件事在發生什麼。這不是命名問題,是說明書式的風險揭露缺口。

決定是把兩者拆開:

1. **「配置」(Allocation)、「配置發布者」(Allocation Publisher)、「採用」(Adopt)這三個詞,從現在起專指一個全新的、真正無槓桿的現貨商品**:採用等於照著發布者目前的現貨代幣配置比例,呼叫 `AssetVaultV2_4.mint` 買進對應的現貨代幣。快照式(採用當下複製一次比例,之後不會自動跟著調整),不套用 `CopyTracker` 的手續費/罰沒經濟機制,初期不另外開鏈上追蹤合約(由前端一次送出多筆 mint 交易完成)。
2. **既有的 `CopyTracker`/`TraderStake`/`StrategyRegistry` 機制維持原樣**,只在 Expert Mode 出現,並且拿回它原本誠實的交易桌詞彙(Trader、Copy、Follow、Position)—— Expert Mode 本來就不受 Simple Mode 那份詞彙表管轄,所以這些詞在這裡繼續使用沒有問題。
3. 這篇 ADR **局部推翻 ADR-002**:ADR-002 對本平台定位(RWA 的衍生品與配置層,不做發行)的主論證維持不變;被推翻的只是它 Consequences 裡「既有 CopyTracker 不需重寫,直接重新理解成配置發布者」這一條具體結論。

## Considered options

**維持 ADR-002 原案,在 Simple Mode 「採用」流程裡加一段風險揭露例外。** 否決:一旦開了「這個畫面可以用槓桿相關的字」的例外,Simple Mode 詞彙表「絕對不出現」的保證就不成立了,以後每個想抄捷徑的畫面都能主張自己也是例外。

**沿用 CopyTracker,但只允許「採用」低槓桿/無槓桿的配置。** 否決:合約目前沒有逐部位的槓桿上限可供前端查驗與過濾,而且就算過濾了,只要發布者事後把配置換成高槓桿部位,採用者的曝險就跟著變了卻不會被告知 —— 沒有真的解決風險揭露的問題,只是把它變得比較少發生。

## Consequences

- Marketplace 的「採用」流程需要新的前端邏輯(多筆 `AssetVaultV2_4.mint` 呼叫),不需要新合約。
- Expert Mode 的 Marketplace/跟單畫面維持現有 `CopyTracker` 功能不變,只需要把顯示詞彙從「配置/採用」換回「Trader/Copy/Follow/Position」。
- `frontend/CONTEXT.md` 的 Allocation / Allocation Publisher / Adopt 詞條需要更新,註明這三個詞現在專指現貨配置採用,不再涵蓋 CopyTracker 的槓桿部位複製。
