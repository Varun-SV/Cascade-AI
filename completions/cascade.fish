# Cascade AI — Fish completions
# Install: cp cascade.fish ~/.config/fish/completions/

# Disable file completions
complete -c cascade -f

# Commands
complete -c cascade -n '__fish_use_subcommand' -a init      -d 'Initialize Cascade in a project'
complete -c cascade -n '__fish_use_subcommand' -a doctor    -d 'Check system configuration'
complete -c cascade -n '__fish_use_subcommand' -a update    -d 'Update to latest version'
complete -c cascade -n '__fish_use_subcommand' -a dashboard -d 'Launch the web dashboard'
complete -c cascade -n '__fish_use_subcommand' -a run       -d 'Run a single prompt and exit'

# Flags
complete -c cascade -l prompt    -s p -d 'Single prompt' -r
complete -c cascade -l theme     -s t -d 'Color theme'   -r -a 'cascade dark light dracula nord solarized'
complete -c cascade -l workspace -s w -d 'Workspace path' -r -F
complete -c cascade -l version   -s v -d 'Show version'
complete -c cascade -l help      -s h -d 'Show help'
complete -c cascade -l no-color        -d 'Disable colors'
