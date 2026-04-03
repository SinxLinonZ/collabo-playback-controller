# YouTube Multi-View Archive Sync Controller (v0.2)

複数の YouTube アーカイブタブを同期操作するための Chrome Extension です。  
特に VTuber コラボ配信の多視点アーカイブ視聴を想定しています。

## このプロジェクトが必要な理由

ヘビーユーザーは通常、すでに複数の YouTube watch タブを開いており、次の環境を維持したいケースが多いです。

- ログイン状態
- 画質設定や再生挙動
- 既存のブラウザ拡張（広告ブロック、ショートカットなど）

iframe グリッド方式は見た目の同時表示に強い一方で、画質やエコシステム互換で不利になることがあります。  
本プロジェクトは Extension-first の `TabSync Mode` で、既存の watch タブを直接制御します。

## 主な利用シーン

- コラボアーカイブの複数 POV を同時に見直し、時刻を揃える
- メンバーごとの反応タイミングを比較する
- 手動でタブを揃えた後、現在状態から offset を逆算して取り込む
- メインルートを切り替えつつ、各ルートの等価な時間関係を維持する

## 解決する課題

- タブごとの個別操作（`play/pause/seek`）を繰り返す手間を削減
- 複数 YouTube watch タブを単一コントローラで操作
- offset 調整を実用化（直接入力、ステップ調整、逆読み取り）
- action popup 依存をやめ、コンパクトな専用コントローラウィンドウで安定操作
- Content Script 接続切れ時の再注入・再試行で操作信頼性を向上

## 現在の機能

- 現在ウィンドウ / 全ウィンドウの YouTube watch タブをスキャンして導入
- セッション内ルート管理（追加 / 削除）
- 全体操作: `Play All`, `Pause All`, `Seek All`, `Sync Now`
- Main Route 切り替え時の等価 offset 変換
- ルートごとの offset 編集:
- 符号付き入力（`seconds`, `mm:ss`, `hh:mm:ss`）
- ステップボタン（`-1s`, `-0.1s`, `+0.1s`, `+1s`, `0` リセット）
- `Read Offsets`（現在タブ時刻から offset を逆算して反映）

## 技術アーキテクチャ

実行レイヤーは次の 3 層です。

1. `Controller Page` (React + TypeScript)
- UI 状態管理、セッション表示、ルート操作
- 全体コマンドと offset ワークフロー

2. `Background Service Worker` (TypeScript)
- タブ探索とライフサイクル管理
- route/session の正本管理
- メッセージルーティングと耐障害処理（ping/inject/retry）

3. `Content Script` (TypeScript, YouTube watch ページへ注入)
- ネイティブ `<video>` を直接制御（`play`, `pause`, `seek`, `volume`, `mute`, `playbackRate`）
- スナップショット / イベント報告（`currentTime`, `duration`, `status`）

メッセージ経路:

- `Controller -> Background -> Content`（制御コマンド）
- `Content -> Background -> Controller`（状態更新）

時間モデル:

- 各ルート目標時刻: `targetTime = masterTime + offset`
- `Sync Now`: 手動の一回同期
- `Auto Sync Correction`: 継続的な自動ドリフト補正（未実装）

## 技術スタック

- TypeScript (strict)
- React（Controller UI）
- Vite + `@crxjs/vite-plugin`
- Chrome Extension Manifest V3

## セットアップ

```bash
npm install
npm run build
```

Chrome への読み込み:

1. `chrome://extensions` を開く
2. `Developer mode` を ON
3. `Load unpacked` をクリック
4. `dist/` を選択

開発時:

```bash
npm run dev
```

## 現在の範囲と今後

`TabSync Mode` の中核フローは実装済みですが、以下は未完了です。

- ルート単位の `mute/volume` UI と語義の完成
- `solo` の音声状態保存・復元ルール
- `Auto Sync Correction` エンジン（soft/hard correction）
- drift / sync status の可視化

