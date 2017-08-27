{
    'targets': [
        {
            'target_name': 'pty',
            'sources': ['src/pty.cpp'],
            'include_dirs' : ['<!(node -e "require(\'nan\')")'],
            'libraries': ['-lutil'],
            'cflags': ['-std=c++11'],
            'conditions': [
                ['OS=="solaris"', {
                    'libraries!': ['-lutil'],
                }],
            ],
        }
    ],
}
