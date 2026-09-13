"""Render reviewable deployment YAML using explicit immutable release digests."""
import argparse
from pathlib import Path
import re
import yaml


def render(images):
    for name, image in images.items():
        if not re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', image):
            raise ValueError(f'{name} must be an image repository@sha256:digest')
    documents = []
    for path in sorted((Path(__file__).resolve().parents[1] / 'k8s').glob('*.yaml')):
        for doc in yaml.safe_load_all(path.read_text()):
            if not doc:
                continue
            if doc.get('kind') in ('Deployment', 'Job'):
                for container in doc['spec']['template']['spec']['containers']:
                    image = container['image']
                    if image.endswith(':RELEASE_REQUIRED'):
                        name = image.rsplit('/', 1)[-1].split(':')[0]
                        container['image'] = images[name]
            documents.append(doc)
    return yaml.safe_dump_all(documents, sort_keys=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('governance', 'ingest', 'ui'):
        parser.add_argument(f'--{name}', required=True)
    args = parser.parse_args()
    print(render(vars(args)), end='')
