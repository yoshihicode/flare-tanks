# FLARE TANKS（ステップ2：視界システム）

Cloudflare Workers ＋ Durable Objects で動くトップビュー2D戦車対戦ゲームの最小構成です。

## このステップでできること
- 1部屋に最大6人が接続し、A・Bチームに自動で振り分け
- WASD／矢印キーで移動、マウスで照準、クリック／スペースで射撃
- 壁との衝突、被弾・撃破、3秒後の復活（サーバー側で判定）
- 20Hzのスナップショット配信と、クライアント側の補間表示
- 発射・着弾・撃破の効果音（距離で音量が変化）
- 扇形視界（砲塔方向・約90°）＋近距離の全周視界。壁の裏はレイキャスティングで暗く表示
- 視界外の敵・敵弾はサーバーから送らない（味方は常に表示）
- 自機の予測処理（入力をすぐ反映し、サーバーの結果で補正）

## 動かし方
前提：Node.js 18以上、Cloudflareアカウント（無料プランで可）

```bash
npm install
npm run dev          # http://localhost:8787 をブラウザのタブ2つで開くと対戦できます
```

部屋を分けるには `?room=名前` を付けます（例：`http://localhost:8787/?room=test`）。

## デプロイ
```bash
npx wrangler login
npm run deploy
```
無料プランでは SQLite バックエンドの Durable Object が必要なため、`wrangler.jsonc` の migrations は `new_sqlite_classes` にしています。

## ファイル構成
| ファイル | 内容 |
| --- | --- |
| `src/index.ts` | Worker（/ws の振り分け）と Room（ゲームループ・判定・配信） |
| `public/index.html` | タイトル画面とキャンバス |
| `public/game.js` | 描画・入力・通信・効果音 |
| `public/shared.js` | サーバーと共有する判定（移動・視界・可視ポリゴン） |
| `wrangler.jsonc` | Cloudflare の設定 |

## 現時点の割り切り（次以降で対応）
- 戦車は1種類、botなし、モードなし → ステップ3〜4
- ロビー・ゲストトークン・Turnstileなし → ステップ5
- スマホ操作なし → ステップ6
