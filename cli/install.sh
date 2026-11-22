#!/bin/sh
# sigw の CLI を入れる(macOS と Linux)。
#   curl -fsSL __SIGW_CLI_ORIGIN__/install.sh | sh
# 版を決めるとき:          curl -fsSL … | SIGW_VERSION=0.1.0 sh
# 入れる場所を変えるとき:  curl -fsSL … | SIGW_INSTALL_DIR=/usr/local/bin sh
# cli.sigw.4rtofl.org の Worker(src/web/cli-dist.ts)が __…__ を埋めてから返す。

set -eu

REPOSITORY="__SIGW_RELEASE_REPOSITORY__"
CLI_ORIGIN="__SIGW_CLI_ORIGIN__"
INSTALL_DIR="${SIGW_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "エラー: $*"; exit 1; }

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 3 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		fail "curl か wget が必要です"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		fail "sha256sum か shasum が必要です"
	fi
}

detect_asset() {
	os=$(uname -s)
	arch=$(uname -m)
	case "$arch" in
		x86_64 | amd64) arch=x64 ;;
		arm64 | aarch64) arch=arm64 ;;
		*) fail "この CPU($arch)用の sigw はありません" ;;
	esac
	case "$os" in
		Darwin)
			# Rosetta 2 の上の端末でも、Apple シリコン用を入れる
			if [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
				arch=arm64
			fi
			echo "sigw-darwin-$arch"
			;;
		Linux)
			# Alpine など、glibc ではなく musl の環境
			if ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
				echo "sigw-linux-$arch-musl"
			else
				echo "sigw-linux-$arch"
			fi
			;;
		MINGW* | MSYS* | CYGWIN*)
			fail "Windows では PowerShell で「irm $CLI_ORIGIN/install.ps1 | iex」を実行してください"
			;;
		*) fail "この OS($os)用の sigw はありません" ;;
	esac
}

main() {
	asset=$(detect_asset)
	version="${SIGW_VERSION:-}"
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT INT TERM

	if [ -z "$version" ]; then
		download "$CLI_ORIGIN/latest" "$tmp/latest"
		version=$(tr -d '[:space:]' <"$tmp/latest")
	fi
	[ -n "$version" ] || fail "最新の版がわかりません"

	base="https://github.com/$REPOSITORY/releases/download/cli-v$version"
	say "sigw $version($asset)をダウンロードしています…"
	download "$base/$asset" "$tmp/sigw"
	download "$base/SHA256SUMS" "$tmp/SHA256SUMS"

	expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
	[ -n "$expected" ] || fail "SHA256SUMS に $asset がありません"
	actual=$(sha256 "$tmp/sigw")
	[ "$expected" = "$actual" ] || fail "ダウンロードしたファイルのハッシュが合いません(期待 $expected、実際 $actual)"

	chmod 755 "$tmp/sigw"
	mkdir -p "$INSTALL_DIR"
	# 動いている sigw を上書きしても壊れないよう、同じディレクトリに置いてから名前を変える
	mv "$tmp/sigw" "$INSTALL_DIR/.sigw.new"
	mv "$INSTALL_DIR/.sigw.new" "$INSTALL_DIR/sigw"

	say "sigw $version を $INSTALL_DIR/sigw に入れました。"
	case ":$PATH:" in
		*":$INSTALL_DIR:"*) ;;
		*)
			say ""
			say "$INSTALL_DIR が PATH にありません。シェルの設定ファイル(~/.zshrc、~/.bashrc など)に次の行を足してください:"
			say "  export PATH=\"$INSTALL_DIR:\$PATH\""
			;;
	esac
	say ""
	say "次に「sigw auth login」でログインしてください。"
}

main "$@"
