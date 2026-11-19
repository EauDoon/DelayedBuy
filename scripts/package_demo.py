"""Build the portable demo or copy public assets to an empty Pages staging directory.

The standalone targets this repository's named ES module imports and function exports.
It rejects unrecognized imports/exports rather than emitting a partial app.
"""
import argparse
import base64
import hashlib
import mimetypes
from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parents[1]
STATIC = [ROOT / 'index.html', ROOT / '.nojekyll', *sorted((ROOT / 'core').glob('*.mjs')),
          *sorted(p for p in (ROOT / 'ui').rglob('*') if p.is_file())]
IMPORT = re.compile(r"^import\s*\{([\w,\s]+)\}\s*from\s*['\"]([^'\"]+)['\"];?", re.M)
EXPORT = re.compile(r'^export (?:async )?function (\w+)\(', re.M)


def embed_assets(text):
    for asset in sorted((ROOT / 'ui/assets').glob('*')):
        if not asset.is_file():
            continue
        uri = './' + asset.relative_to(ROOT).as_posix()
        mime = mimetypes.guess_type(asset.name)[0]
        if not mime:
            raise ValueError(f'Unknown content type for {asset.name}')
        data = 'data:' + mime + ';base64,' + base64.b64encode(asset.read_bytes()).decode()
        text = text.replace(uri, data)
    return text


def bundle_javascript():
    """Compile our three closed modules in dependency order, keeping their scopes separate."""
    emitted = {}
    chunks = []
    active = set()

    def emit(path):
        path = path.resolve()
        if path in emitted:
            return emitted[path]
        if path in active or path not in STATIC:
            raise ValueError(f'Unexpected module dependency: {path.name}')
        active.add(path)
        source = path.read_text()

        def binding(match):
            target = emit(path.parent / match[2])
            names = [name.strip() for name in match[1].split(',') if name.strip()]
            if any(not name.isidentifier() for name in names):
                raise ValueError(f'Unsupported binding in {path.name}')
            return 'const { ' + ', '.join(names) + ' } = ' + target + ';'

        source = IMPORT.sub(binding, source)
        public = EXPORT.findall(source)
        source = re.sub(r'^export (?=(?:async )?function )', '', source, flags=re.M)
        if re.search(r'^\s*(?:import|export)\b', source, re.M):
            raise ValueError(f'Unsupported module declaration in {path.name}')
        label = 'demoModule' + str(len(emitted))
        chunks.append('const ' + label + ' = (() => {\n' + source +
                      '\nreturn { ' + ', '.join(public) + ' };\n})();')
        emitted[path] = label
        active.remove(path)
        return label

    emit(ROOT / 'ui/app.js')
    script = '(() => {\n"use strict";\n' + '\n'.join(chunks) + '\n})();'
    return embed_assets(script).replace('</script', r'<\/script')


def standalone(output):
    html = (ROOT / 'index.html').read_text()
    css = embed_assets((ROOT / 'ui/style.css').read_text())
    script = bundle_javascript()
    html, count = re.subn(r'<link rel="stylesheet" href="\./ui/style.css">', lambda _: '<style>\n' + css + '\n</style>', html)
    if count != 1:
        raise ValueError('Stylesheet entry changed')
    html, count = re.subn('<script type="module" src="\\./ui/app.js"></script>', '', html)
    if count != 1:
        raise ValueError('Module entry changed')
    html = re.sub(r'\s*<meta http-equiv="Content-Security-Policy"[^>]*>', '', html, flags=re.I)
    html = embed_assets(html)
    checksum = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    policy = "default-src 'none'; script-src 'sha256-" + checksum + "'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="' + policy + '">')
    html = html.replace('</body>', '<script>' + script + '</script>\n</body>')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html)


def pages(destination):
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Use an empty staging directory to avoid mixing release files')
    for path in STATIC:
        target = destination / path.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--standalone', type=Path, help='output HTML path, usable from disk')
    parser.add_argument('--pages', type=Path, help='new or empty directory for static hosting')
    args = parser.parse_args()
    if not (args.standalone or args.pages):
        parser.error('choose --standalone, --pages, or both')
    if args.standalone:
        standalone(args.standalone)
    if args.pages:
        pages(args.pages)
