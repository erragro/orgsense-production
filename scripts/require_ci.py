"""Fail deployment unless GitHub Actions passed on this exact source commit."""
import json
import os
import re
from urllib.request import Request, urlopen

REQUIRED = {
    'Backend tests and coverage', 'PostgreSQL migrations and controls',
    'Frontend typecheck and build', 'Backend — pip-audit (Python CVE scan)',
    'Frontend — npm audit (Node.js CVE scan)', 'Secret Detection — detect hardcoded credentials',
}


def validate(runs, sha):
    latest = {}
    for run in runs:
        if run.get('head_sha') == sha and run.get('app', {}).get('slug') == 'github-actions':
            name = run['name']
            if run['id'] > latest.get(name, {}).get('id', -1):
                latest[name] = run
    missing = sorted(name for name in REQUIRED if latest.get(name, {}).get('conclusion') != 'success')
    if missing:
        raise RuntimeError('Required CI checks have not passed: ' + ', '.join(missing))


if __name__ == '__main__':
    repo, sha = os.environ.get('GITHUB_REPOSITORY', ''), os.environ.get('RELEASE_SHA', '')
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo) or not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise SystemExit('Configure GITHUB_REPOSITORY and a full RELEASE_SHA; deployment is blocked')
    headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    if os.environ.get('GITHUB_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_TOKEN']
    runs = []
    for page in range(1, 11):
        url = f'https://api.github.com/repos/{repo}/commits/{sha}/check-runs?per_page=100&page={page}'
        with urlopen(Request(url, headers=headers), timeout=20) as response:
            batch = json.load(response)['check_runs']
        runs.extend(batch)
        if len(batch) < 100:
            break
    validate(runs, sha)
    print('All required CI checks passed for the release commit')
