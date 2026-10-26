#!/usr/bin/env python3
import os
import sys
chrome = os.environ['A11Y_NATIVE_CHROME_PATH']
os.execv(chrome, [chrome, '--remote-debugging-port=0', *sys.argv[1:]])
