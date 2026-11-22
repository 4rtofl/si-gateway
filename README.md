# sigw

Org の3人で LLM のクレジットを分け合うためのゲートウェイです。誰かが OpenAI・Anthropic・xAI・OpenRouter・TypeSafe で買ったキーを sigw に登録すると、ほかのメンバーも sigw を通してそのキーを使えます。sigw は呼び出しごとに「誰が、何の目的で、誰のキーを使ったか」を記録し、毎月1日に、使った分を [Daichoo](https://github.com/4rtofl/Daichoo) の台帳に書き込みます。支払いの一覧は、Daichoo がいつもどおり Discord に送ります。

設計の詳細は [docs/design.md](docs/design.md) にあります。

| ドメイン                 | 使い道                                  |
| ------------------------ | --------------------------------------- |
| `portal.sigw.4rtofl.org` | Web UI と、CLI の接続先                 |
| `si.sigw.4rtofl.org`     | LLM の呼び出し(クライアントの base URL) |
| `cli.sigw.4rtofl.org`    | CLI のインストールスクリプト            |

## 使い方

### 1. 個人トークンを発行する

Web UI に Discord でログインし、「設定」で個人トークン(`sgu_…`)を発行します。トークンは発行したときに一度だけ表示されます。なくしたら発行し直してください。

### 2. キーを用意する

- **クレジットを買った人**: 「キー」でプロバイダキーを登録します。登録したキーは、末尾4文字しか表示されません
- **使う人**: 「キー」で、目的ごとに sigw キー(`sgk_…`)を発行します。使えるモデル、月の上限額(3人と全プロバイダの合計)、有効期限を決められます。sigw キーは3人とも使えます
- 1つの sigw キーに、プロバイダごとに1つずつプロバイダキーを結び付けられます。たとえば Anthropic と OpenRouter のキーを結び付けると、同じ sigw キーで両方を呼べます。発行したあとでも、キーの詳細の画面か CLI で、プロバイダキーを足したり外したりできます
- プロバイダキーを無効にすると、それが結び付いた sigw キーでは、そのプロバイダだけを呼べなくなります

### 3. クライアントに設定する

API キーには、sigw キーと個人トークンを `.` でつないだ文字列を入れます。

```sh
# Claude Code
export ANTHROPIC_BASE_URL=https://si.sigw.4rtofl.org/anthropic
export ANTHROPIC_API_KEY=sgk_xxxx.sgu_yyyy

# OpenAI の SDK
export OPENAI_BASE_URL=https://si.sigw.4rtofl.org/openai/v1
export OPENAI_API_KEY=sgk_xxxx.sgu_yyyy
```

| プロバイダ | base URL                                       |
| ---------- | ---------------------------------------------- |
| OpenAI     | `https://si.sigw.4rtofl.org/openai/v1`         |
| Anthropic  | `https://si.sigw.4rtofl.org/anthropic`         |
| xAI        | `https://si.sigw.4rtofl.org/xai/v1`            |
| OpenRouter | `https://si.sigw.4rtofl.org/openrouter/api/v1` |
| TypeSafe   | `https://si.sigw.4rtofl.org/typesafe/v1`       |

- 各プロバイダの API をそのまま中継するので、SDK もプロバイダ固有の機能も、そのまま使えます
- バッチ API と Realtime API は、使用量を記録できないので使えません
- Anthropic の Managed Agents(`/v1/sessions` など)も使えます。料金はセッションの中で発生するので、sigw が5分ごとにセッションの使用量を読んで記録します。トークンの料金に加えて、実行時間に1時間あたり $0.08 がかかります

### Bobert から使う

[Bobert](https://github.com/4rtofl/Bobert) は、Service Binding(`entrypoint: "BobertGateway"`)で sigw を呼びます。sigw キー(`sgk_…`)と、利用者の Discord ID(`x-sigw-user`)を渡すので、個人トークンは要りません。呼び出しの一覧には「Bobert」の印が付きます。

プロバイダキーを登録するときに「代理専用」にすると、そのプロバイダキーを使う呼び出しは Bobert からしかできなくなります。同じ sigw キーでも、ほかのプロバイダは、今までどおり個人トークンを付けて呼べます。Bobert のエージェントが、利用者の GitHub のトークンを置くワークスペースのキーは、代理専用にしてください。Bobert は `GET /sigw/key` で、登録する sigw キーで呼べるプロバイダと、キーの末尾4文字を確かめます。詳しくは [docs/design.md](docs/design.md) の「4.5」にあります。

### 4. 精算

毎月1日の0時5分(日本時間)に、前の月の分を「使った人 → キーの持ち主」ごとに合計し、円にして Daichoo の台帳(`ledger/YYYY-MM.tsv`)に書き込みます。自分のキーを自分で使った分は請求しません。為替レートは、そのときの USD/JPY を取得し、台帳の memo に残します。

- 「精算」で、前の月のプレビューを見たり、為替レートを手で決めたり、手で精算したりできます
- 料金が不明な呼び出し(単価表にないモデル)は精算に入りません。「価格」で単価を足すと、料金を計算し直します
- TypeSafe の単価は LiteLLM の価格表にないので、毎日の同期では入りません。Jev(`jev`)の単価(2026-11-04 時点で、入力は100万トークンあたり $0.042、出力は無料)は最初から入れてあります。単価が変わったら「価格」で直してください

### CLI

```sh
# macOS と Linux
curl -fsSL https://cli.sigw.4rtofl.org/install.sh | sh
# Windows(PowerShell)
irm https://cli.sigw.4rtofl.org/install.ps1 | iex

sigw auth login          # ブラウザが開くので、Discord でログインして「許可」を押す
sigw keys
sigw usage --by model
sigw settle preview
sigw update              # 最新の版にする
sigw --help
```

- `~/.local/bin/sigw` に入ります。場所は `SIGW_INSTALL_DIR` で変えられます
- ブラウザがない環境では、Web UI の「設定」で発行した CLI トークンを `sigw auth login --with-token` で入れます。CI などでは、環境変数 `SIGW_URL` と `SIGW_TOKEN` でも指定できます

## デプロイ

用意するもの:

- Cloudflare のアカウント(Workers Paid)と D1 のデータベース `sigw`(`pnpm exec wrangler d1 create sigw --location apac`)
- sigw 専用の Discord アプリ。OAuth2 の Redirects に `https://portal.sigw.4rtofl.org/auth/callback`、`https://sigw.4rna-y.workers.dev/auth/callback`、`http://localhost:8787/auth/callback` を入れる
- Daichoo の台帳にコミットする GitHub App の秘密鍵(Daichoo の App をそのまま使う)
- プロバイダキーを暗号化する鍵(`openssl rand -base64 32`)。なくすと、登録したプロバイダキーを読めなくなる

手順:

1. `pnpm install`
2. `wrangler.jsonc` の `vars`(`DISCORD_CLIENT_ID`、`ALLOWED_DISCORD_IDS` など)と、D1 の `database_id` を確かめる
3. `.dev.vars.example` を `.dev.vars` にコピーして、シークレットを入れる
4. 初めてのときは `pnpm exec wrangler deploy` で Worker を作ってから、`pnpm exec wrangler secret bulk .dev.vars` でシークレットを入れる
5. `pnpm run deploy`(UI のビルド、D1 のマイグレーション、デプロイ)
6. Web UI の「価格」で「LiteLLM から同期」を押す(以後は毎日0時5分に自動で同期する)

## 開発

```sh
pnpm install
pnpm migrate:local   # 手元の D1 にスキーマを作る
pnpm build && pnpm dev   # http://localhost:8787
pnpm dev:ui          # UI だけを Vite で動かす(http://localhost:5173。API は :8787 に渡す)
pnpm test
pnpm lint
pnpm typecheck
```

- `src/`: Worker(中継、JSON API、ログイン、Cron)
- `ui/`: Web UI(React、Vite、[easyui](https://easyui.site))
- `cli/`: CLI と、そのインストールスクリプト。開発中は `pnpm cli <コマンド>` で、Node.js 24 でビルドせずに動く
- CLI のリリース: `git tag cli-v0.1.0 && git push origin cli-v0.1.0` で、GitHub Actions がバイナリを作って GitHub Releases に置く
- `migrations/`: D1 のスキーマ
- 偽のプロバイダで中継を試すときは、`wrangler dev --var 'UPSTREAM_OVERRIDE:{"openai":"http://127.0.0.1:9999"}'` のように転送先を差し替える
- `src/github/` は Daichoo(MPL-2.0)から、`ui/src/components/ui/` などは easyui(MIT)から持ってきたもの
