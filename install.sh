#!/bin/sh
# Installs Tangent: downloads the release binary for this Mac, checks its checksum,
# and puts it in ~/.local/bin as `tangent`.
#
#   curl -fsSL https://raw.githubusercontent.com/trounceabout/tangent-tui/main/install.sh | sh
#
# Optional settings (environment variables):
#   TANGENT_VERSION      a release tag such as v0.1.0 (default: the latest release)
#   TANGENT_INSTALL_DIR  where to put the command (default: ~/.local/bin)
#   TANGENT_BASE_URL     download from here instead of GitHub (for tests and mirrors)
#
# The app used to be called Terminal Velocity, so the old TERMINAL_VELOCITY_VERSION,
# TERMINAL_VELOCITY_INSTALL_DIR and TERMINAL_VELOCITY_BASE_URL names still work too.
#
# What it does NOT do: use sudo, touch your shell config, or change anything outside the
# install directory and a temporary folder it deletes afterwards.
#
# The checksum protects against a damaged or cut-short download. It comes from the same release
# as the binary, so it is not proof the release itself is genuine; for that, see the
# build-provenance check in the README.

set -eu

REPO="trounceabout/tangent-tui"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

# Everything happens inside main, and main is only called on the very last line. If the
# download is cut off halfway, the shell hits a syntax error while reading the function and
# runs nothing at all. (Without this, a partial script would run its first half.)
main() {
  [ "$(uname -s)" = "Darwin" ] || die "Tangent only runs on macOS for now (Linux support is tracked in issue #7). This system is: $(uname -s)"

  # Which build? A shell running under Rosetta reports x86_64 even on an Apple Silicon Mac,
  # so ask macOS whether we are being translated.
  arch="$(uname -m)"
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then arch="arm64"; fi
  case "$arch" in
    arm64) target="darwin-arm64" ;;
    x86_64) target="darwin-x64" ;;
    *) die "unsupported processor: $arch" ;;
  esac
  name="tangent-$target"

  # Which release? The version ends up in a URL, so only accept a plain tag.
  version="${TANGENT_VERSION:-${TERMINAL_VELOCITY_VERSION:-latest}}"
  case "$version" in
    latest) release_path="latest/download" ;;
    v[0-9]*)
      case "$version" in
        *[!0-9A-Za-z.-]*) die "TANGENT_VERSION (or TERMINAL_VELOCITY_VERSION) must look like v1.2.3, not: $version" ;;
      esac
      release_path="download/$version"
      ;;
    *) die "TANGENT_VERSION (or TERMINAL_VELOCITY_VERSION) must be 'latest' or look like v1.2.3, not: $version" ;;
  esac

  # Downloads must be https, unless someone points BASE_URL somewhere on purpose.
  custom_base="${TANGENT_BASE_URL:-${TERMINAL_VELOCITY_BASE_URL:-}}"
  if [ -n "$custom_base" ]; then
    base_url="$custom_base"
    protocols="=http,https"
  else
    base_url="https://github.com/$REPO/releases/$release_path"
    protocols="=https"
  fi
  install_dir="${TANGENT_INSTALL_DIR:-${TERMINAL_VELOCITY_INSTALL_DIR:-$HOME/.local/bin}}"

  # An explicit template, because macOS's bare `mktemp -d` ignores TMPDIR.
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/tangent.XXXXXX")"
  # `staged` is the half-installed file in the install folder (set below). It must exist
  # before the trap does, and the trap removes it too, so a failure can't leave it behind.
  staged=""
  trap 'rm -rf "$tmp"; [ -z "$staged" ] || rm -f "$staged"' EXIT

  say "Downloading $name ($version)..."
  for file in "$name" SHA256SUMS; do
    # --proto only limits the FIRST request; redirects (GitHub downloads redirect) are limited by
    # --proto-redir, which by default also allows plain http. Give both the same rule.
    curl -fsSL --proto "$protocols" --proto-redir "$protocols" -o "$tmp/$file" "$base_url/$file" \
      || die "could not download $base_url/$file"
  done

  # Check the download against the release's checksum list. A missing entry is a failure too.
  expected="$(awk -v n="$name" '$2 == n' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for $name"
  printf '%s\n' "$expected" | (cd "$tmp" && shasum -a 256 -c - >/dev/null 2>&1) \
    || die "checksum does not match for $name. Nothing was installed."

  # Install. Stage the file next to its final home, check that it really runs, then rename it
  # into place, so a running copy is never half-replaced and a broken download never replaces a
  # working install. The checksum only shows the file arrived intact; running it is the only
  # check that macOS will actually start it (a bad signature or wrong build gets it killed).
  # This is its own statement on purpose: a failing $(...) inside another command's arguments
  # does not stop `set -e`.
  mkdir -p "$install_dir"
  staged="$install_dir/.tangent.$$"
  cp "$tmp/$name" "$staged"
  chmod 755 "$staged"
  version_out="$("$staged" --version)" || version_out=""
  [ -n "$version_out" ] || die "the downloaded binary does not run on this Mac. Nothing was installed."
  mv -f "$staged" "$install_dir/tangent"
  staged=""

  say "Installed $version_out to $install_dir/tangent"
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) say "$install_dir is not on your PATH. Add this to your shell config:  export PATH=\"$install_dir:\$PATH\"" ;;
  esac
}

main "$@"
