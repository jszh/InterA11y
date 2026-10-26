import os
import tempfile
import threading

class ThreadLocalTempFolders(os.PathLike):

    def __init__(self, root):
        self.root = os.fspath(root)
        self._local = threading.local()

    def __fspath__(self):
        return getattr(self._local, 'active', self.root)

    def run(self, prefix, callback):
        with tempfile.TemporaryDirectory(prefix=prefix, dir=self.root, ignore_cleanup_errors=True) as page_tmp:
            previous = getattr(self._local, 'active', None)
            self._local.active = page_tmp
            try:
                return callback()
            finally:
                if previous is None:
                    del self._local.active
                else:
                    self._local.active = previous
