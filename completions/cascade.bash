#!/usr/bin/env bash
# Cascade AI — Bash completions
# Install: source <(cascade completions bash)

_cascade_completions() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local commands="init doctor update dashboard run --help --version"
  local flags="--prompt --theme --workspace --no-color"
  local themes="cascade dark light dracula nord solarized"

  if [[ "${COMP_WORDS[COMP_CWORD-1]}" == "--theme" ]]; then
    COMPREPLY=($(compgen -W "$themes" -- "$cur"))
    return
  fi

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$commands" -- "$cur"))
  fi
}

complete -F _cascade_completions cascade
