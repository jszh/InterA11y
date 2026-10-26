"""Import local Expert pages and their resource directories."""
from pathlib import Path
import shutil
from .analysis import read_csv

ROOT = Path(__file__).resolve().parents[1]


def import_expert(source):
    source = Path(source).resolve()
    copied = []
    for row in read_csv(ROOT/'datasets/expert/pages.csv'):
        relative = Path(row['page'])
        candidates = [source/relative, source/relative.name]
        found = next((p for p in candidates if p.is_file()), None)
        if not found:
            raise FileNotFoundError('Missing saved page: '+relative.name)
        target = ROOT/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if found.resolve() != target.resolve():
            shutil.copy2(found, target)
        for asset in [found.with_name(found.stem+'_files'), found.with_suffix('')]:
            if asset.is_dir():
                shutil.copytree(asset, target.with_name(asset.name), dirs_exist_ok=True)
        copied.append(relative.name)
    return dict(imported=len(copied))
