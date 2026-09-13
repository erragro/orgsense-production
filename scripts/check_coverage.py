"""Reject coverage loss and require any improvement to update the checked-in floor."""
import json
import os
from pathlib import Path
import subprocess
import sys

floor_file = 'kirana_kart/coverage-floor.json'
floor = json.loads(Path(floor_file).read_text())['line_percent']
actual = int(json.loads(Path(sys.argv[1]).read_text())['totals']['percent_covered'] * 100) / 100
base = os.environ.get('BASE_REF', '')
if base and set(base) != {'0'}:
    result = subprocess.run(['git','show',f'{base}:{floor_file}'], capture_output=True, text=True)
    if result.returncode == 0:
        previous = json.loads(result.stdout)['line_percent']
        if floor < previous:
            raise SystemExit(f'Coverage floor cannot fall: {previous:.2f}% -> {floor:.2f}%')
print(f'Coverage: {actual:.2f}%; floor: {floor:.2f}%; delta: {actual-floor:+.2f} points')
if actual < floor:
    raise SystemExit('Coverage regressed. Add tests for the changed behavior.')
if actual > floor:
    raise SystemExit(f'Raise {floor_file} line_percent to {actual:.2f} to preserve the improvement.')
