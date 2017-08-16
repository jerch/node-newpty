{
    'targets': [
        {
            'target_name': 'pty',
            'sources': ['src/pty.cpp'],
            'include_dirs' : ['<!(node -e "require(\'nan\')")', 'node_modules/node-termios/src'],
            'libraries': ['-lutil']
        }
    ],
}
