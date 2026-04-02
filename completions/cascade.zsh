#compdef cascade
# Cascade AI — Zsh completions
# Install: fpath=(~/.config/cascade/completions $fpath)

_cascade() {
  local context state state_descr line
  typeset -A opt_args

  _arguments \
    '(-v --version)'{-v,--version}'[Show version]' \
    '(-h --help)'{-h,--help}'[Show help]' \
    '(-p --prompt)'{-p,--prompt}'[Single prompt]:prompt:' \
    '(-t --theme)'{-t,--theme}'[Color theme]:theme:(cascade dark light dracula nord solarized)' \
    '(-w --workspace)'{-w,--workspace}'[Workspace path]:path:_files -/' \
    '1:command:->command' \
    '*::args:->args'

  case $state in
    command)
      local commands=(
        'init:Initialize Cascade in a project directory'
        'doctor:Check system configuration'
        'update:Update to the latest version'
        'dashboard:Launch the web dashboard'
        'run:Run a single prompt and exit'
      )
      _describe 'cascade commands' commands
      ;;
  esac
}

_cascade "$@"
