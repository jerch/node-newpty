{
    'targets': [
        {
            'target_name': 'pty',
            'sources': ['src/pty.cpp'],
            'include_dirs' : ['<!(node -e "require(\'nan\')")'],
            'cflags': ['-std=c++11'],
        },
        {
            'target_name': 'helper',
            'type': 'executable',
            'sources': ['src/helper.cpp']
        },
        {
            'target_name': 'stderr_tester',
            'type': 'executable',
            'sources': ['src/stderr_tester.cpp']
        }
    ],
}
