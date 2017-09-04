{
    'targets': [
        {
            'target_name': 'pty',
            'sources': ['src/pty.cpp'],
            'include_dirs' : ['<!(node -e "require(\'nan\')")'],
            'cflags': ['-std=c++11'],
            'conditions': [
                ['OS=="mac"', {
                    'xcode_settings': {
                        'OTHER_CPLUSPLUSFLAGS' : ['-std=c++11', '-stdlib=libc++'],
                        'OTHER_LDFLAGS': ['-stdlib=libc++'],
                        'MACOSX_DEPLOYMENT_TARGET': '10.7'
                    },
                }],
            ],
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
        },
    ],
}
